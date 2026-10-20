import Foundation
import Network
import os

public struct EngineResult: Sendable {
    public let duration: Double
    public let words: [TimedWord]
    public let turns: [SpeakerTurn]

    public init(duration: Double, words: [TimedWord], turns: [SpeakerTurn]) {
        self.duration = duration
        self.words = words
        self.turns = turns
    }
}

/// Recognizes and diarizes one file with the installed model, loading it for
/// this job and releasing it before returning.
public protocol TranscriptionEngine: Sendable {
    func transcribe(audio: URL, installed: URL) async throws -> EngineResult
}

public struct ServerConfiguration: Sendable {
    public let token: String
    public let store: ModelStore
    public let engine: any TranscriptionEngine
    public let maxFileBytes: Int64
    /// A connection that sends nothing for this long is closed.
    public let idleTimeout: Duration
    /// Further connections are closed at once. Queued requests hold one each.
    public let maxConnections: Int

    public init(
        token: String, store: ModelStore, engine: any TranscriptionEngine,
        maxFileBytes: Int64 = 64 << 20, idleTimeout: Duration = .seconds(120), maxConnections: Int = 16
    ) {
        self.token = token
        self.store = store
        self.engine = engine
        self.maxFileBytes = maxFileBytes
        self.idleTimeout = idleTimeout
        self.maxConnections = maxConnections
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[CommaTranscriber] \(message)\n".utf8))
}

/// `serve` (design contract C2): `GET /health` and an OpenAI-style
/// `POST /v1/audio/transcriptions`, on 127.0.0.1 only.
public actor TranscriptionServer {
    let configuration: ServerConfiguration
    let queue = TranscriptionQueue()
    private var listener: NWListener?
    private var connections = 0
    private let dispatchQueue = DispatchQueue(label: "CommaTranscriber.server")

    public init(configuration: ServerConfiguration) {
        self.configuration = configuration
    }

    /// Listens on `127.0.0.1:<port>` (0 picks a free port) and returns the port.
    /// `onFailure` runs if the listener fails later.
    public func start(port: UInt16, onFailure: @escaping @Sendable (any Error) -> Void = { _ in }) async throws
        -> UInt16
    {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(
            host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port) ?? .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else {
                connection.cancel()
                return
            }
            Task { await self.accept(connection) }
        }
        let settled = OSAllocatedUnfairLock(initialState: false)
        let settle: @Sendable () -> Bool = { settled.withLock { done in defer { done = true }; return !done } }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if settle() { continuation.resume() }
                case .failed(let error):
                    if settle() { continuation.resume(throwing: error) } else { onFailure(error) }
                case .cancelled:
                    if settle() { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            listener.start(queue: dispatchQueue)
        }
        self.listener = listener
        guard let bound = listener.port?.rawValue else {
            throw POSIXError(.EADDRNOTAVAIL)
        }
        return bound
    }

    public func stop() {
        listener?.cancel()
        listener = nil
    }

    private func accept(_ connection: NWConnection) async {
        guard connections < configuration.maxConnections else {
            connection.cancel()
            return
        }
        connections += 1
        let exchange = Exchange(
            connection: Connection(connection, queue: dispatchQueue, idleTimeout: configuration.idleTimeout),
            configuration: configuration, queue: queue)
        await exchange.run()
        connections -= 1
    }
}

/// One request and its response on one connection.
private struct Exchange {
    let connection: Connection
    let configuration: ServerConfiguration
    let queue: TranscriptionQueue

    private struct NotInstalled: Error {}
    private struct TooLarge: Error {}
    private struct BadRequest: Error {
        let message: String
    }

    func run() async {
        defer { connection.cancel() }
        do {
            var buffer = Data()
            var head: HTTPRequestHead?
            while head == nil {
                if let end = buffer.range(of: HTTPRequestHead.terminator) {
                    guard let parsed = HTTPRequestHead(buffer[..<end.lowerBound]) else {
                        try await respond(.error(400, "bad_request", "The request line or headers are invalid."))
                        return
                    }
                    head = parsed
                    buffer = Data(buffer[end.upperBound...])
                } else {
                    guard buffer.count <= 32 * 1024 else {
                        try await respond(.error(400, "bad_request", "The headers are too large."))
                        return
                    }
                    guard let chunk = try await connection.receive() else { return }
                    buffer.append(chunk)
                }
            }
            guard let head else { return }
            let started = ContinuousClock.now
            let response = await route(head, received: buffer)
            log("\(head.method) \(head.path) \(response.status) \(ContinuousClock.now - started)")
            try await respond(response)
        } catch {
            return
        }
    }

