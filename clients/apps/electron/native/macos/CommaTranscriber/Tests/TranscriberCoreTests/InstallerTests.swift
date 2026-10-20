import Foundation
import os
import Testing
@testable import TranscriberCore

/// Writes the sample model into the staging folder, optionally corrupted,
/// failing, or stopping until it is cancelled.
private struct FakeDownloader: ModelDownloading {
    enum Mode { case good, corrupt, networkFailure, waitForCancel }
    let mode: Mode

    func download(manifest: ModelManifest, into staging: URL) async throws {
        switch mode {
        case .good:
            try writeSampleModel(to: staging)
            try write("{}", to: staging, "asr/config.json")
        case .corrupt:
            try writeSampleModel(to: staging)
            try write("WEIGHTS", to: staging, "asr/Model.mlmodelc/weights/weight.bin")
        case .networkFailure:
            try write("wei", to: staging, "asr/Model.mlmodelc/weights/weight.bin")
            throw URLError(.notConnectedToInternet)
        case .waitForCancel:
            try write("wei", to: staging, "asr/Model.mlmodelc/weights/weight.bin")
            while true {
                try await Task.sleep(for: .milliseconds(5))
            }
        }
    }
}

private final class RecordingPreparer: ModelPreparing {
    let prepared = OSAllocatedUnfairLock<[URL]>(initialState: [])
    let failure: (any Error)?

    init(failure: (any Error)? = nil) { self.failure = failure }

    func prepare(installed: URL) async throws {
        prepared.withLock { $0.append(installed) }
        if let failure { throw failure }
    }
}

private final class EventLog: Sendable {
    let events = OSAllocatedUnfairLock<[InstallEvent]>(initialState: [])
    func append(_ event: InstallEvent) { events.withLock { $0.append(event) } }
    var all: [InstallEvent] { events.withLock { $0 } }
}

private let supported = PlatformSupport(isAppleSilicon: true, osMajorVersion: 15)

private func makeInstaller(
    _ root: URL, _ mode: FakeDownloader.Mode, preparer: RecordingPreparer = RecordingPreparer(),
    platform: PlatformSupport = supported
) -> Installer {
    Installer(
        store: ModelStore(root: root, manifest: sampleManifest),
        platform: platform,
        downloader: FakeDownloader(mode: mode),
        preparer: preparer,
        pollInterval: .milliseconds(1)
    )
}

private func contents(_ root: URL) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).sorted()
}

@Test func installDownloadsVerifiesRenamesAndPrepares() async throws {
    let parent = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let root = parent.appendingPathComponent("Models")
    let preparer = RecordingPreparer()
    let log = EventLog()

    let result = await makeInstaller(root, .good, preparer: preparer).install(emit: log.append)

    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(result == .ok)
    #expect(store.isInstalled)
    #expect(contents(root) == [sampleManifest.id])
    #expect(preparer.prepared.withLock { $0 } == [store.installedURL])
    let events = log.all
    #expect(events.last == .result(.ok))
    #expect(events.dropLast().last == .preparing)
    let downloading = events.compactMap { event -> Int64? in
        if case .downloading(let bytes, _) = event { return bytes }
        return nil
    }
    #expect(downloading.last == sampleManifest.totalBytes)
    #expect(downloading == downloading.sorted())
    #expect(!FileManager.default.fileExists(
        atPath: store.installedURL.appendingPathComponent("asr/config.json").path))
}

@Test func aChecksumMismatchLeavesNothingInstalled() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let preparer = RecordingPreparer()

    let result = await makeInstaller(root, .corrupt, preparer: preparer).install(emit: { _ in })

    guard case .failed(.checksumMismatch, _) = result else {
        Issue.record("unexpected \(result)")
        return
    }
    #expect(!ModelStore(root: root, manifest: sampleManifest).isInstalled)
    #expect(contents(root).isEmpty)
    #expect(preparer.prepared.withLock { $0 }.isEmpty)
}

