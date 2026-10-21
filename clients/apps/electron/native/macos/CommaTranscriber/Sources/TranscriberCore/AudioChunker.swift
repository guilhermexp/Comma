import AVFoundation
import Foundation

/// A piece of the recording to upload. `start` is in seconds from the start
/// of the recording; `duration` is nil for a file sent whole.
public struct AudioChunk: Sendable, Equatable {
    public let url: URL
    public let start: Double
    public let duration: Double?

    public init(url: URL, start: Double, duration: Double?) {
        self.url = url
        self.start = start
        self.duration = duration
    }
}

/// Cuts a recording into pieces a provider accepts, without re-encoding
/// (openspec add-cloud-meeting-asr, D4): AVFoundation passthrough export of
/// consecutive time ranges that overlap by `overlapSeconds`.
public struct AudioChunker: Sendable {
    public struct Failure: Error, CustomStringConvertible {
        public let description: String
    }

    public let maxUploadBytes: Int64
    public let maxChunkSeconds: Double
    public let overlapSeconds: Double

    public init(maxUploadBytes: Int64, maxChunkSeconds: Double = 600, overlapSeconds: Double = 2) {
        self.maxUploadBytes = maxUploadBytes
        self.maxChunkSeconds = maxChunkSeconds
        self.overlapSeconds = overlapSeconds
    }

    /// Returns `audio` itself when it fits, else pieces written into `directory`.
    public func split(_ audio: URL, into directory: URL) async throws -> [AudioChunk] {
        let size = (try FileManager.default.attributesOfItem(atPath: audio.path)[.size] as? NSNumber)?.int64Value ?? 0
        guard size > maxUploadBytes else { return [AudioChunk(url: audio, start: 0, duration: nil)] }

        let asset = AVURLAsset(url: audio)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else { throw Failure(description: "the recording has no duration") }
        // The average bit rate, with room for a denser stretch and the container.
        let bytesPerSecond = Double(size) / duration
        let length = min(maxChunkSeconds, Double(maxUploadBytes) * 0.9 / bytesPerSecond)
        guard length > overlapSeconds * 2 else {
            throw Failure(description: "the upload limit is too small for this recording's bit rate")
        }

        var chunks: [AudioChunk] = []
        var start = 0.0
        while true {
            let end = min(start + length, duration)
            let url = directory.appendingPathComponent("chunk-\(chunks.count)")
            let exported = try await export(asset, from: start, to: end, into: url)
            let bytes = (try FileManager.default.attributesOfItem(atPath: exported.path)[.size] as? NSNumber)?.int64Value
            guard let bytes, bytes <= maxUploadBytes else {
                throw Failure(description: "a piece is \(bytes ?? -1) bytes, above \(maxUploadBytes)")
            }
            // Passthrough keeps whole AAC packets and writes an edit list, so
            // the piece plays from `start`; its length is the exported one.
            let real = try await AVURLAsset(url: exported).load(.duration).seconds
            chunks.append(AudioChunk(url: exported, start: start, duration: real))
            if end >= duration { return chunks }
            start = start + real - overlapSeconds
        }
    }

    private func export(_ asset: AVURLAsset, from start: Double, to end: Double, into base: URL) async throws -> URL {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough) else {
            throw Failure(description: "the recording cannot be exported")
        }
        // Formats the providers accept and passthrough can write.
        guard let (type, fileExtension) = [(AVFileType.m4a, "m4a"), (.wav, "wav")]
            .first(where: { session.supportedFileTypes.contains($0.0) })
        else {
            throw Failure(description: "the recording's format cannot be cut without re-encoding")
        }
        let url = base.appendingPathExtension(fileExtension)
        let timescale: CMTimeScale = 48000
        session.timeRange = CMTimeRange(
            start: CMTime(seconds: start, preferredTimescale: timescale),
            end: CMTime(seconds: end, preferredTimescale: timescale))
        if #available(macOS 15, *) {
            try await session.export(to: url, as: type)
        } else {
            throw Failure(description: "cutting a recording needs macOS 15")
        }
        return url
    }
}
