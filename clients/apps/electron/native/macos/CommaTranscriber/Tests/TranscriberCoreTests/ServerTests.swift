import Foundation
import os
import Testing
@testable import TranscriberCore

let fakeTurns = [
    SpeakerTurn(speaker: "S4", start: 0, end: 1.2),
    SpeakerTurn(speaker: "S2", start: 1.8, end: 3.0),
]

/// Returns two speakers' words; optionally waits on a gate and records how
/// many jobs ran at once.
final class FakeEngine: TranscriptionEngine {
    struct State {
        var running = 0
        var maxRunning = 0
        var calls = 0
        var gateOpen = true
        /// `speakers` of each recognition.
        var speakers: [Bool] = []
        var diarizations = 0
        var diarizationFails = false
    }
    let state = OSAllocatedUnfairLock(initialState: State())

    func diarize(audio: URL, installed: URL) async throws -> [SpeakerTurn] {
        let fails = state.withLock {
            $0.diarizations += 1
            return $0.diarizationFails
        }
        if fails { throw CocoaError(.fileReadCorruptFile) }
        return fakeTurns
    }

    func transcribe(audio: URL, installed: URL, speakers: Bool) async throws -> EngineResult {
        let bytes = try Data(contentsOf: audio)
        state.withLock {
            $0.running += 1
            $0.maxRunning = max($0.maxRunning, $0.running)
            $0.calls += 1
            $0.speakers.append(speakers)
        }
        defer { state.withLock { $0.running -= 1 } }
        while !state.withLock({ $0.gateOpen }) {
            try await Task.sleep(for: .milliseconds(2))
        }
        if bytes == Data("explode".utf8) {
            throw CocoaError(.fileReadCorruptFile)
        }
        return EngineResult(
            duration: 4.25,
            words: [
                TimedWord(text: "Olá,", start: 0.08, end: 0.4),
                TimedWord(text: "tudo", start: 0.5, end: 0.7),
                TimedWord(text: "bem?", start: 0.7, end: 1.0),
                TimedWord(text: "Tudo", start: 2.0, end: 2.3),
                TimedWord(text: "ótimo.", start: 2.3, end: 2.8),
            ],
            turns: speakers ? fakeTurns : [])
    }
}

struct Reply {
    let status: Int
    let headers: [String: String]
    let body: Data
    var json: NSDictionary? { try? JSONSerialization.jsonObject(with: body) as? NSDictionary }
    var errorCode: String? { (json?["error"] as? NSDictionary)?["code"] as? String }
}

/// A raw HTTP/1.1 exchange over a loopback socket, on a Dispatch thread so
/// the blocking reads do not hold the cooperative pool the server runs on.
func exchange(_ port: UInt16, _ request: Data) async throws -> Reply {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(with: Result { try blockingExchange(port, request) })
        }
    }
}

private func blockingExchange(_ port: UInt16, _ request: Data) throws -> Reply {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    precondition(fd >= 0)
    defer { close(fd) }
    var timeout = timeval(tv_sec: 10, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = port.bigEndian
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    precondition(connected == 0, "connect failed")
    _ = request.withUnsafeBytes { send(fd, $0.baseAddress, $0.count, 0) }

    var received = Data()
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let count = recv(fd, &buffer, buffer.count, 0)
        if count <= 0 { break }
        received.append(contentsOf: buffer[0..<count])
    }
    // Skip interim responses such as 100 Continue.
    while received.starts(with: Data("HTTP/1.1 1".utf8)),
        let interim = received.range(of: Data("\r\n\r\n".utf8))
    {
        received = Data(received[interim.upperBound...])
    }
    let separator = try #require(received.range(of: Data("\r\n\r\n".utf8)))
    let head = String(decoding: received[..<separator.lowerBound], as: UTF8.self)
    var lines = head.components(separatedBy: "\r\n")
    let status = Int(lines.removeFirst().split(separator: " ")[1])!
    var headers: [String: String] = [:]
    for line in lines {
        let parts = line.split(separator: ":", maxSplits: 1)
        headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
    }
    return Reply(status: status, headers: headers, body: Data(received[separator.upperBound...]))
}

