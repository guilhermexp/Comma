import Carbon
import CoreGraphics
import Foundation

/// Modifier-only hold-to-talk chord (for example ⌃⌥ held alone), observed by
/// a listen-only session event tap: it swallows nothing, so every key still
/// reaches the other apps. Carbon cannot register modifiers without a key.
///
/// - pressed: the held modifiers become exactly the chord's, coming from a
///   subset of them (⌃⌥⇧ released to ⌃⌥ never starts a turn).
/// - released: one of the chord's modifiers goes up.
/// - cancelled: a key goes down, or another modifier joins, while the chord is
///   held; it was a different shortcut.
///
/// The tap needs Input Monitoring. Without it the tap is retried every 2 s, so
/// a grant in System Settings takes effect without a restart.
@MainActor
final class ModifierChordTap {
    enum Event {
        case pressed
        case released(cancelled: Bool)
    }

    /// Caps Lock and Fn (also set by arrow keys) never count.
    private static let chordFlags: CGEventFlags = [
        .maskAlternate, .maskCommand, .maskControl, .maskShift,
    ]
    private static let permissionRetryInterval: TimeInterval = 2

    private let target: CGEventFlags
    private let onEvent: (Event) -> Void
    private let onPermissionChange: (Bool) -> Void
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var retryTimer: Timer?
    /// The held modifiers are a strict subset of the chord.
    private var armed = false
    private var held = false

    /// Whether the tap observes the keyboard, i.e. Input Monitoring is granted.
    var isActive: Bool { tap != nil }

    init(
        carbonModifiers: UInt32,
        onEvent: @escaping (Event) -> Void,
        onPermissionChange: @escaping (Bool) -> Void
    ) {
        target = Self.flags(carbonModifiers: carbonModifiers)
        self.onEvent = onEvent
        self.onPermissionChange = onPermissionChange
        if !installTap() { scheduleRetry() }
    }

    /// Shows the macOS prompt the first time and lists the app under Input
    /// Monitoring; later calls only read the decision.
    func requestAccess() {
        _ = CGRequestListenEventAccess()
        retry()
    }

    func invalidate() {
        retryTimer?.invalidate()
        retryTimer = nil
        if let runLoopSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        runLoopSource = nil
        tap = nil
        held = false
        armed = false
    }

    fileprivate func handle(type: CGEventType, flags: CGEventFlags) {
        switch type {
        case .tapDisabledByTimeout, .tapDisabledByUserInput:
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        case .flagsChanged:
            let active = flags.intersection(Self.chordFlags)
            if held {
                guard active != target else { return }
                held = false
                armed = active.isStrictSubset(of: target)
                onEvent(.released(cancelled: !active.isStrictSubset(of: target)))
                return
            }
            if active == target, armed {
                held = true
                onEvent(.pressed)
                return
            }
            armed = active.isStrictSubset(of: target)
        case .keyDown:
            armed = false
            guard held else { return }
            held = false
            onEvent(.released(cancelled: true))
        default:
            return
        }
    }

    private func installTap() -> Bool {
        guard CGPreflightListenEventAccess() else { return false }
        let mask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: modifierChordTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            return false
        }
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        self.tap = tap
        runLoopSource = source
        return true
    }

    private func scheduleRetry() {
        guard retryTimer == nil else { return }
        retryTimer = Timer.scheduledTimer(
            withTimeInterval: Self.permissionRetryInterval,
            repeats: true
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.retry() }
        }
    }

    private func retry() {
        guard tap == nil, installTap() else { return }
        retryTimer?.invalidate()
        retryTimer = nil
        onPermissionChange(true)
    }

    private static func flags(carbonModifiers: UInt32) -> CGEventFlags {
        var flags: CGEventFlags = []
        if carbonModifiers & UInt32(optionKey) != 0 { flags.insert(.maskAlternate) }
        if carbonModifiers & UInt32(controlKey) != 0 { flags.insert(.maskControl) }
        if carbonModifiers & UInt32(cmdKey) != 0 { flags.insert(.maskCommand) }
        if carbonModifiers & UInt32(shiftKey) != 0 { flags.insert(.maskShift) }
        return flags
    }
}

/// Runs on the main run loop, where the tap's source is installed.
private func modifierChordTapCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    if let userInfo {
        let chordTap = Unmanaged<ModifierChordTap>.fromOpaque(userInfo).takeUnretainedValue()
        let flags = event.flags
        MainActor.assumeIsolated { chordTap.handle(type: type, flags: flags) }
    }
    return Unmanaged.passUnretained(event)
}
