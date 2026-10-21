/**
 * Generates the CommaTranscriber model manifest and the license texts the app
 * ships for it (openspec add-local-meeting-asr, D2 and C4; components from
 * add-cloud-meeting-asr, D3).
 *
 *   pnpm --dir clients/apps/electron exec tsx scripts/transcriber-models-manifest.ts
 *   pnpm --dir clients/apps/electron exec tsx scripts/transcriber-models-manifest.ts --check
 *
 * The helper compiles the manifest in and refuses an install whose files do
 * not match it. Weight SHA-256s come from the Hugging Face LFS metadata of the
 * pinned revision. Plain Git files are hashed from their bytes at that
 * revision; for the diarization repository they must also match the
 * publisher's provenance.json. `--check` regenerates in memory and fails when
 * the committed files differ.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const fluidAudioVersion = "0.17.7";

/** FluidAudio 0.17.7 writes this marker in each pinned repository folder and
 * refuses to load the diarizer without it (ModelCache.matchesRevision). */
export const revisionMarkerName = ".fluidaudio-revision";

/** Parts the helper installs and removes on their own (`install --component`). */
export type ModelComponent = "asr" | "diarization";

export type ModelPin = {
  repo: string;
  revision: string;
  /** Folder FluidAudio uses under the models root (`Repo.folderName`). */
  folder: string;
  /** `ModelHub.download` variant. */
  variant: string;
  component: ModelComponent;
  /** Bundles and root files the loaders read. Anything else the SDK downloads is removed. */
  runtime: string[];
  /** Publisher file with SHA-256 for every artifact, checked against ours. */
  provenance?: string;
  /** Repository files copied to the app as license or notice text. */
  licenses: { path: string; as: string }[];
};

export const modelPins: ModelPin[] = [
  {
    repo: "FluidInference/parakeet-tdt-0.6b-v3-coreml",
    revision: "7dd20fe6b1797d35f5e3307e8b1732d9a178edfe",
    folder: "parakeet-tdt-0.6b-v3",
    variant: "int8-v2",
    component: "asr",
    runtime: [
      "Encoder_v2.mlmodelc",
      "Decoder.mlmodelc",
      "JointDecisionv3.mlmodelc",
      "Preprocessor.mlmodelc",
      "parakeet_vocab.json",
    ],
    licenses: [{ path: "README.md", as: "parakeet-tdt-0.6b-v3-coreml-MODEL-CARD.md" }],
  },
  {
    repo: "FluidInference/speaker-diarization-coreml",
    revision: "df2625ac79a7ac6b65ad868fee6d80f320da4232",
    folder: "speaker-diarization",
    variant: "offline",
    component: "diarization",
    runtime: [
      "Segmentation.mlmodelc",
      "FBank.mlmodelc",
      "Embedding.mlmodelc",
      "PldaRho.mlmodelc",
      "plda-parameters.json",
    ],
    provenance: "provenance.json",
    licenses: [
      { path: "LICENSE", as: "speaker-diarization-coreml-LICENSE-CC-BY-4.0" },
      { path: "NOTICE.md", as: "speaker-diarization-coreml-NOTICE.md" },
    ],
  },
];

const fluidAudioLicense = {
  url: `https://raw.githubusercontent.com/FluidInference/FluidAudio/v${fluidAudioVersion}/LICENSE`,
  as: "FluidAudio-LICENSE-Apache-2.0",
};

export type ManifestFile = { path: string; size: number; sha256: string };

export type Manifest = {
  schemaVersion: 1;
  /** Name of the installed folder under the models directory. */
  id: string;
  fluidAudio: string;
  repos: Omit<ModelPin, "component" | "runtime" | "provenance" | "licenses">[];
  /** Folders of each component. The installed id stays the same, so a tree
   * installed before components existed is still this manifest's. */
  components: Partial<Record<ModelComponent, string[]>>;
  files: ManifestFile[];
  licenses: { file: string; source: string }[];
};

