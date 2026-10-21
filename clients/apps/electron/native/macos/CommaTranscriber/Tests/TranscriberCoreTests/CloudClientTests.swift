import Foundation
import Testing
@testable import TranscriberCore

let testKey = "gsk_test_4f1c9e0b7a62d"

func cloudProvider(_ baseURL: URL, maxUploadBytes: Int64 = 24_000_000) -> CloudProvider {
    CloudProvider(
        kind: .groq, baseURL: baseURL, model: "whisper-large-v3", apiKey: testKey, maxUploadBytes: maxUploadBytes)
}

private func audioFile() throws -> URL {
    let directory = try temporaryDirectory()
    let url = directory.appendingPathComponent("call.m4a")
    try Data("fake m4a bytes".utf8).write(to: url)
    return url
}

private func failure(
    _ replies: [FakeProvider.Reply], deadline: Duration = .seconds(420), requestTimeout: Duration = .seconds(120)
) async throws -> CloudFailure? {
    let server = try await FakeProvider(replies)
    defer { server.stop() }
    do {
        _ = try await CloudClient(requestTimeout: requestTimeout).transcribe(
            try audioFile(), provider: cloudProvider(server.baseURL), deadline: .now + deadline)
        return nil
    } catch let error as CloudFailure {
        return error
    }
}

@Test func aChunkIsSentAsVerboseJSONWithWordTimestamps() async throws {
    let server = try await FakeProvider([
        .respond(status: 200, body: verboseJSON(duration: 3.5, words: [("Olá", 0.2, 0.5), ("mundo", 0.6, 1.1)]))
    ])
    defer { server.stop() }

    let transcript = try await CloudClient().transcribe(
        try audioFile(), provider: cloudProvider(server.baseURL), deadline: .now + .seconds(420))

    #expect(transcript == ChunkTranscript(
        duration: 3.5,
        words: [TimedWord(text: "Olá", start: 0.2, end: 0.5), TimedWord(text: "mundo", start: 0.6, end: 1.1)],
        segments: [TimedWord(text: "Olá mundo", start: 0.2, end: 1.1)]))
    let request = try #require(server.requests.first)
    #expect(request.method == "POST")
    #expect(request.path == "/openai/v1/audio/transcriptions")
    #expect(request.headers["authorization"] == "Bearer \(testKey)")
    #expect(request.headers["content-type"]?.hasPrefix("multipart/form-data; boundary=") == true)
    #expect(request.fields.map { "\($0.0)=\($0.1)" } == [
        "model=whisper-large-v3", "response_format=verbose_json", "timestamp_granularities[]=word",
        "timestamp_granularities[]=segment", "temperature=0",
    ])
    let body = String(decoding: request.body, as: UTF8.self)
    #expect(body.contains("name=\"file\"; filename=\"call.m4a\"\r\nContent-Type: audio/mp4\r\n\r\nfake m4a bytes\r\n"))
}

@Test func aProviderWithoutWordsGivesSegmentsOnly() async throws {
    let server = try await FakeProvider([
        .respond(status: 200, body: verboseJSON(duration: 2, words: [("Oi", 0.1, 0.4)], includeWords: false))
    ])
    defer { server.stop() }

    let transcript = try await CloudClient().transcribe(
        try audioFile(), provider: cloudProvider(server.baseURL), deadline: .now + .seconds(420))

    #expect(transcript.words == nil)
    #expect(transcript.segments == [TimedWord(text: "Oi", start: 0.1, end: 0.4)])
}

@Test func failuresMapToCloudReasons() async throws {
    #expect(try await failure([.respond(status: 401, body: "{}")]) == .authRejected)
    #expect(try await failure([.respond(status: 403, body: "{}")]) == .authRejected)
    #expect(try await failure([.respond(status: 500, body: "{}")]) == .serverError)
    #expect(try await failure([.respond(status: 503, body: "oops")]) == .serverError)
    #expect(try await failure([.respond(status: 200, body: "not json")]) == .badResponse)
    #expect(try await failure([.respond(status: 200, body: "{\"segments\":[]}")]) == .badResponse)
    #expect(try await failure([.respond(status: 400, body: "{\"error\":{}}")]) == .badResponse)
    #expect(try await failure([.respond(status: 404, body: "{}")]) == .badResponse)
    #expect(try await failure([.hang], requestTimeout: .milliseconds(300)) == .timeout)
    // The job deadline caps a request too.
    #expect(try await failure([.hang], deadline: .milliseconds(300)) == .timeout)
}

@Test func anUnreachableProviderIsCloudUnreachable() async throws {
    let base = URL(string: "http://127.0.0.1:\(try closedPort())/v1")!
    await #expect(throws: CloudFailure.unreachable) {
        try await CloudClient().transcribe(try audioFile(), provider: cloudProvider(base), deadline: .now + .seconds(420))
    }
}

