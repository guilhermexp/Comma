# Local meeting transcription: attributions

Comma's local transcription helper uses the FluidAudio SDK 0.17.7
(Apache-2.0, Copyright Fluid Inference; see FluidAudio-LICENSE-Apache-2.0).

The app does not contain model weights. When the user installs local
transcription, the helper downloads these Core ML models from Hugging Face:

- Parakeet TDT 0.6B v3 (int8 encoder v2), Core ML conversion by Fluid
  Inference of NVIDIA's nvidia/parakeet-tdt-0.6b-v3, licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/).
  Source: https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml
  at revision 7dd20fe6b1797d35f5e3307e8b1732d9a178edfe.
  See parakeet-tdt-0.6b-v3-coreml-MODEL-CARD.md.

- Speaker diarization Community-1 (segmentation, FBank, embedding, PLDA),
  Core ML conversion by Fluid Inference of pyannote's
  speaker-diarization-community-1 with WeSpeaker embeddings and PLDA
  parameters from BUT Speech@FIT, licensed under CC BY 4.0.
  Source: https://huggingface.co/FluidInference/speaker-diarization-coreml
  at revision df2625ac79a7ac6b65ad868fee6d80f320da4232.
  See speaker-diarization-coreml-NOTICE.md and
  speaker-diarization-coreml-LICENSE-CC-BY-4.0.

The model files are modified (converted and compiled) versions of the
original works.
