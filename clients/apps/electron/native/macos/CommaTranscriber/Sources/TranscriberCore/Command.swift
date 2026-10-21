import Foundation

/// The helper's command line (design contracts C1 and C5).
public enum Command: Equatable, Sendable {
    case status(modelsDir: URL)
    case install(modelsDir: URL, components: Set<ModelComponent>)
    case remove(modelsDir: URL, components: Set<ModelComponent>)
    case serve(port: UInt16, tokenFile: URL, modelsDir: URL)

    public struct UsageError: Error, CustomStringConvertible {
        public let description: String
    }

    public static let usage = """
        usage: CommaTranscriber status [--models-dir <dir>]
               CommaTranscriber install [--component asr|diarization|all] [--models-dir <dir>]
               CommaTranscriber remove [--component asr|all] [--models-dir <dir>]
               CommaTranscriber serve --port <port> --token-file <file> [--models-dir <dir>]
        """

    public static func parse(_ arguments: [String]) throws -> Command {
        guard let name = arguments.first else { throw UsageError(description: usage) }
        let allowed: Set<String> =
            switch name {
            case "serve": ["--models-dir", "--port", "--token-file"]
            case "install", "remove": ["--models-dir", "--component"]
            default: ["--models-dir"]
            }
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
        case "install", "remove":
            // The separator goes only with everything (D3).
            let choices: [String: Set<ModelComponent>] =
                name == "install"
                ? ["all": ModelComponent.all, "asr": [.asr], "diarization": [.diarization]]
                : ["all": ModelComponent.all, "asr": [.asr]]
            guard let components = choices[options["--component"] ?? "all"] else {
                throw UsageError(description: "unknown component \(options["--component"] ?? "")\n\(usage)")
            }
            return name == "install"
                ? .install(modelsDir: modelsDir, components: components)
                : .remove(modelsDir: modelsDir, components: components)
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