@Test func aShort429WaitsForRetryAfterAndCompletes() async throws {
    let server = try await FakeProvider([
        .respond(status: 429, headers: ["retry-after": "1"], body: "{\"error\":{\"code\":\"rate_limit_exceeded\"}}"),
        .respond(status: 200, body: verboseJSON(duration: 1, words: [("ok", 0, 0.3)])),
    ])
    defer { server.stop() }
    let started = ContinuousClock.now

    let transcript = try await CloudClient().transcribe(
        try audioFile(), provider: cloudProvider(server.baseURL), deadline: .now + .seconds(420))

    #expect(transcript.words?.map(\.text) == ["ok"])
    #expect(server.requests.count == 2)
    #expect(ContinuousClock.now - started >= .seconds(1))
}

@Test func a429BeyondTheDeadlineIsAQuotaFailure() async throws {
    let started = ContinuousClock.now
    #expect(try await failure([.respond(status: 429, headers: ["retry-after": "500"], body: "{}")]) == .quota)
    #expect(try await failure([.respond(status: 429, body: "{}")]) == .quota)
    #expect(ContinuousClock.now - started < .seconds(5))
}

@Test func piecesAreSentOneAtATimeAndJoined() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recording = directory.appendingPathComponent("call.m4a")
    try makeRecording(recording, seconds: 60)
    let size = try #require(try FileManager.default.attributesOfItem(atPath: recording.path)[.size] as? Int64)
    // Each piece reports one word one second in.
    let server = try await FakeProvider([.respond(status: 200, body: verboseJSON(duration: 20, words: [("w", 1, 1.4)]))])
    defer { server.stop() }

    let joined = try await CloudTranscriber().transcribe(
        audio: recording, provider: cloudProvider(server.baseURL, maxUploadBytes: size / 3), workDirectory: directory,
        deadline: .now + .seconds(420))

    #expect(server.requests.count >= 4)
    #expect(server.maxConcurrent == 1)
    #expect(joined.words?.count == server.requests.count)
    let starts = try #require(joined.words?.map(\.start))
    #expect(starts == starts.sorted())
    #expect(abs(joined.duration - 60) < 0.05)
}

@Test func theKeyIsNotInTheProviderDescription() {
    let provider = cloudProvider(URL(string: "https://api.groq.com/openai/v1")!)
    #expect(!"\(provider)".contains(testKey))
    #expect(!String(reflecting: provider).contains(testKey))
    var dumped = ""
    dump(provider, to: &dumped)
    #expect(!dumped.contains(testKey))
}

@Test func aRedirectIsNotFollowedSoTheAudioStaysWithTheProvider() async throws {
    let elsewhere = try await FakeProvider([.respond(status: 200, body: verboseJSON(duration: 1, words: [("x", 0, 0.3)]))])
    defer { elsewhere.stop() }
    let target = elsewhere.baseURL.appendingPathComponent("audio/transcriptions").absoluteString
    for status in [301, 302, 303, 307, 308] {
        let redirecting = try await FakeProvider([.respond(status: status, headers: ["location": target], body: "")])
        defer { redirecting.stop() }
        await #expect(throws: CloudFailure.badResponse) {
            try await CloudClient().transcribe(
                try audioFile(), provider: cloudProvider(redirecting.baseURL), deadline: .now + .seconds(420))
        }
        #expect(redirecting.requests.count == 1)
    }
    // Neither the audio nor the key reached the other origin.
    #expect(elsewhere.requests.isEmpty)
}

@Test func emptyWordsWithTextFallBackToSegmentsThenText() throws {
    let segmented = try CloudClient.parse(Data("""
        {"text":"Hello there","duration":2,"words":[],"segments":[{"text":"Hello there","start":0.2,"end":1.4}]}
        """.utf8))
    #expect(segmented.words == nil)
    #expect(segmented.segments == [TimedWord(text: "Hello there", start: 0.2, end: 1.4)])

    let textOnly = try CloudClient.parse(Data("{\"text\":\" Hi \",\"duration\":3,\"words\":[],\"segments\":[]}".utf8))
    #expect(textOnly.words == nil)
    #expect(textOnly.segments == [TimedWord(text: "Hi", start: 0, end: 3)])

    // Silence: no words and no text still counts as word timestamps, so one
    // quiet piece does not take word timing away from the others.
    let silent = try CloudClient.parse(Data("{\"text\":\"\",\"duration\":3,\"words\":[],\"segments\":[]}".utf8))
    #expect(silent.words == [])
    #expect(silent.segments.isEmpty)
}
