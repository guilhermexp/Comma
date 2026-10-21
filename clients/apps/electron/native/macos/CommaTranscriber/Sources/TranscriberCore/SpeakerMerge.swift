import Foundation

/// A recognized word, in seconds from the start of the recording.
public struct TimedWord: Sendable, Equatable {
    public let text: String
    public let start: Double
    public let end: Double

    public init(text: String, start: Double, end: Double) {
        self.text = text
        self.start = start
        self.end = end
    }
}

/// A diarizer speech turn. `speaker` is the diarizer's own label.
public struct SpeakerTurn: Sendable, Equatable {
    public let speaker: String
    public let start: Double
    public let end: Double

    public init(speaker: String, start: Double, end: Double) {
        self.speaker = speaker
        self.start = start
        self.end = end
    }
}

public struct TranscriptSegment: Sendable, Equatable {
    public let start: Double
    public let end: Double
    /// `S1`, `S2`, … by first appearance, or nil when no turn is within
    /// `nearestTurnLimit` of the words.
    public let speaker: String?
    public let text: String

    public init(start: Double, end: Double, speaker: String?, text: String) {
        self.start = start
        self.end = end
        self.speaker = speaker
        self.text = text
    }
}

/// A turn's first word often starts just before the diarizer's turn does.
/// A word that overlaps no turn joins the nearest turn within this gap.
public let nearestTurnLimit = 1.0

/// Gives each word the turn it overlaps most (the earlier turn on a tie), or
/// else the nearest turn within `nearestTurnLimit` seconds (the earlier turn
/// on a tie), joins consecutive words of one speaker into a segment, and
/// renames the speakers by order of first appearance. Words must be in time
/// order.
public func mergeWordsWithSpeakers(words: [TimedWord], turns: [SpeakerTurn]) -> [TranscriptSegment] {
    let turns = turns.sorted { ($0.start, $0.end) < ($1.start, $1.end) }
    var firstUnfinished = 0
    // The latest-ending turn among those every later word starts after.
    var lastEnded: SpeakerTurn?
    var labels: [String: String] = [:]
    var segments: [TranscriptSegment] = []
    var current: (start: Double, end: Double, speaker: String?, words: [String])?

    func flush() {
        guard let segment = current else { return }
        segments.append(
            TranscriptSegment(
                start: segment.start, end: segment.end, speaker: segment.speaker,
                text: segment.words.joined(separator: " ")))
        current = nil
    }

    for word in words {
        // Turns ending before this word also end before every later word.
        while firstUnfinished < turns.count, turns[firstUnfinished].end <= word.start {
            if turns[firstUnfinished].end > (lastEnded?.end ?? -.infinity) {
                lastEnded = turns[firstUnfinished]
            }
            firstUnfinished += 1
        }
        var best: (turn: SpeakerTurn, overlap: Double)?
        // Candidates in start order, so a tie keeps the earlier turn.
        var nearest: (turn: SpeakerTurn, gap: Double)?
        func consider(_ turn: SpeakerTurn) {
            let gap = max(turn.start - word.end, word.start - turn.end, 0)
            if gap <= nearestTurnLimit, gap < (nearest?.gap ?? .infinity) {
                nearest = (turn, gap)
            }
        }
        if let lastEnded { consider(lastEnded) }
        var index = firstUnfinished
        while index < turns.count, turns[index].start <= word.end {
            let turn = turns[index]
            index += 1
            let overlap = min(turn.end, word.end) - max(turn.start, word.start)
            // A zero-length word counts when it lies inside the turn.
            let touches =
                overlap > 0
                || (word.end <= word.start && turn.start <= word.start && word.start < turn.end)
            if touches, overlap > (best?.overlap ?? -1) {
                best = (turn, overlap)
            } else if !touches {
                consider(turn)
            }
        }
        if index < turns.count { consider(turns[index]) }

        var speaker: String?
        if let turn = best?.turn ?? nearest?.turn {
            if labels[turn.speaker] == nil {
                labels[turn.speaker] = "S\(labels.count + 1)"
            }
            speaker = labels[turn.speaker]
        }

        if var segment = current, segment.speaker == speaker {
            segment.end = word.end
            segment.words.append(word.text)
            current = segment
        } else {
            flush()
            current = (word.start, word.end, speaker, [word.text])
        }
    }
    flush()
    return segments
}
