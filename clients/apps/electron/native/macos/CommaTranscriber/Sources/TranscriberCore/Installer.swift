import Foundation
import os

/// Downloads the pinned model files into a staging folder.
public protocol ModelDownloading: Sendable {
    func download(manifest: ModelManifest, into staging: URL) async throws
}

/// Loads the installed model once so Core ML compiles it now, not at the
/// first transcription, then releases it.
public protocol ModelPreparing: Sendable {
    func prepare(installed: URL) async throws
}

/// `install` (contract C1): staging, download, manifest check, atomic
/// rename, preparation. Any failure or cancellation removes what it wrote,
/// so the model is installed only after every step succeeded.
public struct Installer: Sendable {
    let store: ModelStore
    let platform: PlatformSupport
    let downloader: any ModelDownloading
    let preparer: any ModelPreparing
    let pollInterval: Duration

    public init(
        store: ModelStore, platform: PlatformSupport, downloader: any ModelDownloading,
        preparer: any ModelPreparing, pollInterval: Duration = .milliseconds(250)
    ) {
        self.store = store
        self.platform = platform
        self.downloader = downloader
        self.preparer = preparer
        self.pollInterval = pollInterval
    }

    /// Emits progress and the final result, and returns the result.
    public func install(emit: @escaping @Sendable (InstallEvent) -> Void) async -> InstallOutcome {
        let outcome = await run(emit: emit)
        emit(.result(outcome))
        return outcome
    }

    private func run(emit: @escaping @Sendable (InstallEvent) -> Void) async -> InstallOutcome {
        if let reason = platform.reason {
            return .failed(.unsupported, "Local transcription needs Apple silicon and macOS 15 (\(reason.rawValue)).")
        }
        if store.isInstalled {
            return .ok
        }

        let staging: URL
        do {
            staging = try store.makeStaging()
        } catch {
            return .failed(.io, error.localizedDescription)
        }
        var committed = false
        defer {
            try? FileManager.default.removeItem(at: staging)
            if !committed { try? FileManager.default.removeItem(at: store.installedURL) }
        }

        let total = store.manifest.totalBytes
        let reported = OSAllocatedUnfairLock<Int64>(initialState: -1)
        let report: @Sendable (Int64) -> Void = { bytes in
            let bytes = min(bytes, total)
            let isNew = reported.withLock { last in
                guard bytes > last else { return false }
                last = bytes
                return true
            }
            if isNew { emit(.downloading(bytes: bytes, totalBytes: total)) }
        }
        let poller = Task { [pollInterval] in
            while !Task.isCancelled {
                report(Self.bytes(under: staging))
                try? await Task.sleep(for: pollInterval)
            }
        }
        do {
            try await downloader.download(manifest: store.manifest, into: staging)
            poller.cancel()
            try Task.checkCancellation()
        } catch {
            poller.cancel()
            return Self.failure(error, else: .network)
        }
        report(total)

        do {
            try ManifestVerifier.verify(staging, against: store.manifest)
        } catch let failure as ManifestVerifier.Failure {
            return .failed(.checksumMismatch, failure.description)
        } catch {
            return .failed(.io, error.localizedDescription)
        }

        do {
            try Task.checkCancellation()
            try store.commit(staging)
            emit(.preparing)
            try await preparer.prepare(installed: store.installedURL)
            try Task.checkCancellation()
        } catch {
            return Self.failure(error, else: .io)
        }
        committed = true
        return .ok
    }

    private static func failure(_ error: any Error, else code: InstallErrorCode) -> InstallOutcome {
        if error is CancellationError || Task.isCancelled {
            return .failed(.cancelled, "The installation was cancelled.")
        }
        return .failed(code, error.localizedDescription)
    }

    static func bytes(under root: URL) -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey])
        else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            if values?.isRegularFile == true { total += Int64(values?.fileSize ?? 0) }
        }
        return total
    }
}