    /// Sends the response, closes the write side and discards what the client
    /// still sends, so it can read the response before the connection closes.
    private func respond(_ response: HTTPResponse) async throws {
        try await connection.send(response.serialized, final: true)
        await connection.drain(limit: 128 << 20, timeout: .seconds(2))
    }

    private func route(_ head: HTTPRequestHead, received: Data) async -> HTTPResponse {
        switch (head.method, head.path) {
        case ("GET", "/health"):
            return .json(200, [
                "status": "ok", "busy": await queue.isBusy,
                "model": configuration.store.isInstalled ? "ready" : "not_installed",
            ])
        case ("POST", "/v1/audio/transcriptions"):
            return await transcribe(head, received: received)
        case (_, "/health"), (_, "/v1/audio/transcriptions"):
            return .error(405, "method_not_allowed")
        default:
            return .error(404, "not_found")
        }
    }

    private func transcribe(_ head: HTTPRequestHead, received: Data) async -> HTTPResponse {
        guard let token = head.bearerToken, constantTimeEqual(token, configuration.token) else {
            return .error(401, "unauthorized")
        }
        let maxBody = configuration.maxFileBytes + (1 << 20)  // room for the other parts
        let chunked = head.headers["transfer-encoding"]?.lowercased().contains("chunked") == true
        let length = head.headers["content-length"].flatMap { Int64($0) }
        if let length, length > maxBody {
            return .error(413, "file_too_large")
        }
        guard chunked || length != nil else {
            return .error(400, "bad_request", "Send a Content-Length or a chunked body.")
        }
        guard configuration.store.isInstalled else { return notInstalled }
        guard let boundary = MultipartForm.boundary(contentType: head.headers["content-type"]) else {
            return .error(400, "bad_request", "The body must be multipart/form-data.")
        }

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("comma-transcriber-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            if head.headers["expect"]?.lowercased() == "100-continue" {
                try await connection.send(Data("HTTP/1.1 100 Continue\r\n\r\n".utf8), final: false)
            }
            let bodyURL = directory.appendingPathComponent("body")
            try await readBody(
                into: bodyURL, received: received, length: length, chunked: chunked, limit: maxBody)
            let (audioURL, format) = try extractAudio(from: bodyURL, boundary: boundary, into: directory)
            try? FileManager.default.removeItem(at: bodyURL)

            let store = configuration.store
            let engine = configuration.engine
            let result = try await queue.run {
                guard store.isInstalled else { throw NotInstalled() }
                return try await engine.transcribe(audio: audioURL, installed: store.installedURL)
            }
            return Self.render(result, verbose: format == "verbose_json")
        } catch is TooLarge {
            return .error(413, "file_too_large")
        } catch let error as BadRequest {
            return .error(400, "bad_request", error.message)
        } catch is NotInstalled {
            return notInstalled
        } catch {
            log("transcription failed: \(error)")
            return .error(500, "transcription_failed", error.localizedDescription)
        }
    }

    private var notInstalled: HTTPResponse {
        .error(409, "local_asr_model_not_installed", "Local transcription is not installed.")
    }

    private func readBody(into url: URL, received: Data, length: Int64?, chunked: Bool, limit: Int64)
        async throws
    {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        var written: Int64 = 0
        func write(_ data: Data) throws {
            written += Int64(data.count)
            guard written <= limit else { throw TooLarge() }
            try handle.write(contentsOf: data)
        }

        if chunked {
            var decoder = ChunkedDecoder()
            var input = received
            while true {
                do {
                    try write(try decoder.feed(input))
                } catch is ChunkedDecoder.Malformed {
                    throw BadRequest(message: "The chunked body is malformed.")
                }
                if decoder.isDone { return }
                guard let next = try await connection.receive() else {
                    throw BadRequest(message: "The body ended early.")
                }
                input = next
            }
        }

        let length = length ?? 0
        var input = received.prefix(Int(min(Int64(received.count), length)))
        while true {
            try write(input)
            if written >= length { return }
            guard let next = try await connection.receive() else {
                throw BadRequest(message: "The body ended early.")
            }
            input = next.prefix(Int(min(Int64(next.count), length - written)))
        }
    }

    private static let audioExtensions: Set<String> = ["m4a", "mp4", "mp3", "wav", "aac", "caf", "aiff", "flac"]

    private func extractAudio(from bodyURL: URL, boundary: String, into directory: URL) throws -> (URL, String) {
        let body = try Data(contentsOf: bodyURL, options: .alwaysMapped)
        let form: MultipartForm
        do {
            form = try MultipartForm(body: body, boundary: boundary)
        } catch let error as MultipartForm.Malformed {
            throw BadRequest(message: "The multipart body is invalid: \(error.description).")
        }
        guard let file = form.file else { throw BadRequest(message: "The file part is required.") }
        guard Int64(file.range.count) <= configuration.maxFileBytes else { throw TooLarge() }
        let format = form.fields["response_format"] ?? "json"
        guard format == "json" || format == "verbose_json" else {
            throw BadRequest(message: "response_format must be json or verbose_json.")
        }
        // AVFoundation reads the container from the extension too.
        let fileExtension = ((file.filename ?? "") as NSString).pathExtension.lowercased()
        let audioURL = directory.appendingPathComponent(
            "audio.\(Self.audioExtensions.contains(fileExtension) ? fileExtension : "m4a")")
        try body[file.range].write(to: audioURL)
        return (audioURL, format)
    }

    static func render(_ result: EngineResult, verbose: Bool) -> HTTPResponse {
        func rounded(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
        let segments = mergeWordsWithSpeakers(words: result.words, turns: result.turns)
        let text = segments.map(\.text).joined(separator: " ")
        guard verbose else { return .json(200, ["text": text]) }
        return .json(200, [
            "text": text,
            "duration": rounded(result.duration),
            "segments": segments.enumerated().map { index, segment in
                [
                    "id": index, "start": rounded(segment.start), "end": rounded(segment.end),
                    "text": segment.text, "speaker": segment.speaker ?? NSNull(),
                ] as [String: Any]
            },
        ])
    }
}

