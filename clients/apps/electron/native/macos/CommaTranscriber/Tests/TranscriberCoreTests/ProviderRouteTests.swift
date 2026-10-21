import Foundation
import os
import Testing
@testable import TranscriberCore

/// A cloud provider that returns the fake engine's words, or fails.
final class FakeCloud: CloudTranscribing {
    let failure: CloudFailure?
    let calls = OSAllocatedUnfairLock<[CloudProvider]>(initialState: [])

    init(failing failure: CloudFailure? = nil) { self.failure = failure }

    func transcribe(audio: URL, provider: CloudProvider, workDirectory: URL, deadline: ContinuousClock.Instant)
        async throws -> JoinedTranscript
    {
        calls.withLock { $0.append(provider) }
        if let failure { throw failure }
        return JoinedTranscript(
            duration: 3.1,
            words: [
                TimedWord(text: "Oi,", start: 0.1, end: 0.4), TimedWord(text: "tudo?", start: 0.5, end: 0.9),
                TimedWord(text: "Tudo.", start: 2.0, end: 2.4),
            ],
            segments: [
                TimedWord(text: "Oi, tudo?", start: 0.1, end: 0.9), TimedWord(text: "Tudo.", start: 2.0, end: 2.4),
            ])
    }
}

func request(
    _ port: UInt16, _ method: String, _ path: String, token: String? = "secret", json: Any? = nil, raw: String? = nil
) async throws -> Reply {
    let body = try raw.map { Data($0.utf8) } ?? json.map { try JSONSerialization.data(withJSONObject: $0) } ?? Data()
    var head = "\(method) \(path) HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
    if let token { head += "Authorization: Bearer \(token)\r\n" }
    head += "Content-Length: \(body.count)\r\n\r\n"
    return try await exchange(port, Data(head.utf8) + body)
}

func groqBody(_ baseURL: URL = URL(string: "https://api.groq.com/openai/v1")!) -> [String: Any] {
    ["kind": "groq", "baseUrl": baseURL.absoluteString, "model": "whisper-large-v3", "apiKey": testKey,
     "maxUploadBytes": 24_000_000]
}

private func transcribe(_ port: UInt16) async throws -> Reply {
    try await post(port, body: multipart(file: Data("audio".utf8), format: "verbose_json"))
}

private func useGroq(_ harness: Harness, _ baseURL: URL = URL(string: "https://api.groq.com/openai/v1")!)
    async throws
{
    #expect(try await request(harness.port, "PUT", "/v1/provider", json: groqBody(baseURL)).status == 204)
}

/// Lines the helper logs while it is alive.
private final class LogCapture: Sendable {
    let lines = OSAllocatedUnfairLock<[String]>(initialState: [])
    let token: UUID

    init() {
        let lines = lines
        token = addLogObserver { line in lines.withLock { $0.append(line) } }
    }

    func stop() -> [String] {
        removeLogObserver(token)
        return lines.withLock { $0 }
    }
}

// MARK: C6 routes

@Test func providerRoutesNeedTheToken() async throws {
    let harness = try await Harness()
    for (method, path) in [("PUT", "/v1/provider"), ("POST", "/v1/provider/verify")] {
        #expect(try await request(harness.port, method, path, token: nil, json: groqBody()).status == 401)
        #expect(try await request(harness.port, method, path, token: "secreT", json: groqBody()).status == 401)
    }
    #expect(try await get(harness.port, "/health").json?["provider"] as? NSDictionary == [
        "kind": "local", "configured": false,
    ])
    await harness.stop()
}

@Test func anInvalidProviderBodyGets400() async throws {
    let harness = try await Harness()
    var bodies: [[String: Any]] = [
        ["kind": "deepgram"], ["baseUrl": "https://x.test"],
    ]
    for (field, value) in [
        ("baseUrl", "http://api.groq.com/openai/v1" as Any), ("baseUrl", "ftp://127.0.0.1/v1"), ("baseUrl", "not a url"),
        ("model", ""), ("apiKey", ""), ("apiKey", 42), ("maxUploadBytes", 0), ("maxUploadBytes", "big"),
    ] {
        var body = groqBody()
        body[field] = value
        bodies.append(body)
    }
    for missing in ["baseUrl", "model", "apiKey"] {
        var body = groqBody()
        body.removeValue(forKey: missing)
        bodies.append(body)
    }
    for body in bodies {
        let reply = try await request(harness.port, "PUT", "/v1/provider", json: body)
        #expect(reply.status == 400, "\(body)")
        #expect(reply.errorCode == "bad_request")
        #expect(!String(decoding: reply.body, as: UTF8.self).contains(testKey))
    }
    #expect(try await request(harness.port, "PUT", "/v1/provider", raw: "{not json").status == 400)
    #expect(try await request(harness.port, "PUT", "/v1/provider", raw: "[]").status == 400)
    #expect(try await request(harness.port, "POST", "/v1/provider/verify", json: ["kind": "local"]).status == 400)
    #expect(try await request(harness.port, "GET", "/v1/provider").status == 405)
    #expect(try await get(harness.port, "/health").json?["provider"] as? NSDictionary == [
        "kind": "local", "configured": false,
    ])
    await harness.stop()
}

