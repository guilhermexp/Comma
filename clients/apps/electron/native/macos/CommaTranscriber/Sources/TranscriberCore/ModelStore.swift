import Foundation

/// The models directory (`~/Library/Application Support/Comma/Models` by
/// default). Only a verified tree renamed to `<manifest id>` is installed;
/// downloads happen in `.staging-<uuid>` beside it.
public struct ModelStore: Sendable {
    public let root: URL
    public let manifest: ModelManifest

    public init(root: URL, manifest: ModelManifest) {
        self.root = root
        self.manifest = manifest
    }

    public static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Comma/Models", isDirectory: true)
    }

    public var installedURL: URL { root.appendingPathComponent(manifest.id, isDirectory: true) }

    public var isInstalled: Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: installedURL.path, isDirectory: &isDirectory)
            && isDirectory.boolValue
    }

    /// Removes leftovers (interrupted stagings, models of another manifest)
    /// and creates a new, empty staging folder.
    func makeStaging() throws -> URL {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        for name in try fm.contentsOfDirectory(atPath: root.path) where name != manifest.id {
            try fm.removeItem(at: root.appendingPathComponent(name))
        }
        let staging = root.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        return staging
    }

    /// Makes a verified staging folder the installed model in one rename.
    func commit(_ staging: URL) throws {
        if rename(staging.path, installedURL.path) != 0 {
            throw CocoaError(.fileWriteUnknown, userInfo: [
                NSLocalizedDescriptionKey: "rename failed: \(String(cString: strerror(errno)))"
            ])
        }
    }

    public func remove() throws {
        guard FileManager.default.fileExists(atPath: root.path) else { return }
        try FileManager.default.removeItem(at: root)
    }
}
