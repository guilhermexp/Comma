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

let sampleManifest = ModelManifest(
    id: "sample@1",
    repos: [],
    files: [
        .init(path: "asr/Model.mlmodelc/weights/weight.bin", size: 7, sha256: sha256Hex("weights")),
        .init(path: "asr/vocab.json", size: 2, sha256: sha256Hex("{}")),
    ]
)

func writeSampleModel(to root: URL) throws {
    try write("weights", to: root, "asr/Model.mlmodelc/weights/weight.bin")
    try write("{}", to: root, "asr/vocab.json")
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
}
