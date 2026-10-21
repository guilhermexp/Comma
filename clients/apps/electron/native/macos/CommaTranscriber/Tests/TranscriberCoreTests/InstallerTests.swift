import Foundation
import os
import Testing
@testable import TranscriberCore

/// Writes the requested sample files into the staging folder, optionally
/// corrupted, failing, or stopping until it is cancelled. Records the
/// manifest of each download.
private final class FakeDownloader: ModelDownloading {
    enum Mode { case good, corrupt, networkFailure, waitForCancel }
    let mode: Mode
    let requested = OSAllocatedUnfairLock<[ModelManifest]>(initialState: [])

    init(mode: Mode) { self.mode = mode }

    func download(
        manifest: ModelManifest, into staging: URL, progress: @escaping @Sendable (Int64) -> Void
    ) async throws {
        requested.withLock { $0.append(manifest) }
        switch mode {
        case .good:
            progress(3)
            try writeSampleModel(to: staging, manifest: manifest)
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
    let components = OSAllocatedUnfairLock<[Set<ModelComponent>]>(initialState: [])
    let failure: (any Error)?

    init(failure: (any Error)? = nil) { self.failure = failure }

    func prepare(installed: URL, components: Set<ModelComponent>) async throws {
        prepared.withLock { $0.append(installed) }
        self.components.withLock { $0.append(components) }
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
    platform: PlatformSupport = supported, components: Set<ModelComponent> = [.asr, .diarization],
    downloader: FakeDownloader? = nil
) -> Installer {
    Installer(
        store: ModelStore(root: root, manifest: sampleManifest),
        components: components,
        platform: platform,
        downloader: downloader ?? FakeDownloader(mode: mode),
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

@Test func installingOnlyDiarizationLeavesTheRecognizerOut() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let downloader = FakeDownloader(mode: .good)
    let preparer = RecordingPreparer()
    let log = EventLog()

    let result = await makeInstaller(
        root, .good, preparer: preparer, components: [.diarization], downloader: downloader
    ).install(emit: log.append)

    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(result == .ok)
    #expect(store.isInstalled(.diarization))
    #expect(!store.isInstalled(.asr))
    #expect(!store.isInstalled)
    #expect(downloader.requested.withLock { $0.map { $0.files.map(\.path) } } == [
        ["diar/Segmentation.mlmodelc/model.mil"]
    ])
    #expect(!FileManager.default.fileExists(atPath: store.installedURL.appendingPathComponent("asr").path))
    #expect(preparer.components.withLock { $0 } == [[.diarization]])
    // Progress counts the component, not the whole manifest.
    #expect(log.all.contains(.downloading(bytes: 3, totalBytes: sampleManifest.bytes(of: .diarization))))
}

@Test func installingTheRecognizerLaterKeepsTheSeparator() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(await makeInstaller(root, .good, components: [.diarization]).install(emit: { _ in }) == .ok)
    let separator = store.installedURL.appendingPathComponent("diar/Segmentation.mlmodelc/model.mil")
    let separatorInode = try FileManager.default.attributesOfItem(atPath: separator.path)[.systemFileNumber] as? Int

    let downloader = FakeDownloader(mode: .good)
    let result = await makeInstaller(root, .good, components: [.asr, .diarization], downloader: downloader)
        .install(emit: { _ in })

    #expect(result == .ok)
    #expect(store.isInstalled(.asr) && store.isInstalled(.diarization) && store.isInstalled)
    // Only the missing component was downloaded; the separator was not replaced.
    #expect(downloader.requested.withLock { $0.map { Set($0.components.keys) } } == [[.asr]])
    #expect(try FileManager.default.attributesOfItem(atPath: separator.path)[.systemFileNumber] as? Int == separatorInode)
    #expect(contents(root) == [sampleManifest.id])
}

@Test func aFailedRecognizerInstallKeepsTheSeparator() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(await makeInstaller(root, .good, components: [.diarization]).install(emit: { _ in }) == .ok)

    let result = await makeInstaller(root, .corrupt, components: [.asr]).install(emit: { _ in })

    guard case .failed(.checksumMismatch, _) = result else {
        Issue.record("unexpected \(result)")
        return
    }
    #expect(store.isInstalled(.diarization))
    #expect(!store.isInstalled(.asr))
    #expect(!FileManager.default.fileExists(atPath: store.installedURL.appendingPathComponent("asr").path))
}