@Test func aNetworkFailureRemovesThePartialDownload() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }

    let result = await makeInstaller(root, .networkFailure).install(emit: { _ in })

    guard case .failed(.network, _) = result else {
        Issue.record("unexpected \(result)")
        return
    }
    #expect(contents(root).isEmpty)
}

@Test func cancellingRemovesStagingAndReportsCancelled() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let installer = makeInstaller(root, .waitForCancel)

    let task = Task { await installer.install(emit: { _ in }) }
    while !contents(root).contains(where: { $0.hasPrefix(".staging-") }) {
        try await Task.sleep(for: .milliseconds(1))
    }
    task.cancel()
    let result = await task.value

    guard case .failed(.cancelled, _) = result else {
        Issue.record("unexpected \(result)")
        return
    }
    #expect(contents(root).isEmpty)
}

@Test func anInterruptedStagingIsNeverReady() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    // A previous install was killed after downloading every file.
    let staging = root.appendingPathComponent(".staging-\(UUID().uuidString)")
    try writeSampleModel(to: staging)
    let store = ModelStore(root: root, manifest: sampleManifest)

    #expect(!store.isInstalled)
    #expect(Status.current(store: store, platform: supported).installed == false)

    let result = await makeInstaller(root, .good).install(emit: { _ in })
    #expect(result == .ok)
    #expect(contents(root) == [sampleManifest.id])
}

@Test func aFailedPreparationDoesNotLeaveTheModelInstalled() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let preparer = RecordingPreparer(failure: CocoaError(.fileReadCorruptFile))

    let result = await makeInstaller(root, .good, preparer: preparer).install(emit: { _ in })

    guard case .failed(.io, _) = result else {
        Issue.record("unexpected \(result)")
        return
    }
    #expect(contents(root).isEmpty)
}

@Test func anUnsupportedMachineDoesNotDownload() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let intel = PlatformSupport(isAppleSilicon: false, osMajorVersion: 15)
    let sonoma = PlatformSupport(isAppleSilicon: true, osMajorVersion: 14)

    #expect(intel.reason == .unsupportedCPU)
    #expect(sonoma.reason == .unsupportedOS)
    #expect(supported.reason == nil)
    for platform in [intel, sonoma] {
        let result = await makeInstaller(root, .good, platform: platform).install(emit: { _ in })
        guard case .failed(.unsupported, _) = result else {
            Issue.record("unexpected \(result)")
            continue
        }
    }
    #expect(contents(root).isEmpty)
}

@Test func removeDeletesTheModelsFolder() async throws {
    let parent = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: parent) }
    let root = parent.appendingPathComponent("Models")
    #expect(await makeInstaller(root, .good).install(emit: { _ in }) == .ok)
    let store = ModelStore(root: root, manifest: sampleManifest)

    try store.remove()
    try store.remove()

    #expect(!FileManager.default.fileExists(atPath: root.path))
    #expect(!store.isInstalled)
}

@Test func linesFollowTheHelperContract() throws {
    func object(_ line: String) throws -> NSDictionary {
        try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? NSDictionary)
    }
    let status = Status(supported: false, reason: .unsupportedOS, installed: false, downloadBytes: 9)

    #expect(try object(status.jsonLine) == [
        "type": "status", "supported": false, "reason": "unsupported_os",
        "installed": false, "downloadBytes": 9,
    ])
    #expect(try object(Status(supported: true, reason: nil, installed: true, downloadBytes: 9).jsonLine)["reason"]
        is NSNull)
    #expect(try object(InstallEvent.downloading(bytes: 3, totalBytes: 12).jsonLine) == [
        "type": "progress", "phase": "downloading", "fraction": 0.25, "bytes": 3, "totalBytes": 12,
    ])
    #expect(try object(InstallEvent.preparing.jsonLine) == ["type": "progress", "phase": "preparing"])
    #expect(try object(InstallEvent.result(.ok).jsonLine) == ["type": "result", "ok": true])
    #expect(try object(InstallEvent.result(.failed(.checksumMismatch, "bad")).jsonLine) == [
        "type": "result", "ok": false, "error": ["code": "checksum_mismatch", "message": "bad"],
    ])
}
