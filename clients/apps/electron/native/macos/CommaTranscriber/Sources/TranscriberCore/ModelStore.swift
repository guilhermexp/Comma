import Foundation

/// The models directory (`~/Library/Application Support/Comma/Models` by
/// default). Only a verified tree renamed to `<manifest id>` is installed;
/// downloads happen in `.staging-<uuid>` beside it.
///
/// Each component in the tree has a marker, `.installed-<component>`, written
/// only after its files are in place (openspec add-cloud-meeting-asr, D3). A
/// tree without any marker comes from the helper before components and
/// holds both.
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

    static func markerName(_ component: ModelComponent) -> String { ".installed-\(component.rawValue)" }

    private func marker(_ component: ModelComponent, in tree: URL) -> URL {
        tree.appendingPathComponent(Self.markerName(component))
    }

    private var treeExists: Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: installedURL.path, isDirectory: &isDirectory)
            && isDirectory.boolValue
    }

    public var installedComponents: Set<ModelComponent> {
        guard treeExists else { return [] }
        let marked = ModelComponent.all.filter {
            FileManager.default.fileExists(atPath: marker($0, in: installedURL).path)
        }
        return marked.isEmpty ? ModelComponent.all : marked
    }

    public func isInstalled(_ component: ModelComponent) -> Bool { installedComponents.contains(component) }

    /// Both components: what local transcription needs (C1 `installed`).
    public var isInstalled: Bool { installedComponents == ModelComponent.all }

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

    /// Makes the verified `components` in `staging` installed. A new tree is
    /// renamed whole, markers included. Into an existing tree, each folder is
    /// renamed in, then its marker, so an interruption leaves the component
    /// not installed.
    func commit(_ staging: URL, components: Set<ModelComponent>) throws {
        let fm = FileManager.default
        for component in components {
            try Data().write(to: marker(component, in: staging))
        }
        guard treeExists else {
            try Self.rename(staging, installedURL)
            return
        }
        for component in components.sorted() {
            for folder in manifest.components[component] ?? [] {
                let target = installedURL.appendingPathComponent(folder, isDirectory: true)
                if fm.fileExists(atPath: target.path) { try fm.removeItem(at: target) }
                try Self.rename(staging.appendingPathComponent(folder, isDirectory: true), target)
            }
            try Self.rename(marker(component, in: staging), marker(component, in: installedURL))
        }
    }

    /// Removes `components`; removing every component deletes the models
    /// folder. The tree is renamed away before it is deleted, so an
    /// interrupted removal never looks like a tree from before components.
    public func remove(_ components: Set<ModelComponent> = ModelComponent.all) throws {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else { return }
        let remaining = installedComponents.subtracting(components)
        guard !remaining.isEmpty, components != ModelComponent.all else {
            if treeExists {
                try Self.rename(installedURL, root.appendingPathComponent(".removing-\(UUID().uuidString)"))
            }
            if components == ModelComponent.all {
                try fm.removeItem(at: root)
            } else {
                for name in try fm.contentsOfDirectory(atPath: root.path) where name.hasPrefix(".removing-") {
                    try fm.removeItem(at: root.appendingPathComponent(name))
                }
            }
            return
        }
        // A tree from before components gets markers for what stays first.
        for component in remaining where !fm.fileExists(atPath: marker(component, in: installedURL).path) {
            try Data().write(to: marker(component, in: installedURL))
        }
        for component in components {
            let url = marker(component, in: installedURL)
            if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            for folder in manifest.components[component] ?? [] {
                let url = installedURL.appendingPathComponent(folder, isDirectory: true)
                if fm.fileExists(atPath: url.path) { try fm.removeItem(at: url) }
            }
        }
    }

    private static func rename(_ source: URL, _ destination: URL) throws {
        if Darwin.rename(source.path, destination.path) != 0 {
            throw CocoaError(.fileWriteUnknown, userInfo: [
                NSLocalizedDescriptionKey: "rename failed: \(String(cString: strerror(errno)))"
            ])
        }
    }
}