@Test func removingTheRecognizerKeepsTheSeparator() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(await makeInstaller(root, .good).install(emit: { _ in }) == .ok)

    try store.remove([.asr])
    try store.remove([.asr])

    #expect(!store.isInstalled(.asr))
    #expect(store.isInstalled(.diarization))
    #expect(!FileManager.default.fileExists(atPath: store.installedURL.appendingPathComponent("asr").path))
    #expect(FileManager.default.fileExists(
        atPath: store.installedURL.appendingPathComponent("diar/Segmentation.mlmodelc/model.mil").path))
}

@Test func aTreeFromBeforeComponentsCountsAsBoth() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ModelStore(root: root, manifest: sampleManifest)
    // The previous helper renamed a verified tree without markers.
    try writeSampleModel(to: store.installedURL)

    #expect(store.isInstalled(.asr) && store.isInstalled(.diarization) && store.isInstalled)
    let status = Status.current(store: store, platform: supported)
    #expect(status.components == [.asr: true, .diarization: true])

    try store.remove([.asr])
    #expect(!store.isInstalled(.asr))
    #expect(store.isInstalled(.diarization))
}

@Test func aComponentFolderWithoutItsMarkerIsNotInstalled() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let store = ModelStore(root: root, manifest: sampleManifest)
    #expect(await makeInstaller(root, .good, components: [.diarization]).install(emit: { _ in }) == .ok)
    // A later install was killed after moving the folder in, before its marker.
    try writeSampleModel(to: store.installedURL, manifest: sampleManifest.subset([.asr]))

    #expect(!store.isInstalled(.asr))
    #expect(await makeInstaller(root, .good, components: [.asr]).install(emit: { _ in }) == .ok)
    #expect(store.isInstalled(.asr) && store.isInstalled(.diarization))
}

@Test func statusReportsComponentsAndTheirSizes() async throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    #expect(await makeInstaller(root, .good, components: [.diarization]).install(emit: { _ in }) == .ok)

    let status = Status.current(store: ModelStore(root: root, manifest: sampleManifest), platform: supported)
    let line = try #require(JSONSerialization.jsonObject(with: Data(status.jsonLine.utf8)) as? NSDictionary)

    #expect(line == [
        "type": "status", "supported": true, "reason": NSNull(), "installed": false,
        "downloadBytes": sampleManifest.totalBytes,
        "components": ["asr": false, "diarization": true],
        "componentBytes": ["asr": 9, "diarization": 3],
    ])
}

@Test func linesFollowTheHelperContract() throws {
    func object(_ line: String) throws -> NSDictionary {
        try #require(JSONSerialization.jsonObject(with: Data(line.utf8)) as? NSDictionary)
    }
    let status = Status(
        supported: false, reason: .unsupportedOS, components: [.asr: false, .diarization: false],
        componentBytes: [.asr: 6, .diarization: 3])

    #expect(try object(status.jsonLine) == [
        "type": "status", "supported": false, "reason": "unsupported_os",
        "installed": false, "downloadBytes": 9,
        "components": ["asr": false, "diarization": false], "componentBytes": ["asr": 6, "diarization": 3],
    ])
    let installed = Status(
        supported: true, reason: nil, components: [.asr: true, .diarization: true],
        componentBytes: [.asr: 6, .diarization: 3])
    #expect(try object(installed.jsonLine)["reason"] is NSNull)
    #expect(try object(installed.jsonLine)["installed"] as? Bool == true)
    #expect(try object(InstallEvent.downloading(bytes: 3, totalBytes: 12).jsonLine) == [
        "type": "progress", "phase": "downloading", "fraction": 0.25, "bytes": 3, "totalBytes": 12,
    ])
    #expect(try object(InstallEvent.preparing.jsonLine) == ["type": "progress", "phase": "preparing"])
    #expect(try object(InstallEvent.result(.ok).jsonLine) == ["type": "result", "ok": true])
    #expect(try object(InstallEvent.result(.failed(.checksumMismatch, "bad")).jsonLine) == [
        "type": "result", "ok": false, "error": ["code": "checksum_mismatch", "message": "bad"],
    ])
}