type TreeEntry = {
  type: "file" | "directory";
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
};

type Fetch = typeof globalThis.fetch;

const hub = "https://huggingface.co";

async function getOk(fetch: Fetch, url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} returned ${response.status}`);
  }
  return response;
}

async function listTree(fetch: Fetch, pin: ModelPin, path: string) {
  // Only bundle folders are listed recursively; the whole repository would page.
  const suffix = path ? `/${path}?recursive=true` : "";
  const url = `${hub}/api/models/${pin.repo}/tree/${pin.revision}${suffix}`;
  return (await (await getOk(fetch, url)).json()) as TreeEntry[];
}

async function getFile(fetch: Fetch, pin: ModelPin, path: string) {
  const url = `${hub}/${pin.repo}/resolve/${pin.revision}/${path}`;
  return Buffer.from(await (await getOk(fetch, url)).arrayBuffer());
}

function sha256(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runtimeFiles(fetch: Fetch, pin: ModelPin): Promise<ManifestFile[]> {
  const root = await listTree(fetch, pin, "");
  const entries: TreeEntry[] = [];
  for (const name of pin.runtime) {
    const top = root.find((entry) => entry.path === name);
    if (!top) {
      throw new Error(`${pin.repo}@${pin.revision} has no ${name}`);
    }
    entries.push(
      ...(top.type === "directory"
        ? (await listTree(fetch, pin, name)).filter((entry) => entry.type === "file")
        : [top])
    );
  }

  const files: ManifestFile[] = [];
  for (const entry of entries) {
    if (entry.lfs) {
      files.push({ path: entry.path, size: entry.lfs.size, sha256: entry.lfs.oid });
      continue;
    }
    const bytes = await getFile(fetch, pin, entry.path);
    if (bytes.length !== entry.size) {
      throw new Error(
        `${pin.repo}/${entry.path} is ${bytes.length} bytes, listed as ${entry.size}`
      );
    }
    files.push({ path: entry.path, size: entry.size, sha256: sha256(bytes) });
  }

  if (pin.provenance) {
    const provenance = JSON.parse(
      (await getFile(fetch, pin, pin.provenance)).toString("utf8")
    ) as { artifacts: ManifestFile[] };
    const published = new Map(provenance.artifacts.map((item) => [item.path, item]));
    for (const file of files) {
      const expected = published.get(file.path);
      if (!expected || expected.sha256 !== file.sha256 || expected.size !== file.size) {
        throw new Error(
          `${pin.repo}/${file.path} does not match ${pin.provenance} (${JSON.stringify(expected)})`
        );
      }
    }
  }

  const marker = `${pin.revision}\n`;
  files.push({
    path: revisionMarkerName,
    size: Buffer.byteLength(marker),
    sha256: sha256(marker),
  });
  return files.map((file) => ({ ...file, path: `${pin.folder}/${file.path}` }));
}

function attribution(pins: ModelPin[]) {
  const revision = (repo: string) =>
    pins.find((pin) => pin.repo === repo)?.revision ?? "unknown";
  return `# Local meeting transcription: attributions

Comma's local transcription helper uses the FluidAudio SDK ${fluidAudioVersion}
(Apache-2.0, Copyright Fluid Inference; see FluidAudio-LICENSE-Apache-2.0).

The app does not contain model weights. When the user installs local
transcription, the helper downloads these Core ML models from Hugging Face:

