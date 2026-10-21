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

/// Rebases each piece by its start and resolves each overlap (D4): a unit
/// that starts before the middle of the overlap comes from the earlier
/// piece, the others from the later one. The two pieces time the same word
/// a little differently, so the later piece skips a unit whose middle lies
/// within the last unit kept, and keeps one the earlier piece left out.
public func joinChunks(_ pieces: [(chunk: AudioChunk, transcript: ChunkTranscript)]) -> JoinedTranscript {
    func join(_ units: (ChunkTranscript) -> [TimedWord]) -> [TimedWord] {
        var joined: [TimedWord] = []
        for (index, piece) in pieces.enumerated() {
            let start = piece.chunk.start
            var middle = Double.infinity
            if index + 1 < pieces.count, let duration = piece.chunk.duration {
                middle = (pieces[index + 1].chunk.start + start + duration) / 2
            }
            let coveredUntil = index == 0 ? -Double.infinity : (joined.last?.end ?? -.infinity)
            for unit in units(piece.transcript) {
                let rebased = TimedWord(text: unit.text, start: start + unit.start, end: start + unit.end)
                guard rebased.start < middle, (rebased.start + rebased.end) / 2 >= coveredUntil else { continue }
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
        segments: join(\.segments))
}
