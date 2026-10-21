import CryptoKit
import Foundation
import Testing
@testable import TranscriberCore

func sha256Hex(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
}

func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("comma-transcriber-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func write(_ text: String, to root: URL, _ path: String) throws {
    let url = root.appendingPathComponent(path)
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
}

let sampleContents = [
    "asr/Model.mlmodelc/weights/weight.bin": "weights",
    "asr/vocab.json": "{}",
    "diar/Segmentation.mlmodelc/model.mil": "mil",
]

/// Two components: `asr` in folder `asr`, `diarization` in folder `diar`.
let sampleManifest = ModelManifest(
    id: "sample@1",
    repos: [
        .init(repo: "Org/parakeet-tdt-0.6b-v3-coreml", revision: "1", folder: "asr", variant: "v2"),
        .init(repo: "Org/speaker-diarization-coreml", revision: "1", folder: "diar", variant: "offline"),
    ],
    components: [.asr: ["asr"], .diarization: ["diar"]],
    files: sampleContents.keys.sorted().map {
        .init(path: $0, size: Int64(sampleContents[$0]!.utf8.count), sha256: sha256Hex(sampleContents[$0]!))
    }
)

/// Writes the files of `manifest` (the whole sample by default).
func writeSampleModel(to root: URL, manifest: ModelManifest = sampleManifest) throws {
    for file in manifest.files {
        try write(sampleContents[file.path]!, to: root, file.path)
    }
}

@Test func matchingFilesVerify() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeSampleModel(to: root)

    try ManifestVerifier.verify(root, against: sampleManifest)
}

@Test func aDifferentHashInvalidatesTheInstall() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeSampleModel(to: root)
    try write("WEIGHTS", to: root, "asr/Model.mlmodelc/weights/weight.bin")

    #expect(throws: ManifestVerifier.Failure.checksumMismatch("asr/Model.mlmodelc/weights/weight.bin")) {
        try ManifestVerifier.verify(root, against: sampleManifest)
    }
}

@Test func aDifferentSizeInvalidatesTheInstall() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeSampleModel(to: root)
    try write("{ }", to: root, "asr/vocab.json")

    #expect(throws: ManifestVerifier.Failure.sizeMismatch("asr/vocab.json", expected: 2, actual: 3)) {
        try ManifestVerifier.verify(root, against: sampleManifest)
    }
}

@Test func aMissingFileInvalidatesTheInstall() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeSampleModel(to: root)
    try FileManager.default.removeItem(at: root.appendingPathComponent("asr/vocab.json"))

    #expect(throws: ManifestVerifier.Failure.missing("asr/vocab.json")) {
        try ManifestVerifier.verify(root, against: sampleManifest)
    }
}

@Test func filesOutsideTheManifestAreRemoved() throws {
    let root = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeSampleModel(to: root)
    try write("{}", to: root, "asr/config.json")
    try write("partial", to: root, "asr/Model.mlmodelc/weights/weight.bin.partial")
    try write("x", to: root, "unused/Other.mlmodelc/model.mil")
    try FileManager.default.createSymbolicLink(
        at: root.appendingPathComponent("asr/link.json"),
        withDestinationURL: root.appendingPathComponent("asr/vocab.json"))

    try ManifestVerifier.verify(root, against: sampleManifest)

    let remaining = try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted()
    #expect(remaining == [
        "asr",
        "asr/Model.mlmodelc",
        "asr/Model.mlmodelc/weights",
        "asr/Model.mlmodelc/weights/weight.bin",
        "asr/vocab.json",
        "diar",
        "diar/Segmentation.mlmodelc",
        "diar/Segmentation.mlmodelc/model.mil",
    ])
}

@Test func aSymlinkInPlaceOfAManifestFileIsRejected() throws {
    let root = try temporaryDirectory()
    let outside = try temporaryDirectory()
    defer {
        try? FileManager.default.removeItem(at: root)
        try? FileManager.default.removeItem(at: outside)
    }
    try writeSampleModel(to: root)
    try write("{}", to: outside, "vocab.json")
    try FileManager.default.removeItem(at: root.appendingPathComponent("asr/vocab.json"))
    try FileManager.default.createSymbolicLink(
        at: root.appendingPathComponent("asr/vocab.json"),
        withDestinationURL: outside.appendingPathComponent("vocab.json"))

    #expect(throws: ManifestVerifier.Failure.missing("asr/vocab.json")) {
        try ManifestVerifier.verify(root, against: sampleManifest)
    }
}

@Test func theBundledManifestCoversBothPinnedRepositories() throws {
    let manifest = try ModelManifest.bundled()
    #expect(manifest.files.count > 0)
    #expect(manifest.totalBytes == manifest.files.reduce(0) { $0 + $1.size })
    #expect(Set(manifest.repos.map(\.folder)) == ["parakeet-tdt-0.6b-v3", "speaker-diarization"])
    #expect(manifest.components == [.asr: ["parakeet-tdt-0.6b-v3"], .diarization: ["speaker-diarization"]])
    // Every file belongs to exactly one component.
    #expect(manifest.subset([.asr]).files.count + manifest.subset([.diarization]).files.count == manifest.files.count)
    #expect(manifest.bytes(of: .diarization) < 30_000_000)
}

@Test func aComponentSubsetKeepsOnlyItsFolders() {
    let diarization = sampleManifest.subset([.diarization])
    #expect(diarization.id == sampleManifest.id)
    #expect(diarization.files.map(\.path) == ["diar/Segmentation.mlmodelc/model.mil"])
    #expect(diarization.components == [.diarization: ["diar"]])
    #expect(sampleManifest.bytes(of: .asr) == 9)
    #expect(sampleManifest.subset([.asr, .diarization]) == sampleManifest)
}
