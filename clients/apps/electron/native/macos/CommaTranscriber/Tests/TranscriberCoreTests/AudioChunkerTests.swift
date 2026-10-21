import AVFoundation
import Foundation
import Testing
@testable import TranscriberCore

/// Writes `seconds` of AAC in an `.m4a`: quiet noise, with a one-second tone
/// starting at each of `tones`, so a cut can be located in the decoded audio.
func makeRecording(_ url: URL, seconds: Double, tones: [Double] = [], bitRate: Int = 64000) throws {
    let rate = 48000.0
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: bitRate,
    ]
    // The file is finished when the writer is released.
    let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
    let block = Int(rate)
    var generator = SystemRandomNumberGenerator()
    var written = 0
    let total = Int(seconds * rate)
    let onsets = tones.map { Int($0 * rate) }
    while written < total {
        let count = min(block, total - written)
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(count))!
        buffer.frameLength = AVAudioFrameCount(count)
        let samples = buffer.floatChannelData![0]
        for index in 0..<count {
            let frame = written + index
            if onsets.contains(where: { frame >= $0 && frame < $0 + Int(rate) }) {
                samples[index] = Float(0.5 * sin(Double(frame) * 2 * .pi * 440 / rate))
            } else {
                samples[index] = Float.random(in: -0.001...0.001, using: &generator)
            }
        }
        try file.write(from: buffer)
        written += count
    }
}

/// Seconds from the start of `url` to the first sample louder than the noise.
private func firstTone(in url: URL) throws -> Double? {
    let file = try AVAudioFile(forReading: url)
    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
    try file.read(into: buffer)
    let samples = buffer.floatChannelData![0]
    for index in 0..<Int(buffer.frameLength) where abs(samples[index]) > 0.05 {
        return Double(index) / file.processingFormat.sampleRate
    }
    return nil
}

private func fileSize(_ url: URL) throws -> Int64 {
    (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? -1
}

@Test func aFileUnderTheLimitIsSentWhole() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recording = directory.appendingPathComponent("call.m4a")
    try makeRecording(recording, seconds: 12)

    let chunks = try await AudioChunker(maxUploadBytes: try fileSize(recording))
        .split(recording, into: directory)

    #expect(chunks == [AudioChunk(url: recording, start: 0, duration: nil)])
}

@Test func aLargerFileIsCutUnderTheLimitWithTwoSecondsOfOverlap() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recording = directory.appendingPathComponent("call.m4a")
    try makeRecording(recording, seconds: 60)
    let limit = try fileSize(recording) / 3

    let chunks = try await AudioChunker(maxUploadBytes: limit).split(recording, into: directory)

    #expect(chunks.count >= 4)
    #expect(chunks.first?.start == 0)
    for chunk in chunks {
        #expect(chunk.url != recording)
        #expect(try fileSize(chunk.url) <= limit)
        #expect(try #require(chunk.duration) <= 600)
    }
    for (previous, next) in zip(chunks, chunks.dropFirst()) {
        let overlap = previous.start + previous.duration! - next.start
        #expect(abs(overlap - 2) < 0.05, "overlap \(overlap)")
    }
    let last = try #require(chunks.last)
    #expect(abs(last.start + last.duration! - 60) < 0.05)
}

@Test func noChunkIsLongerThanTheCap() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recording = directory.appendingPathComponent("call.m4a")
    try makeRecording(recording, seconds: 40)

    // The size would allow one piece; the cap (600 s in production) does not.
    let chunks = try await AudioChunker(maxUploadBytes: try fileSize(recording) - 1, maxChunkSeconds: 15)
        .split(recording, into: directory)

    #expect(chunks.count == 3)
    #expect(chunks.allSatisfy { ($0.duration ?? .infinity) <= 15.01 })
    #expect(AudioChunker(maxUploadBytes: 1).maxChunkSeconds == 600)
}

@Test func chunkStartsMatchTheExportedAudio() async throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let recording = directory.appendingPathComponent("call.m4a")
    // Onsets off the AAC packet grid (1024 frames = 21.3 ms at 48 kHz).
    let tones = [3.337, 13.711, 22.205, 31.519]
    try makeRecording(recording, seconds: 36, tones: tones)

    let chunks = try await AudioChunker(maxUploadBytes: try fileSize(recording) / 4)
        .split(recording, into: directory)

    var located = 0
    for chunk in chunks {
        let end = chunk.start + chunk.duration!
        guard let tone = tones.first(where: { $0 > chunk.start + 0.05 && $0 + 1 < end }) else { continue }
        let earlier = tones.filter { $0 < tone && $0 + 1 > chunk.start }
        guard earlier.isEmpty, let local = try firstTone(in: chunk.url) else { continue }
        #expect(abs(chunk.start + local - tone) < 0.005, "tone \(tone) found at \(chunk.start + local)")
        located += 1
    }
    #expect(located >= 3)
}