func get(_ port: UInt16, _ path: String) async throws -> Reply {
    try await exchange(port, Data("GET \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8))
}

let boundary = "comma-test-boundary"

func multipart(file: Data?, format: String? = nil) -> Data {
    var body = Data()
    func field(_ name: String, _ value: String) {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    field("model", "parakeet-tdt-0.6b-v3")
    if let format { field("response_format", format) }
    if let file {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"call.m4a\"\r\nContent-Type: audio/mp4\r\n\r\n".utf8))
        body.append(file)
        body.append(Data("\r\n".utf8))
    }
    body.append(Data("--\(boundary)--\r\n".utf8))
    return body
}

func post(
    _ port: UInt16, token: String? = "secret", body: Data, contentLength: Int? = nil,
    chunked: Bool = false, expectContinue: Bool = false
) async throws -> Reply {
    var head = "POST /v1/audio/transcriptions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    if expectContinue { head += "Expect: 100-continue\r\n" }
    head += "Content-Type: multipart/form-data; boundary=\(boundary)\r\n"
    if let token { head += "Authorization: Bearer \(token)\r\n" }
    var payload = body
    if chunked {
        head += "Transfer-Encoding: chunked\r\n"
        payload = Data()
        var offset = 0
        while offset < body.count {
            let chunk = body[offset..<min(offset + 1000, body.count)]
            payload.append(Data("\(String(chunk.count, radix: 16))\r\n".utf8))
            payload.append(chunk)
            payload.append(Data("\r\n".utf8))
            offset += chunk.count
        }
        payload.append(Data("0\r\n\r\n".utf8))
    } else {
        head += "Content-Length: \(contentLength ?? body.count)\r\n"
    }
    return try await exchange(port, Data((head + "\r\n").utf8) + payload)
}

/// Marks `components` installed: a tree without markers for both, as the
/// previous helper left it, else one marker each.
func install(_ components: Set<ModelComponent>, in store: ModelStore) throws {
    try FileManager.default.createDirectory(at: store.installedURL, withIntermediateDirectories: true)
    guard components != ModelComponent.all else { return }
    for component in components {
        try Data().write(to: store.installedURL.appendingPathComponent(".installed-\(component.rawValue)"))
    }
}

struct Harness {
    let root: URL
    let store: ModelStore
    let engine = FakeEngine()
    let server: TranscriptionServer
    let port: UInt16

    init(
        installed: Set<ModelComponent> = ModelComponent.all, maxFileBytes: Int64 = 64 << 20,
        cloud: any CloudTranscribing = CloudTranscriber()
    ) async throws {
        root = try temporaryDirectory()
        store = ModelStore(root: root, manifest: sampleManifest)
        if !installed.isEmpty {
            try install(installed, in: store)
        }
        server = TranscriptionServer(
            configuration: ServerConfiguration(
                token: "secret", store: store, engine: engine, cloud: cloud, maxFileBytes: maxFileBytes))
        port = try await server.start(port: 0)
    }

    func stop() async {
        await server.stop()
        try? FileManager.default.removeItem(at: root)
    }
}

@Test func healthReportsTheModelAndIdleState() async throws {
    let harness = try await Harness(installed: [])
    let notInstalled = try await get(harness.port, "/health")
    #expect(notInstalled.status == 200)
    #expect(notInstalled.json == [
        "status": "ok", "busy": false, "model": "not_installed",
        "provider": ["kind": "local", "configured": false],
        "components": ["asr": false, "diarization": false],
    ])

    try install([.diarization], in: harness.store)
    let separatorOnly = try await get(harness.port, "/health").json
    #expect(separatorOnly?["model"] as? String == "not_installed")
    #expect(separatorOnly?["components"] as? NSDictionary == ["asr": false, "diarization": true])
    try install([.asr], in: harness.store)
    #expect(try await get(harness.port, "/health").json?["model"] as? String == "ready")
    await harness.stop()
}

@Test func aRequestWithoutTheTokenIsRefused() async throws {
    let harness = try await Harness()
    let missing = try await post(harness.port, token: nil, body: multipart(file: Data("audio".utf8)))
    let wrong = try await post(harness.port, token: "secreT", body: multipart(file: Data("audio".utf8)))

    #expect(missing.status == 401)
    #expect(missing.errorCode == "unauthorized")
    #expect(wrong.status == 401)
    #expect(harness.engine.state.withLock { $0.calls } == 0)
    await harness.stop()
}

@Test func aRequestWithoutAnInstalledModelGets409() async throws {
    let harness = try await Harness(installed: [.diarization])
    let reply = try await post(harness.port, body: multipart(file: Data("audio".utf8)))

    #expect(reply.status == 409)
    #expect(reply.errorCode == "local_asr_model_not_installed")
    #expect((reply.json?["error"] as? NSDictionary)?["message"] is String)
    await harness.stop()
}

@Test func aFileAboveTheLimitGets413() async throws {
    let harness = try await Harness(maxFileBytes: 4096)
    // Announced too large: refused before the body is read.
    let announced = try await post(harness.port, body: Data(), contentLength: 64 << 20)
    // Streamed too large without a length.
    let streamed = try await post(
        harness.port, body: multipart(file: Data(repeating: 7, count: 8192)), chunked: true)
    // Just under the limit in a body with multipart overhead.
    let atLimit = try await post(harness.port, body: multipart(file: Data(repeating: 7, count: 4096)))

    #expect(announced.status == 413)
    #expect(announced.errorCode == "file_too_large")
    #expect(streamed.status == 413)
    #expect(atLimit.status == 200)
    await harness.stop()
}

