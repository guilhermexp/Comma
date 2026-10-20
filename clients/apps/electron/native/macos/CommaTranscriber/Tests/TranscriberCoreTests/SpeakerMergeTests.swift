import Testing
@testable import TranscriberCore

private func word(_ text: String, _ start: Double, _ end: Double) -> TimedWord {
    TimedWord(text: text, start: start, end: end)
}

private func turn(_ speaker: String, _ start: Double, _ end: Double) -> SpeakerTurn {
    SpeakerTurn(speaker: speaker, start: start, end: end)
}

@Test func aWordGoesToTheTurnItOverlapsMost() {
    let segments = mergeWordsWithSpeakers(
        words: [word("straddles", 1.8, 2.6)],
        turns: [turn("A", 0, 2.0), turn("B", 2.0, 5.0)]
    )
    #expect(segments == [TranscriptSegment(start: 1.8, end: 2.6, speaker: "S1", text: "straddles")])
    #expect(
        mergeWordsWithSpeakers(
            words: [word("x", 1.0, 1.6)],
            turns: [turn("A", 0, 1.5), turn("B", 1.5, 5.0)]
        ).first?.speaker == "S1")
}

@Test func consecutiveWordsOfOneSpeakerFormOneSegment() {
    let segments = mergeWordsWithSpeakers(
        words: [
            word("Hello", 0.1, 0.4), word("there.", 0.5, 0.9),
            word("Hi!", 1.2, 1.5),
            word("How", 2.1, 2.3), word("are", 2.3, 2.5), word("you?", 2.5, 2.9),
        ],
        turns: [turn("A", 0, 1.0), turn("B", 1.1, 1.8), turn("A", 2.0, 3.0)]
    )
    #expect(segments == [
        TranscriptSegment(start: 0.1, end: 0.9, speaker: "S1", text: "Hello there."),
        TranscriptSegment(start: 1.2, end: 1.5, speaker: "S2", text: "Hi!"),
        TranscriptSegment(start: 2.1, end: 2.9, speaker: "S1", text: "How are you?"),
    ])
}

@Test func speakersAreNumberedByFirstAppearance() {
    let segments = mergeWordsWithSpeakers(
        words: [word("one", 0, 1), word("two", 2, 3), word("three", 4, 5)],
        turns: [turn("S7", 0, 1), turn("S2", 2, 3), turn("S7", 4, 5)]
    )
    #expect(segments.map(\.speaker) == ["S1", "S2", "S1"])
}

@Test func aWordWithoutOverlapHasNoSpeaker() {
    let segments = mergeWordsWithSpeakers(
        words: [word("before", 0, 0.5), word("inside", 1.0, 1.5), word("gap", 2.5, 3.0)],
        turns: [turn("A", 0.9, 2.0)]
    )
    #expect(segments == [
        TranscriptSegment(start: 0, end: 0.5, speaker: nil, text: "before"),
        TranscriptSegment(start: 1.0, end: 1.5, speaker: "S1", text: "inside"),
        TranscriptSegment(start: 2.5, end: 3.0, speaker: nil, text: "gap"),
    ])
}

@Test func overlappingAndUnsortedTurnsAreSwept() {
    // The long turn must still be found after the short one has ended.
    let segments = mergeWordsWithSpeakers(
        words: [word("a", 0.0, 0.9), word("b", 3.6, 3.8), word("c", 6.0, 6.5)],
        turns: [turn("Z", 2.9, 3.5), turn("Y", 0.5, 10), turn("X", 0.0, 1.0)]
    )
    #expect(segments == [
        TranscriptSegment(start: 0.0, end: 0.9, speaker: "S1", text: "a"),
        TranscriptSegment(start: 3.6, end: 6.5, speaker: "S2", text: "b c"),
    ])
}

@Test func equalOverlapGoesToTheEarlierTurn() {
    let segments = mergeWordsWithSpeakers(
        words: [word("tie", 1.0, 2.0)],
        turns: [turn("late", 1.5, 3.0), turn("early", 0.0, 1.5)]
    )
    #expect(segments.map(\.speaker) == ["S1"])
    #expect(
        mergeWordsWithSpeakers(
            words: [word("tie", 1.0, 2.0), word("next", 2.5, 2.9)],
            turns: [turn("late", 1.5, 3.0), turn("early", 0.0, 1.5)]
        ).map(\.speaker) == ["S1", "S2"])
}

@Test func noWordsGiveNoSegments() {
    #expect(mergeWordsWithSpeakers(words: [], turns: [turn("A", 0, 1)]).isEmpty)
}
