import Foundation

/// The helper's command line (design contract C1).
public enum Command: Equatable, Sendable {
    case status(modelsDir: URL)
    case install(modelsDir: URL)
    case remove(modelsDir: URL)
    case serve(port: UInt16, tokenFile: URL, modelsDir: URL)

    public struct UsageError: Error, CustomStringConvertible {
        public let description: String
    }

    public static let usage = """
        usage: CommaTranscriber status|install|remove [--models-dir <dir>]
               CommaTranscriber serve --port <port> --token-file <file> [--models-dir <dir>]
        """

    public static func parse(_ arguments: [String]) throws -> Command {
        guard let name = arguments.first else { throw UsageError(description: usage) }
        let allowed: Set<String> = name == "serve" ? ["--models-dir", "--port", "--token-file"] : ["--models-dir"]
        var options: [String: String] = [:]
        var rest = arguments.dropFirst()
        while let flag = rest.popFirst() {
            guard allowed.contains(flag), let value = rest.popFirst() else {
                throw UsageError(description: "unexpected argument \(flag)\n\(usage)")
            }
            options[flag] = value
        }
        let modelsDir = options["--models-dir"].map { URL(fileURLWithPath: $0) } ?? ModelStore.defaultRoot

        switch name {
        case "status": return .status(modelsDir: modelsDir)
        case "install": return .install(modelsDir: modelsDir)
        case "remove": return .remove(modelsDir: modelsDir)
        case "serve":
            guard let port = options["--port"].flatMap(UInt16.init), let tokenFile = options["--token-file"] else {
                throw UsageError(description: "serve needs --port and --token-file\n\(usage)")
            }
            return .serve(port: port, tokenFile: URL(fileURLWithPath: tokenFile), modelsDir: modelsDir)
        default:
            throw UsageError(description: "unknown command \(name)\n\(usage)")
        }
    }
}