- Parakeet TDT 0.6B v3 (int8 encoder v2), Core ML conversion by Fluid
  Inference of NVIDIA's nvidia/parakeet-tdt-0.6b-v3, licensed under CC BY 4.0
  (https://creativecommons.org/licenses/by/4.0/).
  Source: https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml
  at revision ${revision("FluidInference/parakeet-tdt-0.6b-v3-coreml")}.
  See parakeet-tdt-0.6b-v3-coreml-MODEL-CARD.md.

- Speaker diarization Community-1 (segmentation, FBank, embedding, PLDA),
  Core ML conversion by Fluid Inference of pyannote's
  speaker-diarization-community-1 with WeSpeaker embeddings and PLDA
  parameters from BUT Speech@FIT, licensed under CC BY 4.0.
  Source: https://huggingface.co/FluidInference/speaker-diarization-coreml
  at revision ${revision("FluidInference/speaker-diarization-coreml")}.
  See speaker-diarization-coreml-NOTICE.md and
  speaker-diarization-coreml-LICENSE-CC-BY-4.0.

The model files are modified (converted and compiled) versions of the
original works.
`;
}

export type GeneratedOutput = { manifest: Manifest; licenseFiles: Map<string, Buffer> };

export async function generateTranscriberManifest(
  fetch: Fetch = globalThis.fetch,
  pins: ModelPin[] = modelPins
): Promise<GeneratedOutput> {
  const files: ManifestFile[] = [];
  const licenseFiles = new Map<string, Buffer>();
  const licenses: Manifest["licenses"] = [];

  for (const pin of pins) {
    files.push(...(await runtimeFiles(fetch, pin)));
    for (const license of pin.licenses) {
      licenseFiles.set(license.as, await getFile(fetch, pin, license.path));
      licenses.push({
        file: license.as,
        source: `${hub}/${pin.repo}/blob/${pin.revision}/${license.path}`,
      });
    }
  }
  licenseFiles.set(
    fluidAudioLicense.as,
    Buffer.from(await (await getOk(fetch, fluidAudioLicense.url)).arrayBuffer())
  );
  licenses.push({ file: fluidAudioLicense.as, source: fluidAudioLicense.url });
  licenseFiles.set("ATTRIBUTION.md", Buffer.from(attribution(pins)));
  licenses.push({ file: "ATTRIBUTION.md", source: "generated" });

  files.sort((a, b) => a.path.localeCompare(b.path, "en"));
  licenses.sort((a, b) => a.file.localeCompare(b.file, "en"));
  const components: Manifest["components"] = {};
  for (const pin of pins) {
    components[pin.component] = [...(components[pin.component] ?? []), pin.folder];
  }
  const id = pins.map((pin) => `${pin.folder}@${pin.revision.slice(0, 7)}`).join("+");

  return {
    manifest: {
      schemaVersion: 1,
      id: `${id}+${pins.map((pin) => pin.variant).join("+")}`,
      fluidAudio: fluidAudioVersion,
      repos: pins.map(({ repo, revision, folder, variant }) => ({
        repo,
        revision,
        folder,
        variant,
      })),
      components,
      files,
      licenses,
    },
    licenseFiles,
  };
}

export function serializeManifest(manifest: Manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const packageDir = resolve(import.meta.dirname, "../native/macos/CommaTranscriber");
export const transcriberManifestPath = resolve(
  packageDir,
  "Sources/TranscriberCore/models-manifest.json"
);
export const transcriberLicensesDir = resolve(packageDir, "Licenses");

async function main() {
  const check = process.argv.includes("--check");
  const { manifest, licenseFiles } = await generateTranscriberManifest();
  const outputs = new Map<string, Buffer>([
    [transcriberManifestPath, Buffer.from(serializeManifest(manifest))],
    ...[...licenseFiles].map(
      ([name, bytes]) => [resolve(transcriberLicensesDir, name), bytes] as const
    ),
  ]);

  const drift: string[] = [];
  for (const [path, bytes] of outputs) {
    if (check) {
      let current: Buffer | undefined;
      try {
        current = readFileSync(path);
      } catch {
        current = undefined;
      }
      if (!current?.equals(bytes)) drift.push(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }

  const total = manifest.files.reduce((sum, file) => sum + file.size, 0);
  if (drift.length > 0) {
    console.error(`Out of date:\n${drift.join("\n")}`);
    process.exit(1);
  }
  console.log(
    `${check ? "Checked" : "Wrote"} ${manifest.files.length} model files (${total} bytes) and ${licenseFiles.size} license files.`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
