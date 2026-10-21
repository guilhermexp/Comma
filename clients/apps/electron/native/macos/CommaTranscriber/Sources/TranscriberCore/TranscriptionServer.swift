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

/// The local models, each loaded for one job and released before returning.
public protocol TranscriptionEngine: Sendable {
    /// Recognizes `audio` with the installed recognizer and, with `speakers`,
    /// diarizes it with the installed separator.
    func transcribe(audio: URL, installed: URL, speakers: Bool) async throws -> EngineResult
    /// Diarizes `audio` with the installed separator.
    func diarize(audio: URL, installed: URL) async throws -> [SpeakerTurn]
}

public struct ServerConfiguration: Sendable {
    public let token: String
    public let store: ModelStore
    public let engine: any TranscriptionEngine
    public let cloud: any CloudTranscribing
    /// Time for the cloud attempt, leaving room for the local fallback within
    /// the backend's 600 s (D5).
    public let cloudDeadline: Duration
    public let verifyDeadline: Duration
    public let maxFileBytes: Int64
    /// A connection that sends nothing for this long is closed.
    public let idleTimeout: Duration
    /// Further connections are closed at once. Queued requests hold one each.
    public let maxConnections: Int

    public init(
        token: String, store: ModelStore, engine: any TranscriptionEngine,
        cloud: any CloudTranscribing = CloudTranscriber(), cloudDeadline: Duration = .seconds(420),
        verifyDeadline: Duration = .seconds(30), maxFileBytes: Int64 = 64 << 20, idleTimeout: Duration = .seconds(120),
        maxConnections: Int = 16
    ) {
        self.token = token
        self.store = store
        self.engine = engine
        self.cloud = cloud
        self.cloudDeadline = cloudDeadline
        self.verifyDeadline = verifyDeadline
        self.maxFileBytes = maxFileBytes
        self.idleTimeout = idleTimeout
        self.maxConnections = maxConnections
    }
}

private let logObservers = OSAllocatedUnfairLock<[UUID: @Sendable (String) -> Void]>(initialState: [:])

/// Also hands each log line to `observer` until it is removed.
func addLogObserver(_ observer: @escaping @Sendable (String) -> Void) -> UUID {
    let token = UUID()
    logObservers.withLock { $0[token] = observer }
    return token
}

func removeLogObserver(_ token: UUID) {
    logObservers.withLock { _ = $0.removeValue(forKey: token) }
}

/// Writes one line to stderr. Never pass an API key or a request body.
func log(_ message: String) {
    let line = "[CommaTranscriber] \(message)\n"
    FileHandle.standardError.write(Data(line.utf8))
    for observer in logObservers.withLock({ Array($0.values) }) { observer(line) }
}

/// The transcription provider the app selected (D1, C6), held only in
/// memory. Nil until the app sends one: the helper then behaves as before
/// providers existed, with the local model.
public enum ProviderSetting: Sendable, Equatable {
    case local
    case cloud(CloudProvider)

    var kind: ProviderKind {
        switch self {
        case .local: .local
        case .cloud(let provider): provider.kind
        }
    }

    /// The Groq free tier takes 25 MB; 1 MB stays free (D4).
    static let defaultMaxUploadBytes: Int64 = 24_000_000

    /// Parses a C6 body. Cloud providers need `https:`, or `http:` to this Mac.
    static func parse(_ data: Data) -> ProviderSetting? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let kind = (object["kind"] as? String).flatMap(ProviderKind.init(rawValue:))
        else { return nil }
        if kind == .local { return .local }
        let unsafe = CharacterSet.whitespacesAndNewlines.union(.controlCharacters)
        guard let base = object["baseUrl"] as? String, let url = URL(string: base),
            let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(),
            scheme == "https" || (scheme == "http" && ["127.0.0.1", "localhost"].contains(host)),
            let model = object["model"] as? String, !model.isEmpty, model.rangeOfCharacter(from: unsafe) == nil,
            let key = object["apiKey"] as? String, !key.isEmpty, key.rangeOfCharacter(from: unsafe) == nil
        else { return nil }
        var maxUploadBytes = defaultMaxUploadBytes
        if let value = object["maxUploadBytes"] {
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                number.int64Value > 0, number.doubleValue == Double(number.int64Value)
            else { return nil }
            maxUploadBytes = number.int64Value
        }
        return .cloud(
            CloudProvider(kind: kind, baseURL: url, model: model, apiKey: key, maxUploadBytes: maxUploadBytes))
    }
}

