import Foundation

/// Local transcription runs only on Apple silicon with macOS 15 or later:
/// FluidAudio's offline diarizer crashes on macOS 14 (issue #878).
public struct PlatformSupport: Sendable, Equatable {
    public enum Reason: String, Sendable, Encodable {
        case unsupportedCPU = "unsupported_cpu"
        case unsupportedOS = "unsupported_os"
    }

    public let isAppleSilicon: Bool
    public let osMajorVersion: Int

    public init(isAppleSilicon: Bool, osMajorVersion: Int) {
        self.isAppleSilicon = isAppleSilicon
        self.osMajorVersion = osMajorVersion
    }

    public var reason: Reason? {
        if !isAppleSilicon { return .unsupportedCPU }
        if osMajorVersion < 15 { return .unsupportedOS }
        return nil
    }

    public static func current() -> PlatformSupport {
        // True for Apple silicon hardware, also under Rosetta.
        var arm64: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let found = sysctlbyname("hw.optional.arm64", &arm64, &size, nil, 0) == 0
        return PlatformSupport(
            isAppleSilicon: found && arm64 == 1,
            osMajorVersion: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    }
}
