import Foundation
import Network
import os
@testable import TranscriberCore

/// An OpenAI-style transcription API on a loopback port. Each request gets
/// the next scripted reply (the last one repeats); requests are recorded.
final class FakeProvider: Sendable {
    enum Reply: Sendable {
        case respond(status: Int, headers: [String: String] = [:], body: String)
        /// Accepts the request and never answers.
        case hang
    }

    struct Request: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data

        /// Text fields of the multipart body, repeated names in order.
        var fields: [(String, String)] {
            let text = String(decoding: body, as: UTF8.self)
            var result: [(String, String)] = []
            for part in text.components(separatedBy: "Content-Disposition: form-data; name=\"").dropFirst() {
                guard let nameEnd = part.firstIndex(of: "\""), !part[nameEnd...].hasPrefix("\"; filename"),
                    let valueStart = part.range(of: "\r\n\r\n")?.upperBound,
                    let valueEnd = part.range(of: "\r\n--", range: valueStart..<part.endIndex)?.lowerBound
                else { continue }
                result.append((String(part[..<nameEnd]), String(part[valueStart..<valueEnd])))
            }
            return result
        }
    }

    private struct State {
        var replies: [Reply]
        var requests: [Request] = []
        var active = 0
        var maxActive = 0
    }

    private let state: OSAllocatedUnfairLock<State>
    private let listener: NWListener
    let port: UInt16

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/openai/v1")! }
    var requests: [Request] { state.withLock { $0.requests } }
    var maxConcurrent: Int { state.withLock { $0.maxActive } }

    init(_ replies: [Reply]) async throws {
        let state = OSAllocatedUnfairLock(initialState: State(replies: replies))
        self.state = state
        let queue = DispatchQueue(label: "FakeProvider")
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener
        let ready = OSAllocatedUnfairLock(initialState: false)
        listener.newConnectionHandler = { [state, queue] connection in
            connection.start(queue: queue)
            Self.serve(connection, state: state, buffer: Data())
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            listener.stateUpdateHandler = { update in
                switch update {
                case .ready:
                    if ready.withLock({ done in defer { done = true }; return !done }) { continuation.resume() }
                case .failed(let error):
                    if ready.withLock({ done in defer { done = true }; return !done }) {
                        continuation.resume(throwing: error)
                    }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        port = listener.port!.rawValue
    }

    func stop() { listener.cancel() }

    private static func serve(_ connection: NWConnection, state: OSAllocatedUnfairLock<State>, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { data, _, isComplete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            if let end = buffer.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(decoding: buffer[..<end.lowerBound], as: UTF8.self)
                var lines = head.components(separatedBy: "\r\n")
                let requestLine = lines.removeFirst().split(separator: " ")
                var headers: [String: String] = [:]
                for line in lines {
                    let parts = line.split(separator: ":", maxSplits: 1)
                    if parts.count == 2 {
                        headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
                    }
                }
                let length = Int(headers["content-length"] ?? "0") ?? 0
                let body = buffer[end.upperBound...]
                if body.count >= length {
                    let request = Request(
                        method: String(requestLine[0]), path: String(requestLine[1]), headers: headers,
                        body: Data(body.prefix(length)))
                    respond(connection, to: request, state: state)
                    return
                }
            }
            if isComplete || error != nil {
                connection.cancel()
                return
            }
            serve(connection, state: state, buffer: buffer)
        }
    }

    private static func respond(_ connection: NWConnection, to request: Request, state: OSAllocatedUnfairLock<State>) {
        let reply = state.withLock { state in
            state.requests.append(request)
            state.active += 1
            state.maxActive = max(state.maxActive, state.active)
            return state.replies.count > 1 ? state.replies.removeFirst() : state.replies[0]
        }
        guard case .respond(let status, let headers, let body) = reply else { return }
        var head = "HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\n"
        head += "Connection: close\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        // Answer a little later without blocking, so overlapping requests
        // would be seen as concurrent.
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) {
            state.withLock { $0.active -= 1 }
            connection.send(
                content: Data((head + "\r\n" + body).utf8), contentContext: .finalMessage, isComplete: true,
                completion: .contentProcessed { _ in connection.cancel() })
        }
    }
}

/// A verbose_json reply with one word per entry of `words` (text, start, end).
func verboseJSON(duration: Double, words: [(String, Double, Double)], includeWords: Bool = true) -> String {
    var object: [String: Any] = [
        "task": "transcribe", "language": "portuguese", "duration": duration,
        "text": words.map(\.0).joined(separator: " "),
        "segments": words.isEmpty ? [] : [
            ["id": 0, "start": words.first!.1, "end": words.last!.2, "text": words.map(\.0).joined(separator: " ")]
        ],
    ]
    if includeWords {
        object["words"] = words.map { ["word": $0.0, "start": $0.1, "end": $0.2] }
    }
    return String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
}

/// A port with nothing listening on it.
func closedPort() throws -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
            bind(fd, pointer, length)
            return getsockname(fd, pointer, &length)
        }
    }
    return UInt16(bigEndian: address.sin_port)
}
