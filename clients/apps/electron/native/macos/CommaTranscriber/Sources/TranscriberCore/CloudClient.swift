import Foundation

public enum ProviderKind: String, Sendable, CaseIterable {
    case local
    case groq
    case openaiCompatible = "openai_compatible"
}

/// An OpenAI-compatible transcription API (openspec add-cloud-meeting-asr,
/// C6). Held only in memory. Descriptions and mirrors leave the key out, so
/// interpolating a provider into a log line cannot leak it.
public struct CloudProvider: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    public let kind: ProviderKind
    public let baseURL: URL
    public let model: String
    public let apiKey: String
    public let maxUploadBytes: Int64

    public init(kind: ProviderKind, baseURL: URL, model: String, apiKey: String, maxUploadBytes: Int64) {
        self.kind = kind
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
        self.maxUploadBytes = maxUploadBytes
    }

    public var description: String { "\(kind.rawValue) \(baseURL.host ?? "") \(model)" }

    public var customMirror: Mirror {
        Mirror(self, children: ["kind": kind, "host": baseURL.host ?? "", "model": model], displayStyle: .struct)
    }
}

/// Why a cloud attempt failed (D5), as reported in C6 and C7.
public enum CloudFailure: String, Error, Sendable, Equatable {
    case authRejected = "cloud_auth_rejected"
    case unreachable = "cloud_unreachable"
    case serverError = "cloud_server_error"
    case timeout = "cloud_timeout"
    case badResponse = "cloud_bad_response"
    case quota = "cloud_quota"
}

/// Sends one file to `{baseURL}/audio/transcriptions` and reads
/// `verbose_json` with word and segment timestamps (D4, D5). A 429 is
/// retried after `retry-after` when the wait ends before `deadline`.
public struct CloudClient: Sendable {
    let requestTimeout: Duration
    let session: URLSession

    public init(requestTimeout: Duration = .seconds(120)) {
        self.requestTimeout = requestTimeout
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        session = URLSession(configuration: configuration)
    }

    public func transcribe(_ file: URL, provider: CloudProvider, deadline: ContinuousClock.Instant)
        async throws -> ChunkTranscript
    {
        let boundary = "comma-\(UUID().uuidString)"
        let body = try multipart(file, provider: provider, boundary: boundary)
        var request = URLRequest(url: provider.baseURL.appendingPathComponent("audio/transcriptions"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(provider.apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        while true {
            let (data, response) = try await send(request, body: body, deadline: deadline)
            switch response.statusCode {
            case 200..<300:
                return try Self.parse(data)
            case 401, 403:
                throw CloudFailure.authRejected
            case 429:
                guard let wait = response.value(forHTTPHeaderField: "retry-after").flatMap(Double.init),
                    wait >= 0, ContinuousClock.now + .seconds(wait) < deadline
                else {
                    log("cloud \(provider.baseURL.host ?? "") 429 beyond the deadline")
                    throw CloudFailure.quota
                }
                log("cloud \(provider.baseURL.host ?? "") 429, retrying in \(wait) s")
                try await Task.sleep(for: .seconds(wait))
            case 500...:
                throw CloudFailure.serverError
            default:
                log("cloud \(provider.baseURL.host ?? "") \(response.statusCode)")
                throw CloudFailure.badResponse
            }
        }
    }

    /// One request, bounded by `requestTimeout` and by `deadline`.
    private func send(_ request: URLRequest, body: Data, deadline: ContinuousClock.Instant)
        async throws -> (Data, HTTPURLResponse)
    {
        let remaining = deadline - ContinuousClock.now
        guard remaining > .zero else { throw CloudFailure.timeout }
        let limit = min(requestTimeout, remaining)
        var bounded = request
        bounded.timeoutInterval = Double(limit.components.seconds) + Double(limit.components.attoseconds) / 1e18
        let request = bounded
        let session = session
        return try await withThrowingTaskGroup(of: (Data, HTTPURLResponse)?.self) { group in
            group.addTask {
                do {
                    let (data, response) = try await session.upload(for: request, from: body)
                    guard let http = response as? HTTPURLResponse else { throw CloudFailure.badResponse }
                    return (data, http)
                } catch let error as URLError {
                    if error.code == .timedOut { throw CloudFailure.timeout }
                    if error.code == .cancelled, Task.isCancelled { throw CancellationError() }
                    throw CloudFailure.unreachable
                }
            }
            group.addTask {
                try await Task.sleep(for: limit)
                return nil
            }
            defer { group.cancelAll() }
            guard let result = try await group.next(), let result else { throw CloudFailure.timeout }
            return result
        }
    }

    private func multipart(_ file: URL, provider: CloudProvider, boundary: String) throws -> Data {
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("model", provider.model)
        field("response_format", "verbose_json")
        field("timestamp_granularities[]", "word")
        field("timestamp_granularities[]", "segment")
        field("temperature", "0")
        let types = ["m4a": "audio/mp4", "mp4": "audio/mp4", "wav": "audio/wav", "mp3": "audio/mpeg", "flac": "audio/flac"]
        let fileExtension = file.pathExtension.lowercased()
        body.append(Data(
            ("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(file.lastPathComponent)\"\r\n"
                + "Content-Type: \(types[fileExtension] ?? "application/octet-stream")\r\n\r\n").utf8))
        body.append(try Data(contentsOf: file))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    static func parse(_ data: Data) throws -> ChunkTranscript {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let text = object["text"] as? String
        else { throw CloudFailure.badResponse }
        func timed(_ value: Any?, textKey: String) throws -> [TimedWord]? {
            guard let items = value as? [[String: Any]] else { return nil }
            return try items.map { item in
                guard let text = item[textKey] as? String, let start = (item["start"] as? NSNumber)?.doubleValue,
                    let end = (item["end"] as? NSNumber)?.doubleValue
                else { throw CloudFailure.badResponse }
                return TimedWord(text: text.trimmingCharacters(in: .whitespacesAndNewlines), start: start, end: end)
            }
        }
        let duration = (object["duration"] as? NSNumber)?.doubleValue
        let words = try timed(object["words"], textKey: "word")
        var segments = try timed(object["segments"], textKey: "text") ?? []
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if segments.isEmpty, words == nil, !trimmed.isEmpty {
            // Only text: one segment over the whole piece.
            segments = [TimedWord(text: trimmed, start: 0, end: duration ?? 0)]
        }
        return ChunkTranscript(duration: duration, words: words, segments: segments)
    }
}

/// Recognizes a recording with a cloud provider: cuts it to the provider's
/// limit and sends the pieces one at a time (20 RPM on the Groq free tier).
public protocol CloudTranscribing: Sendable {
    func transcribe(audio: URL, provider: CloudProvider, workDirectory: URL, deadline: ContinuousClock.Instant)
        async throws -> JoinedTranscript
}

public struct CloudTranscriber: CloudTranscribing {
    let client: CloudClient

    public init(client: CloudClient = CloudClient()) {
        self.client = client
    }

    public func transcribe(audio: URL, provider: CloudProvider, workDirectory: URL, deadline: ContinuousClock.Instant)
        async throws -> JoinedTranscript
    {
        let chunks = try await AudioChunker(maxUploadBytes: provider.maxUploadBytes).split(audio, into: workDirectory)
        var pieces: [(chunk: AudioChunk, transcript: ChunkTranscript)] = []
        for chunk in chunks {
            pieces.append((chunk, try await client.transcribe(chunk.url, provider: provider, deadline: deadline)))
        }
        if chunks.count > 1 { log("cloud \(provider): \(chunks.count) pieces") }
        return joinChunks(pieces)
    }
}
