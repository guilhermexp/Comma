import AppKit
import Foundation

/// Owns the newline-delimited transport between Electron Main and the native
/// gesture helper. Every cross-runtime frame uses the generated Codable
/// contract; the local presentation value is mapped only at this boundary.
@MainActor
final class SideChatCommandServer {
    private weak var controller: EdgeChatController?
    private var readTask: Task<Void, Never>?
    private lazy var statusMenu = StatusMenuController { [weak self] id in
        self?.emit(.statusMenuSelect(requestId: UUID().uuidString, id: id))
    }
    /// Hold-to-talk chord. It is independent of the Side Chat hotkey and of
    /// `side-chat.enabled`: Main decides when it is registered.
    private var pushToTalkHotKey: GlobalHotKey?
    private var pushToTalkBinding: (keyCode: UInt32, modifiers: UInt32)?
    private var isPushToTalkHeld = false

    init(controller: EdgeChatController) {
        self.controller = controller
        controller.installPresentationEmitter { [weak self] presentation in
            self?.emitPresentation(presentation)
        }
    }

    func start() {
        guard readTask == nil else { return }

        emit(.ready(requestId: UUID().uuidString))
        readTask = Task.detached(priority: .userInitiated) { [weak self] in
            while !Task.isCancelled {
                guard let line = readLine() else {
                    guard !Task.isCancelled else { return }
                    await self?.parentInputDidClose()
                    return
                }
                guard let data = line.data(using: .utf8) else {
                    await self?.emitProtocolError(
                        error: "Side-chat frame is not valid UTF-8.",
                        frameKind: nil,
                        receivedProtocolVersion: nil
                    )
                    continue
                }

                do {
                    let frame = try JSONDecoder().decode(CommaSideChatHostFrame.self, from: data)
                    await self?.handle(frame)
                } catch {
                    let metadata = sideChatFrameMetadata(data)
                    await self?.emitProtocolError(
                        error: "Side-chat protocol version or frame validation failed: \(error.localizedDescription)",
                        frameKind: metadata.kind,
                        receivedProtocolVersion: metadata.protocolVersion
                    )
                }
            }
        }
    }

    func stop() {
        readTask?.cancel()
        readTask = nil
    }

    private func parentInputDidClose() {
        guard readTask != nil else { return }
        NSApp.terminate(nil)
    }

    private func handle(_ frame: CommaSideChatHostFrame) {
        switch frame {
        case .snapshot:
            // Kept only for additive compatibility with an older Electron
            // Main. This helper deliberately owns no chat data.
            return
        case let .open(requestId):
            controller?.open()
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .close(requestId):
            // The exact result is Main's causal close fence: all presentation
            // frames caused by this command must follow it on stdout.
            emit(.result(requestId: requestId, error: nil, ok: true))
            controller?.forceClose()
        case let .toggle(requestId):
            controller?.toggle()
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .settings(requestId):
            emit(.result(
                requestId: requestId,
                error: "Side-chat settings are owned by the Electron renderer.",
                ok: false
            ))
        case let .layout(requestId, debugSettings, height, width):
            controller?.updateLayout(
                width: width,
                height: height,
                debugSettings: debugSettings
            )
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .interactiveProgress(requestId, progress):
            controller?.setInteractiveProgress(CGFloat(progress))
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .interactiveComplete(requestId, shouldOpen):
            controller?.finishInteractiveProgress(shouldOpen: shouldOpen)
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .shortcut(requestId, keyCode, modifiers):
            let registered = controller?.updateHotKey(
                keyCode: keyCode.map { UInt32($0) },
                modifiers: UInt32(modifiers)
            ) == true
            emit(.result(
                requestId: requestId,
                error: registered ? nil : "The global shortcut is unavailable.",
                ok: registered
            ))
        case let .pushToTalkShortcut(requestId, keyCode, modifiers):
            let registered = updatePushToTalkHotKey(
                keyCode: keyCode.map { UInt32($0) },
                modifiers: UInt32(modifiers)
            )
            emit(.result(
                requestId: requestId,
                error: registered ? nil : "The push-to-talk shortcut is unavailable.",
                ok: registered
            ))
        case let .statusMenuShow(requestId, iconPath, rows, toolTip, width):
            statusMenu.show(iconPath: iconPath, toolTip: toolTip, rows: rows, width: width)
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .statusMenuHide(requestId):
            statusMenu.hide()
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .enabled(requestId, enabled):
            controller?.setEnabled(enabled)
            emit(.result(requestId: requestId, error: nil, ok: true))
        case let .stop(requestId):
            emit(.result(requestId: requestId, error: nil, ok: true))
            NSApp.terminate(nil)
        case .result:
            // Legacy Electron Main command responses are irrelevant now that
            // the helper never originates chat commands.
            return
        }
    }

