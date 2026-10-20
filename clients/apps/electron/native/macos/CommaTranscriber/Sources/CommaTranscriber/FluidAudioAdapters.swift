import AVFoundation
import CoreML
import FluidAudio
import Foundation
import TranscriberCore

/// Parakeet TDT 0.6B v3 with the int8 v2 encoder (`Encoder_v2.mlmodelc`).
/// The default `.int8` would load a different encoder than the manifest pins.
private let encoderPrecision = ParakeetEncoderPrecision.int8V2

private func fluidRepo(_ pinned: ModelManifest.Repo) throws -> Repo {
    guard let repo = Repo(rawValue: pinned.repo), repo.folderName == pinned.folder else {
        throw InstallFailure(.io, "FluidAudio does not know \(pinned.repo) as \(pinned.folder)")
    }
    return repo
}

private func asrDirectory(_ installed: URL) -> URL {
    installed.appendingPathComponent(Repo.parakeetV3.folderName, isDirectory: true)
}

private func neuralEngineConfiguration() -> MLModelConfiguration {
    let configuration = MLModelConfiguration()
    configuration.computeUnits = .cpuAndNeuralEngine
    return configuration
}

/// Downloads each pinned repository with FluidAudio's own file selection.
/// The manifest check afterwards removes what the loaders do not read.
struct FluidModelDownloader: ModelDownloading {
    func download(
        manifest: ModelManifest, into staging: URL, progress: @escaping @Sendable (Int64) -> Void
    ) async throws {
        ModelRegistry.revisionOverrides = Dictionary(
            uniqueKeysWithValues: manifest.repos.map { ($0.repo, $0.revision) })
        var finishedBytes: Int64 = 0
        for pinned in manifest.repos {
            let repo = try fluidRepo(pinned)
            let repoBytes = manifest.files.filter { $0.path.hasPrefix(pinned.folder + "/") }.reduce(0) {
                $0 + $1.size
            }
            let base = finishedBytes
            do {
                // Repository downloads report 0...0.5; FluidAudio keeps the
                // upper half for compilation, which this call does not do.
                try await ModelHub.download(repo, to: staging, variant: pinned.variant) { update in
                    guard case .downloading = update.phase else { return }
                    progress(base + Int64(min(1, update.fractionCompleted * 2) * Double(repoBytes)))
                }
                finishedBytes += repoBytes
            } catch let error as CocoaError where error.code.rawValue >= 512 && error.code.rawValue < 1024 {
                // NSFileWrite* errors: the disk, not the network.
                throw InstallFailure(.io, error.localizedDescription)
            } catch let error as POSIXError where error.code == .ENOSPC {
                throw InstallFailure(.io, error.localizedDescription)
            }
        }
    }
}

/// Loads every model once so Core ML compiles it for this Mac now, then
/// drops the references.
struct FluidModelPreparer: ModelPreparing {
    func prepare(installed: URL) async throws {
        ModelHub.offlineMode = true
        do {
            _ = try AsrModels.loadLocal(
                from: asrDirectory(installed), version: .v3, encoderPrecision: encoderPrecision,
                encoderComputeUnits: .cpuAndNeuralEngine)
        }
        do {
            _ = try await OfflineDiarizerModels.load(from: installed, configuration: neuralEngineConfiguration())
        }
    }
}

/// Recognition, then diarization of the same file, each with models loaded
/// for this job only (design D5).
struct FluidTranscriptionEngine: TranscriptionEngine {
    func transcribe(audio: URL, installed: URL) async throws -> EngineResult {
        // Hand the pages freed with the models back to the system.
        defer { malloc_zone_pressure_relief(nil, 0) }
        let (duration, words) = try await recognize(audio, installed: installed)
        let turns = words.isEmpty ? [] : try await diarize(audio, installed: installed)
        return EngineResult(duration: duration, words: words, turns: turns)
    }

    private func recognize(_ audio: URL, installed: URL) async throws -> (Double, [TimedWord]) {
        let models = try AsrModels.loadLocal(
            from: asrDirectory(installed), version: .v3, encoderPrecision: encoderPrecision,
            encoderComputeUnits: .cpuAndNeuralEngine)
        // One chunk at a time, and mel context across chunks for long
        // recordings (FluidAudio issue #954).
        let asr = AsrManager(config: ASRConfig(parallelChunkConcurrency: 1, melChunkContext: true), models: models)
        do {
            var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
            let result = try await asr.transcribe(audio, decoderState: &state)
            await asr.cleanup()
            let words = buildWordTimings(from: result.tokenTimings ?? []).map {
                TimedWord(text: $0.word, start: $0.startTime, end: $0.endTime)
            }
            return (result.duration, words)
        } catch ASRError.invalidAudioData {
            // Shorter than the model's minimum input: no speech to report.
            await asr.cleanup()
            return (try audioDuration(audio), [])
        } catch {
            await asr.cleanup()
            throw error
        }
    }

    private func diarize(_ audio: URL, installed: URL) async throws -> [SpeakerTurn] {
        let models = try await OfflineDiarizerModels.load(from: installed, configuration: neuralEngineConfiguration())
        let diarizer = OfflineDiarizerManager()
        diarizer.initialize(models: models)
        do {
            let segments = try await diarizer.process(audio).segments
            let speakers = Set(segments.map(\.speakerId)).count
            FileHandle.standardError.write(
                Data("[CommaTranscriber] diarization: \(segments.count) turns, \(speakers) speakers\n".utf8))
            return segments.map {
                SpeakerTurn(
                    speaker: $0.speakerId, start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds))
            }
        } catch OfflineDiarizationError.noSpeechDetected {
            return []
        }
    }

    private func audioDuration(_ url: URL) throws -> Double {
        let file = try AVAudioFile(forReading: url)
        return Double(file.length) / file.processingFormat.sampleRate
    }
}
