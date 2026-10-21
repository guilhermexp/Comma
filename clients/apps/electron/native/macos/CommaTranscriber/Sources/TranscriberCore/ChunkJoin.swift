import Foundation

/// A provider's result for one piece, in the piece's own time. Segments
/// carry their text in `TimedWord.text`.
public struct ChunkTranscript: Sendable, Equatable {
    public let duration: Double?
    /// Nil when the provider returned no word timestamps.
    public let words: [TimedWord]?
    public let segments: [TimedWord]

    public init(duration: Double?, words: [TimedWord]?, segments: [TimedWord]) {
        self.duration = duration
        self.words = words
        self.segments = segments
    }
}

/// The pieces of a recording joined into recording time.
public struct JoinedTranscript: Sendable, Equatable {
    public let duration: Double
    /// Nil when a piece came without words.
    public let words: [TimedWord]?
    public let segments: [TimedWord]

    /// What the speaker merge labels: words, or segments without them (D4).
    public var units: [TimedWord] { words ?? segments }
}

/// Orders and rebases each piece's units and resolves each overlap (D4): a unit
/// that starts before the middle of the overlap comes from the earlier
/// piece, the others from the later one. The two pieces time the same word
/// a little differently, so the later piece skips a unit whose middle lies
/// within the last unit kept, and keeps one the earlier piece left out.
///
/// Segments span many words and the two pieces cut them differently, so
/// timing cannot tell which words of a segment the earlier piece already
/// has. In the overlap, a later segment instead drops the leading words
/// that repeat the end of the text kept so far, and keeps the rest.
public func joinChunks(_ pieces: [(chunk: AudioChunk, transcript: ChunkTranscript)]) -> JoinedTranscript {
    func join(_ units: (ChunkTranscript) -> [TimedWord], alignText: Bool = false) -> [TimedWord] {
        var joined: [TimedWord] = []
        for (index, piece) in pieces.enumerated() {
            let start = piece.chunk.start
            var middle = Double.infinity
            if index + 1 < pieces.count, let duration = piece.chunk.duration {
                middle = (pieces[index + 1].chunk.start + start + duration) / 2
            }
            let coveredUntil = index == 0 ? -Double.infinity : (joined.last?.end ?? -.infinity)
            // Providers looping on repetitive speech can time a word before
            // the one it follows; the speaker merge needs time order.
            let ordered = units(piece.transcript).enumerated()
                .sorted { ($0.element.start, $0.offset) < ($1.element.start, $1.offset) }.map(\.element)
            // Where the earlier piece's audio ends; nil for the first piece.
            let overlapEnd = index == 0 ? nil : pieces[index - 1].chunk.duration.map { pieces[index - 1].chunk.start + $0 }
            for unit in ordered {
                let rebased = TimedWord(text: unit.text, start: start + unit.start, end: start + unit.end)
                guard rebased.start < middle else { continue }
                if alignText, let overlapEnd, rebased.start < overlapEnd {
                    if let rest = dropRepeatedLead(rebased, after: joined, from: start) { joined.append(rest) }
                    continue
                }
                guard (rebased.start + rebased.end) / 2 >= coveredUntil else { continue }
                joined.append(rebased)
            }
        }
        return joined
    }

    let hasWords = pieces.allSatisfy { $0.transcript.words != nil }
    let last = pieces.last
    let duration =
        last.map { piece in
            piece.chunk.start + (piece.chunk.duration ?? piece.transcript.duration ?? piece.transcript.segments.last?.end ?? 0)
        } ?? 0
    return JoinedTranscript(
        duration: duration,
        words: hasWords ? join { $0.words ?? [] } : nil,
        segments: join(\.segments, alignText: true))
}

/// `unit` without the leading words that repeat the end of the text joined
/// so far (compared without case or punctuation), its start moved in
/// proportion; nil when every word repeats. Only text that ends after
/// `from`, the later piece's start, can be repeated.
func dropRepeatedLead(_ unit: TimedWord, after joined: [TimedWord], from: Double) -> TimedWord? {
    func normalized(_ word: Substring) -> String {
        word.lowercased().filter { $0.isLetter || $0.isNumber }
    }
    let words = unit.text.split(whereSeparator: \.isWhitespace)
    let tail = joined.filter { $0.end > from }.flatMap { $0.text.split(whereSeparator: \.isWhitespace) }
        .map(normalized)
    let lead = words.map(normalized)
    var repeated = 0
    for count in stride(from: min(lead.count, tail.count), through: 1, by: -1)
    where Array(tail.suffix(count)) == Array(lead.prefix(count)) {
        repeated = count
        break
    }
    guard repeated < words.count else { return nil }
    guard repeated > 0 else { return unit }
    let start = unit.start + (unit.end - unit.start) * Double(repeated) / Double(words.count)
    return TimedWord(text: words.dropFirst(repeated).joined(separator: " "), start: start, end: unit.end)
}