@Test func healthReportsTheConfiguredProvider() async throws {
    let harness = try await Harness()
    var body = groqBody(URL(string: "http://localhost:8080/v1")!)
    body["kind"] = "openai_compatible"
    body.removeValue(forKey: "maxUploadBytes")

    #expect(try await request(harness.port, "PUT", "/v1/provider", json: body).status == 204)
    #expect(try await get(harness.port, "/health").json?["provider"] as? NSDictionary == [
        "kind": "openai_compatible", "configured": true,
    ])
    #expect(try await request(harness.port, "PUT", "/v1/provider", json: ["kind": "local"]).status == 204)
    #expect(try await get(harness.port, "/health").json?["provider"] as? NSDictionary == [
        "kind": "local", "configured": true,
    ])
    await harness.stop()
}

@Test func verifyReportsWhetherTheProviderAcceptsTheKeyWithoutSavingIt() async throws {
    let accepting = try await FakeProvider([.respond(status: 200, body: verboseJSON(duration: 1, words: []))])
    let refusing = try await FakeProvider([.respond(status: 401, body: "{}")])
    let failing = try await FakeProvider([.respond(status: 502, body: "{}")])
    defer { [accepting, refusing, failing].forEach { $0.stop() } }
    let harness = try await Harness()

    let ok = try await request(harness.port, "POST", "/v1/provider/verify", json: groqBody(accepting.baseURL))
    let refused = try await request(harness.port, "POST", "/v1/provider/verify", json: groqBody(refusing.baseURL))
    let broken = try await request(harness.port, "POST", "/v1/provider/verify", json: groqBody(failing.baseURL))
    let unreachable = try await request(
        harness.port, "POST", "/v1/provider/verify",
        json: groqBody(URL(string: "http://127.0.0.1:\(try closedPort())/v1")!))

    #expect(ok.status == 200 && ok.json == ["ok": true])
    #expect(refused.json == ["ok": false, "reason": "cloud_auth_rejected"])
    #expect(broken.json == ["ok": false, "reason": "cloud_server_error"])
    #expect(unreachable.json == ["ok": false, "reason": "cloud_unreachable"])
    // One second of audio reached the provider, with the key.
    let sent = try #require(accepting.requests.first)
    #expect(sent.headers["authorization"] == "Bearer \(testKey)")
    #expect(sent.body.count > 32000)
    #expect(try await get(harness.port, "/health").json?["provider"] as? NSDictionary == [
        "kind": "local", "configured": false,
    ])
    await harness.stop()
}

// MARK: Routing (D1, D6) and the C7 response

@Test func localTranscribesWithTheLocalEngine() async throws {
    let cloud = FakeCloud()
    let harness = try await Harness(cloud: cloud)
    #expect(try await request(harness.port, "PUT", "/v1/provider", json: ["kind": "local"]).status == 204)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 200)
    #expect(reply.json?["provider"] as? String == "local")
    #expect(reply.json?["model"] as? String == "parakeet-tdt-0.6b-v3")
    #expect(reply.json?["fallback"] == nil)
    #expect(harness.engine.state.withLock { $0.speakers } == [true])
    #expect(cloud.calls.withLock { $0 }.isEmpty)
    await harness.stop()
}

@Test func cloudRecognizesInTheCloudAndLabelsSpeakersLocally() async throws {
    let cloud = FakeCloud()
    let harness = try await Harness(installed: [.diarization], cloud: cloud)
    try await useGroq(harness)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 200)
    #expect(reply.json == [
        "text": "Oi, tudo? Tudo.",
        "duration": 3.1,
        "provider": "groq",
        "model": "whisper-large-v3",
        "segments": [
            ["id": 0, "start": 0.1, "end": 0.9, "text": "Oi, tudo?", "speaker": "S1"],
            ["id": 1, "start": 2.0, "end": 2.4, "text": "Tudo.", "speaker": "S2"],
        ],
    ])
    #expect(cloud.calls.withLock { $0.map(\.apiKey) } == [testKey])
    #expect(harness.engine.state.withLock { ($0.calls, $0.diarizations) } == (0, 1))
    await harness.stop()
}

