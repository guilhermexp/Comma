import AppKit
import SwiftUI

typealias CommaNotchVoiceTurn = CommaNotchScenePayloadVoiceTurn
typealias CommaNotchVoiceState = CommaNotchScenePayloadVoiceTurnState

/// Each state of the push-to-talk turn keeps one hue, from the compact
/// meter to the glow behind it, so the state reads before its words.
extension CommaNotchVoiceState {
    var tint: Color {
        switch self {
        case .listening: Color(red: 0.31, green: 0.84, blue: 0.86)
        case .transcribing: Color(red: 0.42, green: 0.70, blue: 1.0)
        case .thinking: Color(red: 0.78, green: 0.50, blue: 1.0)
        case .speaking: Color(red: 1.0, green: 0.60, blue: 0.27)
        case .busy: Color.white.opacity(0.62)
        case .error: Color(red: 1.0, green: 0.38, blue: 0.36)
        }
    }

    /// Processing states read as work in progress: the text shimmers.
    var isWorking: Bool {
        self == .transcribing || self == .thinking
    }
}

enum NotchVoiceMetrics {
    static let barCount = 5
    static let barWidth: CGFloat = 3
    static let barSpacing: CGFloat = 2.5
    static let restingBarHeight: CGFloat = 3
    static let maximumBarHeight: CGFloat = 16
    /// Bars nearer the middle reach further, like a voice's envelope.
    static let barReach: [CGFloat] = [0.48, 0.82, 1, 0.74, 0.52]

    static let compactFontSize: CGFloat = 13
    static let compactLeadingInset: CGFloat = 4
    static let compactTrailingWidth: CGFloat = 52
    static let compactMinimumLeadingWidth: CGFloat = 132
    static let compactMaximumLeadingWidth: CGFloat = 320

    static let visualSize: CGFloat = 40
    static let cardPadding: CGFloat = 8
    static let contentTopInset: CGFloat = 10
    static let contentBottomInset: CGFloat = 16
    static let contentHorizontalPadding: CGFloat = 16

    /// One bar's height for a microphone level; silence leaves round dots.
    static func barHeight(level: Double, index: Int, wobble: Double = 0) -> CGFloat {
        let level = min(max(level, 0), 1)
        let reach = barReach[index % barReach.count]
        // A soft knee: quiet speech already moves the bars.
        let shaped = CGFloat(sqrt(level)) * reach * CGFloat(1 + wobble * 0.18)
        let height = restingBarHeight + shaped * (maximumBarHeight - restingBarHeight)
        return min(max(height, restingBarHeight), maximumBarHeight)
    }

    /// The compact leading side: wide enough for the sentence, within bounds.
    static func compactLeadingWidth(for message: String) -> CGFloat {
        let system = NSFont.systemFont(ofSize: compactFontSize, weight: .semibold)
        let font = system.fontDescriptor.withDesign(.rounded)
            .flatMap { NSFont(descriptor: $0, size: compactFontSize) } ?? system
        let text = (message as NSString).size(withAttributes: [.font: font]).width
        return min(
            max(ceil(text) + compactLeadingInset + 8, compactMinimumLeadingWidth),
            compactMaximumLeadingWidth
        )
    }

    static func expandedSurfaceSize(notchHeight: CGFloat = 31) -> CGSize {
        CGSize(
            width: 480,
            height: notchHeight + contentTopInset + visualSize + cardPadding * 2
                + contentBottomInset
        )
    }
}

/// Compact leading side: the state in words, left-aligned against the shell.
struct CommaNotchVoiceLeadingSlotView: View {
    let turn: CommaNotchVoiceTurn
    let availableWidth: CGFloat

    var body: some View {
        CommaNotchVoiceMessage(turn: turn, fontSize: NotchVoiceMetrics.compactFontSize)
            .padding(.leading, NotchVoiceMetrics.compactLeadingInset)
            .frame(width: availableWidth, alignment: .leading)
            .accessibilityElement(children: .combine)
    }
}

/// Compact trailing side: the meter over a glow of the state's hue.
struct CommaNotchVoiceTrailingSlotView: View {
    let turn: CommaNotchVoiceTurn
    let availableWidth: CGFloat

    var body: some View {
        ZStack(alignment: .trailing) {
            CommaNotchVoiceGlow(tint: turn.state.tint)
            CommaNotchVoiceMeter(state: turn.state, level: turn.level ?? 0)
                .padding(.trailing, 6)
        }
        .frame(width: availableWidth, alignment: .trailing)
        .animation(.easeInOut(duration: 0.28), value: turn.state)
        .accessibilityHidden(true)
    }
}