actor ProviderStore {
    private(set) var setting: ProviderSetting?
    /// The last cloud failure no local model took over (a 502), until a
    /// cloud job succeeds or the app sends a provider again. The app reads
    /// it from /health for jobs it did not send, such as a meeting Task's.
    private(set) var lastFailure: (provider: ProviderKind, failure: CloudFailure, at: Date)?

    func set(_ setting: ProviderSetting) {
        self.setting = setting
        lastFailure = nil
    }

    func failed(_ provider: ProviderKind, _ failure: CloudFailure) {
        lastFailure = (provider, failure, Date())
    }

    func cloudSucceeded() {
        lastFailure = nil
    }
}

/// `serve` (design contracts C2, C6 and C7): `GET /health`, the provider
/// routes and an OpenAI-style `POST /v1/audio/transcriptions`, on
/// 127.0.0.1 only.
public actor TranscriptionServer {
    let configuration: ServerConfiguration
    let queue = TranscriptionQueue()
    let providers = ProviderStore()
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
            configuration: configuration, queue: queue, providers: providers)
        await exchange.run()
        connections -= 1
    }
}

/// One request and its response on one connection.
private struct Exchange {
    let connection: Connection
    let configuration: ServerConfiguration
    let queue: TranscriptionQueue
    let providers: ProviderStore

    private struct NotInstalled: Error {}
    private struct NotReady: Error {}
    private struct CloudFailed: Error {
        let provider: ProviderKind
        let failure: CloudFailure
    }
    private struct TooLarge: Error {}
    private struct BadRequest: Error {
        let message: String
    }

