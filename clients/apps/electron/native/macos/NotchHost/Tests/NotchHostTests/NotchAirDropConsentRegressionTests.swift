import XCTest
@testable import NotchHost

@MainActor
final class NotchAirDropConsentRegressionTests: XCTestCase {
    private func autoOpenedAirDropRequestID(of host: NotchHost) -> String? {
        let mirror = Mirror(reflecting: host)
        for child in mirror.children where child.label == "autoOpenedAirDropRequestID" || child.label == "_autoOpenedAirDropRequestID" {
            if let str = child.value as? String {
                return str
            }
            let childMirror = Mirror(reflecting: child.value)
            if childMirror.displayStyle == .optional {
                return childMirror.children.first?.value as? String
            }
        }
        return nil
    }

    private func isNotchExpanded(host: NotchHost) -> Bool {
        let hostMirror = Mirror(reflecting: host)
        guard let controller = hostMirror.children.first(where: { $0.label == "controller" })?.value else {
            return false
        }
        let controllerMirror = Mirror(reflecting: controller)
        guard let runtimeModel = controllerMirror.children.first(where: { $0.label == "runtimeModel" })?.value else {
            return false
        }
        let modelMirror = Mirror(reflecting: runtimeModel)
        for child in modelMirror.children where child.label == "_presentationState" || child.label == "presentationState" {
            let desc = String(describing: child.value)
            if desc == "expanded" || desc.contains("expanded") {
                return true
            }
        }
        return false
    }

    func testAirDropOfferDuringActiveVoiceReopensConsentOnVoiceClear() {
        let host = NotchHost()

        // 1. Active voice turn begins (e.g. push-to-talk listening)
        let voiceTurn = CommaNotchScenePayloadVoiceTurn(
            action: nil,
            level: 0.5,
            message: "Listening",
            state: .listening
        )
        host.handle(HostCommand(
            id: "1",
            method: "update",
            payload: CommaNotchScenePayload(
                voice: CommaNotchScenePayloadVoice(turn: voiceTurn)
            )
        ))

        // 2. AirDrop offer arrives while voice turn is active
        let transfer = CommaNotchScenePayloadAirDropTransfer(
            acceptLabel: "Accept",
            declineLabel: "Decline",
            phase: .offer,
            preview: nil,
            progress: nil,
            requestId: "airdrop-req-1",
            subtitle: nil,
            title: "SharedFile.pdf"
        )
        host.handle(HostCommand(
            id: "2",
            method: "update",
            payload: CommaNotchScenePayload(
                airDrop: CommaNotchScenePayloadAirDrop(transfer: transfer)
            )
        ))

        // While voice is active, AirDrop consent is held back
        XCTAssertNil(autoOpenedAirDropRequestID(of: host))
        XCTAssertFalse(isNotchExpanded(host: host))

        // 3. Clear voice turn ({ voice: {} } where turn is nil)
        host.handle(HostCommand(
            id: "3",
            method: "update",
            payload: CommaNotchScenePayload(
                voice: CommaNotchScenePayloadVoice(turn: nil)
            )
        ))

        // Once voice clears, consent must open for the pending AirDrop offer
        XCTAssertEqual(autoOpenedAirDropRequestID(of: host), "airdrop-req-1")
        XCTAssertTrue(isNotchExpanded(host: host))
    }
}
