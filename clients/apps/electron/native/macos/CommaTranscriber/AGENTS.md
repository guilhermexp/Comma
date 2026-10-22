# CommaTranscriber

SwiftPM helper that transcribes meeting recordings for the desktop app's local
backend. It runs FluidAudio (Parakeet TDT 0.6B v3 and Community-1 speaker
diarization) on the Mac, or sends the audio to a cloud provider (Groq or an
OpenAI-compatible API) and labels speakers locally.

Runtime contract, packaging and the user-facing behavior:
[`clients/apps/electron/RELEASE.md`](../../../RELEASE.md) ("Local transcription
helper", "Local transcription", "Cloud transcription"). OpenSpec capabilities:
`meeting-local-transcription` and `meeting-transcription-providers`.

## Layout

- `Sources/TranscriberCore/`: everything testable without FluidAudio — CLI
  parsing (`Command.swift`), JSONL events, model manifest, verifier, staged
  install and per-component store (`asr`, `diarization`), loopback HTTP server
  and job queue, speaker merge, AVFoundation chunker, chunk join, cloud client.
- `Sources/CommaTranscriber/`: `main.swift` and `FluidAudioAdapters.swift`, the
  only code that touches FluidAudio.
- `Sources/TranscriberCore/models-manifest.json`: pinned files, sizes and
  SHA-256. Generated; never edit by hand.
- `Licenses/`: shipped to `Contents/Resources/licenses/fluidaudio/`. Vendored
  texts stay byte-identical (prettier-ignored).

## Commands

```sh
swift test                                                # in this folder
pnpm --dir clients/apps/electron build:native             # builds dist/native/macos/CommaTranscriber
pnpm --dir clients/apps/electron exec tsx scripts/transcriber-models-manifest.ts --check
```

## Rules

- FluidAudio stays pinned `exact:`; changing it or a model revision means
  regenerating the manifest with the script above.
- Model weights never ship in the app; they are downloaded only by an explicit
  user install and verified against the manifest before use.
- The bearer token comes from `--token-file`; never put a token or a cloud API
  key in argv, env or logs. Cloud provider config lives only in memory.
- The cloud client refuses redirects. New cloud failures map to a `cloud_*`
  reason so the router can fall back to the local model.