@Test func verboseJSONHasTimedSegmentsWithSpeakers() async throws {
    let harness = try await Harness()
    let reply = try await post(harness.port, body: multipart(file: Data("audio".utf8), format: "verbose_json"))

    #expect(reply.status == 200)
    #expect(reply.headers["content-type"] == "application/json")
    #expect(reply.json == [
        "text": "Olá, tudo bem? Tudo ótimo.",
        "duration": 4.25,
        "provider": "local",
        "model": "parakeet-tdt-0.6b-v3",
        "segments": [
            ["id": 0, "start": 0.08, "end": 1.0, "text": "Olá, tudo bem?", "speaker": "S1"],
            ["id": 1, "start": 2.0, "end": 2.8, "text": "Tudo ótimo.", "speaker": "S2"],
        ],
    ])
    await harness.stop()
}

@Test func jsonIsTheDefaultFormatAndChunkedUploadsWork() async throws {
    let harness = try await Harness()
    let reply = try await post(harness.port, body: multipart(file: Data("audio".utf8)), chunked: true)

    #expect(reply.status == 200)
    #expect(reply.json == ["text": "Olá, tudo bem? Tudo ótimo."])
    await harness.stop()
}

@Test func aClientExpecting100ContinueGetsTheFinalResponse() async throws {
    // curl sends Expect: 100-continue for bodies above 1 MiB.
    let harness = try await Harness()
    let reply = try await post(
        harness.port, body: multipart(file: Data(repeating: 1, count: 2 << 20)), expectContinue: true)

    #expect(reply.status == 200)
    #expect(reply.json?["text"] as? String == "Olá, tudo bem? Tudo ótimo.")
    await harness.stop()
}

@Test func malformedRequestsGet400And404() async throws {
    let harness = try await Harness()
    let noFile = try await post(harness.port, body: multipart(file: nil))
    let badFormat = try await post(harness.port, body: multipart(file: Data("a".utf8), format: "srt"))
    let unknown = try await get(harness.port, "/v1/models")

    #expect(noFile.status == 400)
    #expect(noFile.errorCode == "bad_request")
    #expect(badFormat.status == 400)
    #expect(unknown.status == 404)
    await harness.stop()
}

@Test func anEngineFailureGets500() async throws {
    let harness = try await Harness()
    let reply = try await post(harness.port, body: multipart(file: Data("explode".utf8)))

    #expect(reply.status == 500)
    #expect(reply.errorCode == "transcription_failed")
    #expect(try await get(harness.port, "/health").json?["busy"] as? Bool == false)
    await harness.stop()
}

@Test func transcriptionsRunOneAtATimeAndAllFinish() async throws {
    let harness = try await Harness()
    harness.engine.state.withLock { $0.gateOpen = false }
    let port = harness.port

    let replies = Task.detached {
        try await withThrowingTaskGroup(of: Reply.self) { group in
            for _ in 0..<3 {
                group.addTask { try await post(port, body: multipart(file: Data("audio".utf8))) }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }
    }
    while harness.engine.state.withLock({ $0.calls }) < 1 {
        try await Task.sleep(for: .milliseconds(2))
    }
    #expect(try await get(port, "/health").json?["busy"] as? Bool == true)
    harness.engine.state.withLock { $0.gateOpen = true }

    let results = try await replies.value
    #expect(results.map(\.status) == [200, 200, 200])
    #expect(harness.engine.state.withLock { $0.maxRunning } == 1)
    #expect(harness.engine.state.withLock { $0.calls } == 3)
    #expect(try await get(port, "/health").json?["busy"] as? Bool == false)
    await harness.stop()
}

@Test func aModelRemovedWhileQueuedGets409() async throws {
    let harness = try await Harness()
    harness.engine.state.withLock { $0.gateOpen = false }
    let port = harness.port

    let first = Task.detached { try await post(port, body: multipart(file: Data("audio".utf8))) }
    while harness.engine.state.withLock({ $0.calls }) < 1 {
        try await Task.sleep(for: .milliseconds(2))
    }
    let second = Task.detached { try await post(port, body: multipart(file: Data("audio".utf8))) }
    while await harness.server.queue.waiting < 1 {
        try await Task.sleep(for: .milliseconds(2))
    }
    try FileManager.default.removeItem(at: harness.store.installedURL)
    harness.engine.state.withLock { $0.gateOpen = true }

    #expect(try await first.value.status == 200)
    #expect(try await second.value.errorCode == "local_asr_model_not_installed")
    await harness.stop()
}
