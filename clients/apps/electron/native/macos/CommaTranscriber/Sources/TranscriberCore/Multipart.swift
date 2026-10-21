import Foundation

/// A `multipart/form-data` body already written to disk.
struct MultipartForm {
    struct Malformed: Error, CustomStringConvertible {
        let description: String
    }

    var fields: [String: String] = [:]
    /// The `file` part, as a byte range of the body file.
    var file: (filename: String?, range: Range<Int>)?

    static func boundary(contentType: String?) -> String? {
        guard let contentType, contentType.lowercased().hasPrefix("multipart/form-data") else { return nil }
        for parameter in contentType.split(separator: ";").dropFirst() {
            let pair = parameter.split(separator: "=", maxSplits: 1)
            guard pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "boundary"
            else { continue }
            let value = pair[1].trimmingCharacters(in: .whitespaces)
            return value.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
        return nil
    }

    /// Parses `body` (normally memory-mapped). Text fields are kept up to 1 KiB.
    init(body: Data, boundary: String) throws {
        let delimiter = Data("--\(boundary)".utf8)
        let crlf = Data("\r\n".utf8)
        guard var position = body.range(of: delimiter)?.upperBound else {
            throw Malformed(description: "the body has no multipart boundary")
        }
        while true {
            guard position + 2 <= body.endIndex else { throw Malformed(description: "the body ends early") }
            if body[position..<position + 2] == Data("--".utf8) { return }
            guard body[position..<position + 2] == crlf else { throw Malformed(description: "bad boundary line") }
            position += 2
            guard let headersEnd = body.range(of: HTTPRequestHead.terminator, in: position..<body.endIndex)
            else { throw Malformed(description: "a part has no headers") }
            let headers = String(decoding: body[position..<headersEnd.lowerBound], as: UTF8.self)
            guard let next = body.range(of: crlf + delimiter, in: headersEnd.upperBound..<body.endIndex)
            else { throw Malformed(description: "a part has no closing boundary") }
            let content = headersEnd.upperBound..<next.lowerBound
            position = next.upperBound

            let disposition = Self.disposition(headers)
            guard let name = disposition["name"] else { continue }
            if name == "file" {
                file = (disposition["filename"], content)
            } else if content.count <= 1024 {
                fields[name] = String(decoding: body[content], as: UTF8.self)
            }
        }
    }

    private static func disposition(_ headers: String) -> [String: String] {
        for line in headers.components(separatedBy: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2, parts[0].lowercased() == "content-disposition" else { continue }
            var values: [String: String] = [:]
            for item in parts[1].split(separator: ";").dropFirst() {
                let pair = item.split(separator: "=", maxSplits: 1)
                guard pair.count == 2 else { continue }
                values[pair[0].trimmingCharacters(in: .whitespaces).lowercased()] =
                    pair[1].trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
            }
            return values
        }
        return [:]
    }
}
