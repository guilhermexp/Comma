import Foundation
import os

/// A failure whose result code is known where it happens, such as a full
/// disk during a download.
public struct InstallFailure: Error {
    public let code: InstallErrorCode
    public let message: String

    public init(_ code: InstallErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

/// Downloads the pinned model files into a staging folder. `progress`
/// takes an estimate of the manifest bytes downloaded so far.
public protocol ModelDownloading: Sendable {
    func download(
        manifest: ModelManifest, into staging: URL, progress: @escaping @Sendable (Int64) -> Void
    ) async throws
}

/// Loads the installed `components` once so Core ML compiles them now, not
/// at the first transcription, then releases them.
public protocol ModelPreparing: Sendable {
    func prepare(installed: URL, components: Set<ModelComponent>) async throws
}

/// `install` (contracts C1 and C5): staging, download, manifest check, atomic
/// rename, preparation, for the selected components that are not installed
/// yet. Any failure or cancellation removes what it wrote, so a component is
/// installed only after every step succeeded; other components stay.
public struct Installer: Sendable {
    let store: ModelStore
    let components: Set<ModelComponent>
    let platform: PlatformSupport
    let downloader: any ModelDownloading
    let preparer: any ModelPreparing
    let pollInterval: Duration

    public init(
        store: ModelStore, components: Set<ModelComponent> = ModelComponent.all, platform: PlatformSupport,
        downloader: any ModelDownloading, preparer: any ModelPreparing, pollInterval: Duration = .milliseconds(250)
    ) {
        self.store = store
        self.components = components
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
        let missing = components.subtracting(store.installedComponents)
        if missing.isEmpty {
            return .ok
        }
        let manifest = store.manifest.subset(missing)

        let staging: URL
        do {
            staging = try store.makeStaging()
        } catch {
            return .failed(.io, error.localizedDescription)
        }
        var committed = false
        defer {
            try? FileManager.default.removeItem(at: staging)
            if !committed { try? store.remove(missing) }
        }

        let total = manifest.totalBytes
        let reported = OSAllocatedUnfairLock<Int64>(initialState: -1)
        // One line per 0.1 %, plus the final total.
        let step = max(1, total / 1000)
        let report: @Sendable (Int64) -> Void = { bytes in
            let bytes = min(bytes, total)
            let isNew = reported.withLock { last in
                guard bytes > last, last < 0 || bytes - last >= step || bytes == total else { return false }
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
            // Files appear in staging only once complete; the downloader
            // also reports bytes within a file.
            try await downloader.download(manifest: manifest, into: staging, progress: report)
            poller.cancel()
            try Task.checkCancellation()
        } catch {
            poller.cancel()
            return Self.failure(error, else: .network)
        }
        report(total)

        do {
            try ManifestVerifier.verify(staging, against: manifest)
        } catch let failure as ManifestVerifier.Failure {
            return .failed(.checksumMismatch, failure.description)
        } catch {
            return .failed(.io, error.localizedDescription)
        }

        do {
            try Task.checkCancellation()
            try store.commit(staging, components: missing)
            emit(.preparing)
            try await preparer.prepare(installed: store.installedURL, components: missing)
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
        if let failure = error as? InstallFailure {
            return .failed(failure.code, failure.message)
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