/// Expanded: the same state on a card, with an error's way out.
struct CommaNotchVoiceExpandedView: View {
    let turn: CommaNotchVoiceTurn
    let onAction: (String) -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(turn.state.tint.opacity(0.16))
                CommaNotchVoiceMeter(state: turn.state, level: turn.level ?? 0)
            }
            .frame(width: NotchVoiceMetrics.visualSize, height: NotchVoiceMetrics.visualSize)
            .accessibilityHidden(true)

            // The card has room for an error's whole sentence.
            CommaNotchVoiceMessage(turn: turn, fontSize: 13, lineLimit: 2)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let action = turn.action {
                Button { onAction(action.id) } label: {
                    Text(action.label)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.92))
                        .padding(.horizontal, 10)
                        .frame(height: 24)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(.white.opacity(0.2))
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .strokeBorder(.white.opacity(0.1), lineWidth: 0.5)
                        }
                }
                .buttonStyle(.plain)
                .fixedSize()
            }
        }
        .padding(NotchVoiceMetrics.cardPadding)
        .padding(.trailing, 4)
        // The same solid card as AirDrop and a task row.
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(red: 31 / 255, green: 31 / 255, blue: 31 / 255))
        )
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(.white.opacity(0.08))
                .allowsHitTesting(false)
        }
        .padding(.top, NotchVoiceMetrics.contentTopInset)
        .padding(.bottom, NotchVoiceMetrics.contentBottomInset)
        .padding(.horizontal, NotchVoiceMetrics.contentHorizontalPadding)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    static func expandedSurfaceSize() -> CGSize {
        NotchVoiceMetrics.expandedSurfaceSize()
    }
}

private struct CommaNotchVoiceMessage: View {
    let turn: CommaNotchVoiceTurn
    let fontSize: CGFloat
    var lineLimit = 1

    var body: some View {
        let font = Font.system(size: fontSize, weight: .semibold, design: .rounded)
        ZStack(alignment: .leading) {
            if turn.state.isWorking {
                CommaNotchThinkingHighlightText(
                    text: turn.message,
                    font: font,
                    baseColor: .white.opacity(0.58),
                    highlightColor: .white.opacity(0.98)
                )
            } else {
                Text(turn.message)
                    .font(font)
                    .foregroundStyle(.white.opacity(turn.state == .busy ? 0.7 : 0.94))
                    .lineLimit(lineLimit)
                    .fixedSize(horizontal: false, vertical: lineLimit > 1)
                    .truncationMode(.tail)
            }
        }
        .id(turn.message)
        .transition(.opacity)
        .animation(.easeOut(duration: 0.18), value: turn.message)
    }
}

/// A soft light of the state's hue in the shell's trailing corner.
private struct CommaNotchVoiceGlow: View {
    let tint: Color

    var body: some View {
        RadialGradient(
            colors: [tint.opacity(0.5), tint.opacity(0.14), .clear],
            center: UnitPoint(x: 1, y: 0.62),
            startRadius: 0,
            endRadius: 46
        )
        .blur(radius: 6)
        .allowsHitTesting(false)
    }
}

/// The state's motion: bars that follow the microphone while listening, a
/// voice-like sway while speaking, a travelling pulse while working.
struct CommaNotchVoiceMeter: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let state: CommaNotchVoiceState
    let level: Double

    var body: some View {
        Group {
            switch state {
            case .listening:
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                    let time = context.date.timeIntervalSinceReferenceDate
                    bars { index in
                        // A little life on top of the reading, so a steady
                        // level does not freeze the bars between updates.
                        let wobble = reduceMotion ? 0 : sin(time * 9 + Double(index) * 1.7)
                        return NotchVoiceMetrics.barHeight(level: level, index: index, wobble: wobble)
                    }
                    .animation(.easeOut(duration: 0.09), value: level)
                }
            case .speaking:
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion)) { context in
                    let time = context.date.timeIntervalSinceReferenceDate
                    bars { index in
                        let phase = Double(index) * 0.9
                        let sway = reduceMotion
                            ? 0.45
                            : 0.32 + 0.3 * sin(time * 7.3 + phase) + 0.22 * sin(time * 12.1 + phase * 1.6)
                        return NotchVoiceMetrics.barHeight(level: max(0.05, sway), index: index)
                    }
                }
            case .transcribing, .thinking, .busy:
                TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || state == .busy)) { context in
                    let time = context.date.timeIntervalSinceReferenceDate
                    dots(count: 3) { index in
                        guard !reduceMotion, state != .busy else { return 0.75 }
                        let speed = state == .thinking ? 4.2 : 6.5
                        return 0.35 + 0.65 * max(0, sin(time * speed - Double(index) * 0.9))
                    }
                }
            case .error:
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(state.tint)
            }
        }
        .frame(height: NotchVoiceMetrics.maximumBarHeight)
    }

    private func bars(height: (Int) -> CGFloat) -> some View {
        let heights = (0..<NotchVoiceMetrics.barCount).map(height)
        return HStack(alignment: .center, spacing: NotchVoiceMetrics.barSpacing) {
            ForEach(heights.indices, id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(state.tint)
                    .frame(width: NotchVoiceMetrics.barWidth, height: heights[index])
            }
        }
    }

    private func dots(count: Int, intensity: (Int) -> Double) -> some View {
        let values = (0..<count).map(intensity)
        return HStack(spacing: 3.5) {
            ForEach(values.indices, id: \.self) { index in
                let value = values[index]
                Circle()
                    .fill(state.tint)
                    .frame(width: 5, height: 5)
                    .opacity(0.4 + 0.6 * value)
                    .scaleEffect(0.8 + 0.25 * value)
            }
        }
    }
}
