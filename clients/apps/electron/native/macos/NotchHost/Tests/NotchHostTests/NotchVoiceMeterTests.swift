import Testing
@testable import NotchHost

@Test func silenceLeavesRoundDotsAndALouderVoiceRaisesEveryBar() {
    for index in 0..<NotchVoiceMetrics.barCount {
        let silent = NotchVoiceMetrics.barHeight(level: 0, index: index)
        let quiet = NotchVoiceMetrics.barHeight(level: 0.2, index: index)
        let loud = NotchVoiceMetrics.barHeight(level: 1, index: index)
        #expect(silent == NotchVoiceMetrics.restingBarHeight)
        #expect(quiet > silent)
        #expect(loud > quiet)
        #expect(loud <= NotchVoiceMetrics.maximumBarHeight)
    }
}

@Test func outOfRangeLevelsAndWobbleStayInsideTheShell() {
    let heights = [-1.0, 0.5, 4.0].flatMap { level in
        [-1.0, 1.0].map { wobble in
            NotchVoiceMetrics.barHeight(level: level, index: 2, wobble: wobble)
        }
    }
    #expect(heights.allSatisfy {
        $0 >= NotchVoiceMetrics.restingBarHeight && $0 <= NotchVoiceMetrics.maximumBarHeight
    })
}