@Test func withoutTheSeparatorWorkingCloudSegmentsComeWithoutSpeakers() async throws {
    let harness = try await Harness(installed: [.diarization], cloud: FakeCloud())
    harness.engine.state.withLock { $0.diarizationFails = true }
    try await useGroq(harness)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 200)
    #expect(reply.json?["segments"] as? NSArray == [
        ["id": 0, "start": 0.1, "end": 0.9, "text": "Oi, tudo?", "speaker": NSNull()],
        ["id": 1, "start": 2.0, "end": 2.4, "text": "Tudo.", "speaker": NSNull()],
    ])
    await harness.stop()
}

@Test func aCloudFailureFallsBackToTheLocalModelWhenInstalled() async throws {
    let harness = try await Harness(cloud: FakeCloud(failing: .unreachable))
    try await useGroq(harness)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 200)
    #expect(reply.json?["provider"] as? String == "local")
    #expect(reply.json?["model"] as? String == "parakeet-tdt-0.6b-v3")
    #expect(reply.json?["fallback"] as? NSDictionary == ["from": "groq", "reason": "cloud_unreachable"])
    // The speakers found during the cloud attempt label the local words.
    #expect(harness.engine.state.withLock { ($0.speakers, $0.diarizations) } == ([false], 1))
    let speakers = (reply.json?["segments"] as? [NSDictionary])?.compactMap { $0["speaker"] as? String }
    #expect(speakers == ["S1", "S2"])
    await harness.stop()
}

@Test func aCloudFailureWithoutTheLocalModelGets502() async throws {
    let harness = try await Harness(installed: [.diarization], cloud: FakeCloud(failing: .quota))
    try await useGroq(harness)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 502)
    let error = try #require(reply.json?["error"] as? NSDictionary)
    #expect(error["code"] as? String == "cloud_asr_failed")
    #expect(error["reason"] as? String == "cloud_quota")
    #expect(error["provider"] as? String == "groq")
    #expect(error["message"] is String)
    #expect(harness.engine.state.withLock { $0.calls } == 0)
    await harness.stop()
}

@Test func cloudWithoutTheSeparatorGets409NotReady() async throws {
    let cloud = FakeCloud()
    let harness = try await Harness(installed: [.asr], cloud: cloud)
    try await useGroq(harness)

    let reply = try await transcribe(harness.port)

    #expect(reply.status == 409)
    #expect(reply.json == ["error": ["code": "cloud_asr_not_ready", "reason": "diarization_missing"]])
    #expect(cloud.calls.withLock { $0 }.isEmpty)
    await harness.stop()
}

@Test func theProviderCanChangeBetweenJobs() async throws {
    let provider = try await FakeProvider([
        .respond(status: 200, body: verboseJSON(duration: 2, words: [("Olá", 0.1, 0.4), ("Groq", 2.0, 2.3)]))
    ])
    defer { provider.stop() }
    let harness = try await Harness()

    try await useGroq(harness, provider.baseURL)
    let cloud = try await transcribe(harness.port)
    #expect(try await request(harness.port, "PUT", "/v1/provider", json: ["kind": "local"]).status == 204)
    let local = try await transcribe(harness.port)

    #expect(cloud.json?["provider"] as? String == "groq")
    #expect(cloud.json?["text"] as? String == "Olá Groq")
    #expect(local.json?["provider"] as? String == "local")
    #expect(provider.requests.count == 1)
    await harness.stop()
}

@Test func theKeyIsNeverLogged() async throws {
    let refusing = try await FakeProvider([.respond(status: 401, body: "{\"error\":\"\(testKey) is invalid\"}")])
    defer { refusing.stop() }
    let capture = LogCapture()
    let harness = try await Harness()

    var bad = groqBody()
    bad["baseUrl"] = "http://example.com"
    _ = try await request(harness.port, "PUT", "/v1/provider", json: bad)
    _ = try await request(harness.port, "POST", "/v1/provider/verify", json: groqBody(refusing.baseURL))
    try await useGroq(harness, refusing.baseURL)
    let fallback = try await transcribe(harness.port)
    await harness.stop()
    let lines = capture.stop()

    #expect(fallback.json?["fallback"] as? NSDictionary == ["from": "groq", "reason": "cloud_auth_rejected"])
    #expect(lines.contains { $0.contains("PUT /v1/provider") })
    #expect(!lines.isEmpty)
    #expect(lines.allSatisfy { !$0.contains(testKey) })
}
