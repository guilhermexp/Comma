import Foundation

/// Lines the non-`serve` subcommands write to stdout, one JSON object each
/// (design contracts C1 and C5).
public struct Status: Sendable, Equatable {
    public let supported: Bool
    public let reason: PlatformSupport.Reason?
    public let components: [ModelComponent: Bool]
    public let componentBytes: [ModelComponent: Int64]

    public init(
        supported: Bool, reason: PlatformSupport.Reason?, components: [ModelComponent: Bool],
        componentBytes: [ModelComponent: Int64]
    ) {
        self.supported = supported
        self.reason = reason
        self.components = components
        self.componentBytes = componentBytes
    }

    public static func current(store: ModelStore, platform: PlatformSupport) -> Status {
        let installed = store.installedComponents
        return Status(
            supported: platform.reason == nil, reason: platform.reason,
            components: Dictionary(uniqueKeysWithValues: ModelComponent.allCases.map { ($0, installed.contains($0)) }),
            componentBytes: Dictionary(
                uniqueKeysWithValues: ModelComponent.allCases.map { ($0, store.manifest.bytes(of: $0)) }))
    }

    /// Both components, as before components existed.
    public var installed: Bool { ModelComponent.allCases.allSatisfy { components[$0] == true } }
    public var downloadBytes: Int64 { componentBytes.values.reduce(0, +) }

    public var jsonLine: String {
        jsonLineOf([
            "type": "status", "supported": supported, "reason": reason?.rawValue ?? NSNull(),
            "installed": installed, "downloadBytes": downloadBytes,
            "components": Dictionary(uniqueKeysWithValues: components.map { ($0.key.rawValue, $0.value) }),
            "componentBytes": Dictionary(uniqueKeysWithValues: componentBytes.map { ($0.key.rawValue, $0.value) }),
        ])
    }
}

public enum InstallErrorCode: String, Sendable {
    case unsupported
    case network
    case checksumMismatch = "checksum_mismatch"
    case cancelled
    case io
}

public enum InstallOutcome: Sendable, Equatable {
    case ok
    case failed(InstallErrorCode, String)
}

public enum InstallEvent: Sendable, Equatable {
    case downloading(bytes: Int64, totalBytes: Int64)
    case preparing
    case result(InstallOutcome)

    public var jsonLine: String {
        switch self {
        case .downloading(let bytes, let total):
            jsonLineOf([
                "type": "progress", "phase": "downloading",
                "fraction": total > 0 ? Double(bytes) / Double(total) : 0,
                "bytes": bytes, "totalBytes": total,
            ])
        case .preparing:
            jsonLineOf(["type": "progress", "phase": "preparing"])
        case .result(.ok):
            jsonLineOf(["type": "result", "ok": true])
        case .result(.failed(let code, let message)):
            jsonLineOf([
                "type": "result", "ok": false,
                "error": ["code": code.rawValue, "message": message],
            ])
        }
    }
}

func jsonLineOf(_ object: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    return String(decoding: data, as: UTF8.self)
}
