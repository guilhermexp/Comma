import CryptoKit
import Foundation

/// Checks a downloaded model tree against the manifest before it can become
/// the installed model. FluidAudio checks only sizes on download.
public enum ManifestVerifier {
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case missing(String)
        case sizeMismatch(String, expected: Int64, actual: Int64)
        case checksumMismatch(String)

        public var description: String {
            switch self {
            case .missing(let path):
                "\(path) is missing"
            case .sizeMismatch(let path, let expected, let actual):
                "\(path) is \(actual) bytes, expected \(expected)"
            case .checksumMismatch(let path):
                "\(path) does not match its SHA-256"
            }
        }
    }

    /// Removes every entry the manifest does not name (extra SDK files,
    /// partial downloads, links), then checks the size and SHA-256 of each
    /// manifest file. Throws on the first difference.
    public static func verify(_ root: URL, against manifest: ModelManifest) throws {
        try removeEntries(notIn: manifest, under: root)
        for file in manifest.files {
            let url = root.appendingPathComponent(file.path)
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                attributes[.type] as? FileAttributeType == .typeRegular
            else {
                throw Failure.missing(file.path)
            }
            let size = (attributes[.size] as? NSNumber)?.int64Value ?? -1
            guard size == file.size else {
                throw Failure.sizeMismatch(file.path, expected: file.size, actual: size)
            }
            guard try sha256(of: url) == file.sha256 else {
                throw Failure.checksumMismatch(file.path)
            }
        }
    }

    static func removeEntries(notIn manifest: ModelManifest, under root: URL) throws {
        let files = Set(manifest.files.map(\.path))
        var directories: Set<String> = []
        for path in files {
            var parent = (path as NSString).deletingLastPathComponent
            while !parent.isEmpty {
                directories.insert(parent)
                parent = (parent as NSString).deletingLastPathComponent
            }
        }
        try prune(root, relative: "", files: files, directories: directories)
    }

    private static func prune(
        _ directory: URL, relative: String, files: Set<String>, directories: Set<String>
    ) throws {
        let fm = FileManager.default
        for name in try fm.contentsOfDirectory(atPath: directory.path) {
            let path = relative.isEmpty ? name : "\(relative)/\(name)"
            let url = directory.appendingPathComponent(name)
            let type = try fm.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType
            if type == .typeDirectory, directories.contains(path) {
                try prune(url, relative: path, files: files, directories: directories)
            } else if type == .typeRegular, files.contains(path) {
                continue
            } else {
                try fm.removeItem(at: url)
            }
        }
    }

    static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
