import FluidAudio
import Foundation
import TranscriberCore

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

/// Runs `handler` on SIGTERM and SIGINT instead of the default exit.
func onTermination(_ handler: @escaping @Sendable () -> Void) -> [DispatchSourceSignal] {
    [SIGTERM, SIGINT].map { signalNumber in
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler(handler: handler)
        source.resume()
        return source
    }
}

let command: Command
do {
    command = try Command.parse(Array(CommandLine.arguments.dropFirst()))
} catch {
    fail("\(error)")
}

let manifest: ModelManifest
do {
    manifest = try ModelManifest.bundled()
} catch {
    fail("The bundled model manifest is unreadable: \(error)")
}

switch command {
case .status(let modelsDir):
    emit(Status.current(store: ModelStore(root: modelsDir, manifest: manifest), platform: .current()).jsonLine)

case .install(let modelsDir):
    let installer = Installer(
        store: ModelStore(root: modelsDir, manifest: manifest), platform: .current(),
        downloader: FluidModelDownloader(), preparer: FluidModelPreparer())
    let task = Task { await installer.install(emit: { emit($0.jsonLine) }) }
    let signals = onTermination { task.cancel() }
    let outcome = await task.value
    signals.forEach { $0.cancel() }
    exit(outcome == .ok ? 0 : 1)

case .remove(let modelsDir):
    do {
        try ModelStore(root: modelsDir, manifest: manifest).remove()
        emit(InstallEvent.result(.ok).jsonLine)
    } catch {
        emit(InstallEvent.result(.failed(.io, error.localizedDescription)).jsonLine)
        exit(1)
    }

case .serve(let port, let tokenFile, let modelsDir):
    let token: String
    do {
        token = try String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    } catch {
        fail("Cannot read the token file: \(error.localizedDescription)")
    }
    guard !token.isEmpty else { fail("The token file is empty.") }
    // Serving never downloads: a missing or damaged model is a 409 or 500.
    ModelHub.offlineMode = true
    let server = TranscriptionServer(
        configuration: ServerConfiguration(
            token: token, store: ModelStore(root: modelsDir, manifest: manifest),
            engine: FluidTranscriptionEngine()))
    do {
        let bound = try await server.start(port: port) { error in
            fail("The listener failed: \(error)")
        }
        FileHandle.standardError.write(Data("[CommaTranscriber] listening on 127.0.0.1:\(bound)\n".utf8))
    } catch {
        fail("Cannot listen on 127.0.0.1:\(port): \(error)")
    }
    let signals = onTermination { exit(0) }
    _ = signals
    while true {
        try? await Task.sleep(for: .seconds(3600))
    }
}
