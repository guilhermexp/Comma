import Foundation
import Testing
@testable import TranscriberCore

private func word(_ text: String, _ start: Double, _ end: Double) -> TimedWord {
    TimedWord(text: text, start: start, end: end)
}

/// Times to the microsecond, so `10 + 1.9` equals `11.9`.
private func micro(_ words: [TimedWord]?) -> [TimedWord]? {
    words?.map {
        TimedWord(text: $0.text, start: ($0.start * 1e6).rounded() / 1e6, end: ($0.end * 1e6).rounded() / 1e6)
    }
}

private let first = AudioChunk(url: URL(fileURLWithPath: "/a.m4a"), start: 0, duration: 12)
private let second = AudioChunk(url: URL(fileURLWithPath: "/b.m4a"), start: 10, duration: 8)

@Test func aWordCrossingTheSeamIsKeptOnce() {
    // The overlap is 10...12, its middle 11. "seam" starts before the middle
    // in both pieces; "tail" starts after it.
    let joined = joinChunks([
        (first, ChunkTranscript(
            duration: 12, words: [word("a", 1, 1.5), word("seam", 10.6, 11.3), word("tail", 11.5, 11.9)],
            segments: [word("a seam tail", 1, 11.9)])),
        (second, ChunkTranscript(
            duration: 8, words: [word("seam", 0.62, 1.31), word("tail", 1.5, 1.9), word("b", 3, 3.4)],
            segments: [word("seam tail b", 0.62, 3.4)])),
    ])

    #expect(micro(joined.words) == [word("a", 1, 1.5), word("seam", 10.6, 11.3), word("tail", 11.5, 11.9), word("b", 13, 13.4)])
    #expect(joined.duration == 18)
}

@Test func aWordTheTwoPiecesTimeOnEitherSideOfTheMiddleIsKeptOnce() {
    // The pieces disagree by 0.1 s around the middle (11).
    let duplicateRisk = joinChunks([
        (first, ChunkTranscript(duration: 12, words: [word("x", 10.95, 11.3)], segments: [])),
        (second, ChunkTranscript(duration: 8, words: [word("x", 1.05, 1.4), word("y", 1.5, 1.8)], segments: [])),
    ])
    let lossRisk = joinChunks([
        (first, ChunkTranscript(duration: 12, words: [word("w", 10.2, 10.6), word("x", 11.05, 11.4)], segments: [])),
        (second, ChunkTranscript(duration: 8, words: [word("w", 0.2, 0.6), word("x", 0.95, 1.3)], segments: [])),
    ])

    #expect(duplicateRisk.words?.map(\.text) == ["x", "y"])
    #expect(lossRisk.words?.map(\.text) == ["w", "x"])
}

@Test func withoutWordsTheSegmentsAreTheUnit() {
    let joined = joinChunks([
        (first, ChunkTranscript(
            duration: 12, words: [word("a", 1, 1.5)],
            segments: [word("Hello there.", 1, 4), word("Second part", 10.4, 11.8)])),
        (second, ChunkTranscript(
            duration: 8, words: nil,
            segments: [word("Second part", 0.4, 1.8), word("and the end.", 2, 5)])),
    ])

    #expect(joined.words == nil)
    #expect(micro(joined.units) == [
        word("Hello there.", 1, 4), word("Second part", 10.4, 11.8), word("and the end.", 12, 15),
    ])
}

@Test func aWholeFileKeepsTheProviderDuration() {
    let whole = AudioChunk(url: URL(fileURLWithPath: "/c.m4a"), start: 0, duration: nil)
    let joined = joinChunks([
        (whole, ChunkTranscript(duration: 4.25, words: [word("hi", 0.1, 0.3)], segments: [word("hi", 0.1, 0.3)]))
    ])

    #expect(joined.duration == 4.25)
    #expect(joined.segments == [word("hi", 0.1, 0.3)])
}

@Test func wordsAProviderTimesOutOfOrderAreSortedForTheSpeakerMerge() {
    // Whisper looping on repetitive speech timed "50" before the words it follows.
    let joined = joinChunks([
        (first, ChunkTranscript(
            duration: 12, words: [word("number", 5, 5.4), word("51", 5.5, 5.8), word("50", 4.4, 4.8)],
            segments: [word("number 51", 5, 5.8), word("50", 4.4, 4.8)]))
    ])

    #expect(joined.words?.map(\.text) == ["50", "number", "51"])
    #expect(joined.segments.map(\.text) == ["50", "number 51"])
}
