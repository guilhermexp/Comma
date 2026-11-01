import Carbon
import Foundation

final class GlobalHotKey {
    private let id: UInt32
    private let onPressed: () -> Void
    private let onReleased: (() -> Void)?
    private var eventHandlerRef: EventHandlerRef?
    private var hotKeyRef: EventHotKeyRef?

    private(set) var isRegistered = false

    init(
        id: UInt32,
        keyCode: UInt32,
        modifiers: UInt32,
        onPressed: @escaping () -> Void,
        onReleased: (() -> Void)? = nil
    ) {
        self.id = id
        self.onPressed = onPressed
        self.onReleased = onReleased

        // Release is only observed by hold-to-talk callers; a press-only
        // hotkey keeps listening to the pressed event alone.
        var eventTypes = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
        ]
        if onReleased != nil {
            eventTypes.append(EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ))
        }

        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            hotKeyEventHandler,
            eventTypes.count,
            &eventTypes,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef
        )

        guard installStatus == noErr else { return }

        let hotKeyID = EventHotKeyID(signature: fourCharacterCode("OSCP"), id: id)
        let registerStatus = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )

        isRegistered = registerStatus == noErr
    }

    deinit {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }

        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
        }
    }

    fileprivate func handle(event: EventRef?) -> OSStatus {
        guard let event else { return noErr }

        var eventHotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &eventHotKeyID
        )

        guard status == noErr, eventHotKeyID.signature == fourCharacterCode("OSCP"), eventHotKeyID.id == id else {
            // Let the other hotkey's handler on this application target run.
            return OSStatus(eventNotHandledErr)
        }

        if GetEventKind(event) == UInt32(kEventHotKeyReleased) {
            guard let onReleased else { return noErr }
            DispatchQueue.main.async {
                onReleased()
            }
            return noErr
        }

        DispatchQueue.main.async { [onPressed] in
            onPressed()
        }

        return noErr
    }
}

private let hotKeyEventHandler: EventHandlerUPP = { _, event, userData in
    guard let userData else { return noErr }
    let hotKey = Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue()
    return hotKey.handle(event: event)
}

private func fourCharacterCode(_ string: String) -> OSType {
    string.utf8.prefix(4).reduce(OSType(0)) { result, character in
        (result << 8) + OSType(character)
    }
}