func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
    let a = Array(lhs.utf8)
    let b = Array(rhs.utf8)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<max(a.count, b.count) {
        difference |= (index < a.count ? a[index] : 0) ^ (index < b.count ? b[index] : 0)
    }
    return difference == 0
}

/// Async reads and writes on an `NWConnection`, closed after `idleTimeout`
/// without incoming data.
private struct Connection: Sendable {
    let connection: NWConnection
    let idleTimeout: Duration

    init(_ connection: NWConnection, queue: DispatchQueue, idleTimeout: Duration) {
        self.connection = connection
        self.idleTimeout = idleTimeout
        connection.start(queue: queue)
    }

    /// The next bytes, or nil at end of stream.
    func receive(timeout: Duration? = nil) async throws -> Data? {
        let timeout = timeout ?? idleTimeout
        let timer = DispatchWorkItem { [connection] in connection.cancel() }
        let (seconds, attoseconds) = timeout.components
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .milliseconds(Int(seconds * 1000 + attoseconds / 1_000_000_000_000_000)),
            execute: timer)
        defer { timer.cancel() }
        return try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
                data, _, isComplete, error in
                if let data, !data.isEmpty {
                    continuation.resume(returning: data)
                } else if let error {
                    continuation.resume(throwing: error)
                } else if isComplete {
                    continuation.resume(returning: nil)
                } else {
                    continuation.resume(returning: Data())
                }
            }
        }
    }

    func send(_ data: Data, final: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            connection.send(
                content: data, contentContext: final ? .finalMessage : .defaultMessage, isComplete: final,
                completion: .contentProcessed { error in
                    if let error { continuation.resume(throwing: error) } else { continuation.resume() }
                })
        }
    }

    func drain(limit: Int, timeout: Duration) async {
        let deadline = ContinuousClock.now + timeout
        var discarded = 0
        while discarded < limit, ContinuousClock.now < deadline {
            guard let data = try? await receive(timeout: timeout), !data.isEmpty else { return }
            discarded += data.count
        }
    }

    func cancel() {
        connection.cancel()
    }
}