    /// What a job produced, before rendering (C7).
    private enum Outcome: Sendable {
        case local(EngineResult, fallback: (from: ProviderKind, reason: CloudFailure)?)
        case cloud(CloudProvider, JoinedTranscript, turns: [SpeakerTurn])
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
            let installed = configuration.store.installedComponents
            let setting = await providers.setting
            var provider: [String: Any] = ["kind": (setting?.kind ?? .local).rawValue, "configured": setting != nil]
            if let last = await providers.lastFailure {
                provider["lastFailure"] = [
                    "reason": last.failure.rawValue, "provider": last.provider.rawValue,
                    "at": ISO8601DateFormatter().string(from: last.at),
                ]
            }
            return .json(200, [
                "status": "ok", "busy": await queue.isBusy,
                "model": installed.contains(.asr) ? "ready" : "not_installed",
                "provider": provider,
                "components": ["asr": installed.contains(.asr), "diarization": installed.contains(.diarization)],
            ])
        case ("POST", "/v1/audio/transcriptions"):
            return await transcribe(head, received: received)
        case ("PUT", "/v1/provider"), ("POST", "/v1/provider/verify"):
            guard authorized(head) else { return .error(401, "unauthorized") }
            let setting: ProviderSetting
            do {
                guard let parsed = ProviderSetting.parse(try await readSmallBody(head, received: received)) else {
                    return .error(400, "bad_request", "The provider configuration is invalid.")
                }
                setting = parsed
            } catch let error as BadRequest {
                return .error(400, "bad_request", error.message)
            } catch {
                return .error(400, "bad_request", "The body could not be read.")
            }
            if head.method == "PUT" {
                await providers.set(setting)
                log("provider set to \(setting.kind.rawValue)")
                return HTTPResponse(status: 204, body: Data())
            }
            guard case .cloud(let provider) = setting else {
                return .error(400, "bad_request", "Only a cloud provider can be verified.")
            }
            return await verify(provider)
        case (_, "/health"), (_, "/v1/audio/transcriptions"), (_, "/v1/provider"), (_, "/v1/provider/verify"):
            return .error(405, "method_not_allowed")
        default:
            return .error(404, "not_found")
        }
    }

    private func authorized(_ head: HTTPRequestHead) -> Bool {
        guard let token = head.bearerToken else { return false }
        return constantTimeEqual(token, configuration.token)
    }

    /// A JSON body of at most 64 KiB with a Content-Length.
    private func readSmallBody(_ head: HTTPRequestHead, received: Data) async throws -> Data {
        guard let length = head.headers["content-length"].flatMap(Int.init), (0...(64 << 10)).contains(length) else {
            throw BadRequest(message: "Send a JSON body of at most 64 KiB with a Content-Length.")
        }
        var body = Data(received.prefix(length))
        while body.count < length {
            guard let next = try await connection.receive() else {
                throw BadRequest(message: "The body ended early.")
            }
            body.append(next.prefix(length - body.count))
        }
        return body
    }

    /// Transcribes one second of silence with `provider`, without keeping
    /// it (C6). A 429 comes after the key was accepted.
    private func verify(_ provider: CloudProvider) async -> HTTPResponse {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("comma-transcriber-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            let audio = directory.appendingPathComponent("silence.wav")
            try silentWAV(seconds: 1).write(to: audio)
            _ = try await configuration.cloud.transcribe(
                audio: audio, provider: provider, workDirectory: directory,
                deadline: .now + configuration.verifyDeadline)
            return .json(200, ["ok": true])
        } catch let failure as CloudFailure {
            log("verify \(provider.kind.rawValue): \(failure.rawValue)")
            switch failure {
            case .quota: return .json(200, ["ok": true])
            case .timeout: return .json(200, ["ok": false, "reason": CloudFailure.unreachable.rawValue])
            default: return .json(200, ["ok": false, "reason": failure.rawValue])
            }
        } catch {
            return .json(200, ["ok": false, "reason": CloudFailure.badResponse.rawValue])
        }
    }

    /// Why the selected provider cannot take a job now, if it cannot.
    private static func refusal(_ setting: ProviderSetting, store: ModelStore) -> (any Error)? {
        switch setting {
        case .local: store.isInstalled(.asr) ? nil : NotInstalled()
        case .cloud: store.isInstalled(.diarization) ? nil : NotReady()
        }
    }

    private func transcribe(_ head: HTTPRequestHead, received: Data) async -> HTTPResponse {
        guard authorized(head) else {
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
        if let refusal = Self.refusal(await providers.setting ?? .local, store: configuration.store) {
            return refusal is NotReady ? notReady : notInstalled
        }
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

            let configuration = configuration
            let providers = providers
            let outcome = try await queue.run {
                // The provider in effect when the job starts (D1).
                let setting = await providers.setting ?? .local
                if let refusal = Self.refusal(setting, store: configuration.store) { throw refusal }
                return try await Self.run(setting, audio: audioURL, directory: directory, configuration: configuration)
            }
            if case .cloud = outcome { await providers.cloudSucceeded() }
            return Self.render(outcome, verbose: format == "verbose_json", localModel: localModel)
        } catch is TooLarge {
            return .error(413, "file_too_large")
        } catch let error as BadRequest {
            return .error(400, "bad_request", error.message)
        } catch is NotInstalled {
            return notInstalled
        } catch is NotReady {
            return notReady
        } catch let error as CloudFailed {
            await providers.failed(error.provider, error.failure)
            return .json(502, [
                "error": [
                    "code": "cloud_asr_failed", "reason": error.failure.rawValue, "provider": error.provider.rawValue,
                    "message": "The \(error.provider.rawValue) transcription failed (\(error.failure.rawValue)).",
                ]
            ])
        } catch {
            log("transcription failed: \(error)")
            return .error(500, "transcription_failed", error.localizedDescription)
        }
    }

    private var notInstalled: HTTPResponse {
        .error(409, "local_asr_model_not_installed", "Local transcription is not installed.")
    }

    private var notReady: HTTPResponse {
        .json(409, ["error": ["code": "cloud_asr_not_ready", "reason": "diarization_missing"]])
    }

    /// The local recognizer's name, as the backend template knows it (C3).
    private var localModel: String {
        let repo = configuration.store.manifest.subset([.asr]).repos.first?.repo ?? "local"
        let name = (repo as NSString).lastPathComponent
        return name.hasSuffix("-coreml") ? String(name.dropLast("-coreml".count)) : name
    }

    /// Local: the local engine. Cloud: the separator runs here while the
    /// provider recognizes; if the provider fails, the local recognizer
    /// takes over when installed (D5, D6).
    private static func run(
        _ setting: ProviderSetting, audio: URL, directory: URL, configuration: ServerConfiguration
    ) async throws -> Outcome {
        let store = configuration.store
        let engine = configuration.engine
        guard case .cloud(let provider) = setting else {
            let result = try await engine.transcribe(
                audio: audio, installed: store.installedURL, speakers: store.isInstalled(.diarization))
            return .local(result, fallback: nil)
        }
        async let diarized: [SpeakerTurn]? = {
            do {
                return try await engine.diarize(audio: audio, installed: store.installedURL)
            } catch {
                log("diarization failed: \(error)")
                return nil
            }
        }()
        do {
            let transcript = try await configuration.cloud.transcribe(
                audio: audio, provider: provider, workDirectory: directory,
                deadline: .now + configuration.cloudDeadline)
            return .cloud(provider, transcript, turns: await diarized ?? [])
        } catch let failure as CloudFailure {
            let turns = await diarized ?? []
            log("\(provider.kind.rawValue) failed: \(failure.rawValue)")
            guard store.isInstalled(.asr) else { throw CloudFailed(provider: provider.kind, failure: failure) }
            let result = try await engine.transcribe(audio: audio, installed: store.installedURL, speakers: false)
            return .local(
                EngineResult(duration: result.duration, words: result.words, turns: turns),
                fallback: (provider.kind, failure))
        }
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

    private static func render(_ outcome: Outcome, verbose: Bool, localModel: String) -> HTTPResponse {
        func rounded(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
        var marks: [String: Any]
        let segments: [TranscriptSegment]
        let duration: Double
        switch outcome {
        case .local(let result, let fallback):
            segments = mergeWordsWithSpeakers(words: result.words, turns: result.turns)
            duration = result.duration
            marks = ["provider": ProviderKind.local.rawValue, "model": localModel]
            if let fallback {
                marks["fallback"] = ["from": fallback.from.rawValue, "reason": fallback.reason.rawValue]
            }
        case .cloud(let provider, let transcript, let turns):
            // Without speakers, the provider's segments keep their sentences.
            segments =
                turns.isEmpty
                ? transcript.segments.map { TranscriptSegment(start: $0.start, end: $0.end, speaker: nil, text: $0.text) }
                : mergeWordsWithSpeakers(words: transcript.units, turns: turns)
            duration = transcript.duration
            marks = ["provider": provider.kind.rawValue, "model": provider.model]
        }
        let text = segments.map(\.text).joined(separator: " ")
        guard verbose else { return .json(200, ["text": text]) }
        return .json(200, marks.merging([
            "text": text,
            "duration": rounded(duration),
            "segments": segments.enumerated().map { index, segment in
                [
                    "id": index, "start": rounded(segment.start), "end": rounded(segment.end),
                    "text": segment.text, "speaker": segment.speaker ?? NSNull(),
                ] as [String: Any]
            },
        ]) { $1 })
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

    /// Sends one complete message; `final` also closes the write side. An
    /// incomplete message would hold back every later send (such as the
    /// response after `100 Continue`).
    func send(_ data: Data, final: Bool) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            connection.send(
                content: data, contentContext: final ? .finalMessage : .defaultMessage, isComplete: true,
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