    private func updatePushToTalkHotKey(keyCode: UInt32?, modifiers: UInt32) -> Bool {
        guard let keyCode else {
            pushToTalkHotKey = nil
            pushToTalkBinding = nil
            releasePushToTalkIfHeld()
            return true
        }
        if let pushToTalkHotKey,
           pushToTalkHotKey.isRegistered,
           pushToTalkBinding?.keyCode == keyCode,
           pushToTalkBinding?.modifiers == modifiers {
            return true
        }
        // Carbon rejects a second registration of the same chord, so the old
        // binding is dropped before the candidate registers. A held chord is
        // released first so Main never waits on a key that no longer exists.
        releasePushToTalkIfHeld()
        pushToTalkHotKey = nil
        let candidate = GlobalHotKey(
            id: Self.pushToTalkHotKeyID,
            keyCode: keyCode,
            modifiers: modifiers,
            onPressed: { [weak self] in
                self?.pushToTalkPressed()
            },
            onReleased: { [weak self] in
                self?.releasePushToTalkIfHeld()
            }
        )
        guard candidate.isRegistered else {
            pushToTalkBinding = nil
            return false
        }
        pushToTalkHotKey = candidate
        pushToTalkBinding = (keyCode, modifiers)
        return true
    }

    private func pushToTalkPressed() {
        // Carbon repeats the pressed event while a key auto-repeats; one hold
        // is one turn.
        guard !isPushToTalkHeld else { return }
        isPushToTalkHeld = true
        let frontmost = NSWorkspace.shared.frontmostApplication
        emit(.pushToTalkPressed(
            requestId: UUID().uuidString,
            frontmostApp: frontmost.map {
                CommaPushToTalkPressedFrontmostApp(
                    bundleId: $0.bundleIdentifier.flatMap { $0.isEmpty ? nil : String($0.prefix(256)) },
                    name: String(($0.localizedName ?? "").prefix(256))
                )
            }
        ))
    }

    private func releasePushToTalkIfHeld() {
        guard isPushToTalkHeld else { return }
        isPushToTalkHeld = false
        emit(.pushToTalkReleased(requestId: UUID().uuidString))
    }

    /// The Side Chat hotkey uses ids from 1 upward; this one stays apart.
    private static let pushToTalkHotKeyID = UInt32(0x5054_5400)

    private func emitPresentation(_ presentation: SideChatPresentation) {
        emit(.presentation(
            availableContentHeight: presentation.availableContentHeight,
            contentFrame: CommaSideChatPresentationContentFrame(
                height: presentation.contentFrame.height,
                width: presentation.contentFrame.width,
                x: presentation.contentFrame.x,
                y: presentation.contentFrame.y
            ),
            displayId: presentation.displayID,
            offsetX: presentation.offsetX,
            phase: generatedPhase(presentation.phase),
            progress: presentation.progress,
            revision: presentation.revision,
            screenFrame: CommaSideChatPresentationScreenFrame(
                height: presentation.screenFrame.height,
                width: presentation.screenFrame.width,
                x: presentation.screenFrame.x,
                y: presentation.screenFrame.y
            ),
            windowFrame: CommaSideChatPresentationWindowFrame(
                height: presentation.windowFrame.height,
                width: presentation.windowFrame.width,
                x: presentation.windowFrame.x,
                y: presentation.windowFrame.y
            )
        ))
    }

    private func generatedPhase(_ phase: SideChatPresentationPhase) -> CommaSideChatPresentationPhase {
        switch phase {
        case .closed: .closed
        case .opening: .opening
        case .interactive: .interactive
        case .open: .open
        case .closing: .closing
        }
    }

    private func emitProtocolError(
        error: String,
        frameKind: String?,
        receivedProtocolVersion: Int?
    ) {
        emit(.protocolError(
            error: error,
            frameKind: frameKind,
            receivedProtocolVersion: receivedProtocolVersion
        ))
    }

    private func emit(_ frame: CommaSideChatClientFrame) {
        do {
            let data = try JSONEncoder().encode(frame)
            FileHandle.standardOutput.write(data + Data("\n".utf8))
        } catch {
            let line = "[CommaSideChatHost] Failed to encode generated frame: \(error)\n"
            FileHandle.standardError.write(Data(line.utf8))
        }
    }
}

private func sideChatFrameMetadata(_ data: Data) -> (kind: String?, protocolVersion: Int?) {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return (nil, nil)
    }
    return (
        object["kind"] as? String,
        (object["protocolVersion"] as? NSNumber)?.intValue
    )
}
