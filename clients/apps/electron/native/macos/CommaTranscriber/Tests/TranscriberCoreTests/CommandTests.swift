import Foundation
import Testing
@testable import TranscriberCore

@Test func parsesTheHelperSubcommands() throws {
    let models = URL(fileURLWithPath: "/tmp/models")
    #expect(try Command.parse(["status"]) == .status(modelsDir: ModelStore.defaultRoot))
    #expect(try Command.parse(["install", "--models-dir", "/tmp/models"]) == .install(modelsDir: models))
    #expect(try Command.parse(["remove", "--models-dir", "/tmp/models"]) == .remove(modelsDir: models))
    #expect(
        try Command.parse(["serve", "--port", "4321", "--token-file", "/tmp/t", "--models-dir", "/tmp/models"])
            == .serve(port: 4321, tokenFile: URL(fileURLWithPath: "/tmp/t"), modelsDir: models))
}

@Test func rejectsIncompleteOrUnknownArguments() {
    for arguments in [
        [], ["transcribe"], ["serve", "--port", "4321"], ["serve", "--token-file", "/tmp/t"],
        ["serve", "--port", "x", "--token-file", "/tmp/t"], ["status", "--models-dir"], ["status", "--verbose"],
    ] {
        #expect(throws: Command.UsageError.self) { try Command.parse(arguments) }
    }
}
