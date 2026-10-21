import Foundation

struct HTTPRequestHead: Sendable {
    let method: String
    let path: String
    /// Lowercased names; a repeated header keeps its last value.
    let headers: [String: String]

    static let terminator = Data("\r\n\r\n".utf8)

    /// Parses the request line and headers that precede `\r\n\r\n`.
    init?(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count == 3, requestLine[2].hasPrefix("HTTP/1.") else { return nil }
        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { return nil }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        method = String(requestLine[0])
        path = String(requestLine[1].split(separator: "?", maxSplits: 1).first ?? "")
        self.headers = headers
    }

    var bearerToken: String? {
        guard let value = headers["authorization"] else { return nil }
        let parts = value.split(separator: " ", maxSplits: 1)
        guard parts.count == 2, parts[0].lowercased() == "bearer" else { return nil }
        return parts[1].trimmingCharacters(in: .whitespaces)
    }
}

struct HTTPResponse: Sendable {
    let status: Int
    let body: Data

    static func json(_ status: Int, _ object: [String: Any]) -> HTTPResponse {
        HTTPResponse(status: status, body: Data(jsonLineOf(object).utf8))
    }

    static func error(_ status: Int, _ code: String, _ message: String? = nil) -> HTTPResponse {
        var error: [String: Any] = ["code": code]
        if let message { error["message"] = message }
        return json(status, ["error": error])
    }

    var serialized: Data {
        let reason = HTTPURLResponse.localizedString(forStatusCode: status).capitalized
        let head =
            "HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json\r\n"
            + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        return Data(head.utf8) + body
    }
}

/// Decodes a `Transfer-Encoding: chunked` body incrementally.
struct ChunkedDecoder {
    private enum State {
        case size
        case data(remaining: Int)
        case dataEnd
        case trailer
        case done
    }

    private var state = State.size
    private var line = Data()
    var isDone: Bool { if case .done = state { true } else { false } }

    struct Malformed: Error {}

    /// Returns the payload bytes contained in `input`.
    mutating func feed(_ input: Data) throws -> Data {
        var output = Data()
        var index = input.startIndex
        while index < input.endIndex {
            switch state {
            case .size, .dataEnd, .trailer:
                let byte = input[index]
                index += 1
                guard byte == UInt8(ascii: "\n") else {
                    line.append(byte)
                    guard line.count <= 4096 else { throw Malformed() }
                    continue
                }
                let text = String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespaces)
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\r"))
                line.removeAll()
                switch state {
                case .size:
                    let hex = text.split(separator: ";").first.map(String.init) ?? ""
                    guard let size = Int(hex, radix: 16), size >= 0 else { throw Malformed() }
                    state = size == 0 ? .trailer : .data(remaining: size)
                case .dataEnd:
                    guard text.isEmpty else { throw Malformed() }
                    state = .size
                default:
                    if text.isEmpty { state = .done }
                }
            case .data(let remaining):
                let count = min(remaining, input.endIndex - index)
                output.append(input[index..<(index + count)])
                index += count
                state = remaining == count ? .dataEnd : .data(remaining: remaining - count)
            case .done:
                return output
            }
        }
        return output
    }
}
