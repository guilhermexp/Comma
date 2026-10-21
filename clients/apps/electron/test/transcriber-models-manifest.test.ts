import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateTranscriberManifest,
  type ModelPin,
} from "../scripts/transcriber-models-manifest";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const pin: ModelPin = {
  repo: "Org/model-coreml",
  revision: "abc1234def",
  folder: "model",
  variant: "v2",
  component: "diarization",
  runtime: ["Model.mlmodelc", "vocab.json"],
  provenance: "provenance.json",
  licenses: [{ path: "LICENSE", as: "model-LICENSE" }],
};

const weightSha = "a".repeat(64);

function fakeHub(provenance: { path: string; sha256: string; size: number }[]) {
  const routes = new Map<string, unknown>([
    [
      "https://huggingface.co/api/models/Org/model-coreml/tree/abc1234def",
      [
        { type: "directory", path: "Model.mlmodelc", size: 0 },
        { type: "directory", path: "Unused.mlmodelc", size: 0 },
        { type: "file", path: "vocab.json", size: 5 },
        { type: "file", path: "config.json", size: 2 },
      ],
    ],
    [
      "https://huggingface.co/api/models/Org/model-coreml/tree/abc1234def/Model.mlmodelc?recursive=true",
      [
        { type: "directory", path: "Model.mlmodelc/weights", size: 0 },
        { type: "file", path: "Model.mlmodelc/model.mil", size: 3 },
        {
          type: "file",
          path: "Model.mlmodelc/weights/weight.bin",
          size: 9,
          lfs: { oid: weightSha, size: 9 },
        },
      ],
    ],
    ["https://huggingface.co/Org/model-coreml/resolve/abc1234def/vocab.json", "vocab"],
    [
      "https://huggingface.co/Org/model-coreml/resolve/abc1234def/Model.mlmodelc/model.mil",
      "mil",
    ],
    ["https://huggingface.co/Org/model-coreml/resolve/abc1234def/LICENSE", "CC BY 4.0"],
    [
      "https://huggingface.co/Org/model-coreml/resolve/abc1234def/provenance.json",
      JSON.stringify({ artifacts: provenance }),
    ],
    [
      "https://raw.githubusercontent.com/FluidInference/FluidAudio/v0.17.7/LICENSE",
      "Apache-2.0",
    ],
  ]);
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (!routes.has(url)) return new Response("missing", { status: 404 });
    const body = routes.get(url);
    return typeof body === "string" ? new Response(body) : Response.json(body);
  }) as typeof fetch;
}

const publishedProvenance = [
  { path: "vocab.json", sha256: sha("vocab"), size: 5 },
  { path: "Model.mlmodelc/model.mil", sha256: sha("mil"), size: 3 },
  { path: "Model.mlmodelc/weights/weight.bin", sha256: weightSha, size: 9 },
];

describe("transcriber model manifest", () => {
  it("lists only runtime files, with LFS hashes for weights and byte hashes for Git files", async () => {
    const { manifest, licenseFiles } = await generateTranscriberManifest(
      fakeHub(publishedProvenance),
      [pin]
    );

    expect(manifest.id).toBe("model@abc1234+v2");
    // The helper installs and removes each component's folders on their own.
    expect(manifest.components).toEqual({ diarization: ["model"] });
    expect(manifest.files).toEqual([
      { path: "model/.fluidaudio-revision", size: 11, sha256: sha("abc1234def\n") },
      { path: "model/Model.mlmodelc/model.mil", size: 3, sha256: sha("mil") },
      { path: "model/Model.mlmodelc/weights/weight.bin", size: 9, sha256: weightSha },
      { path: "model/vocab.json", size: 5, sha256: sha("vocab") },
    ]);
    expect([...licenseFiles.keys()].toSorted()).toEqual([
      "ATTRIBUTION.md",
      "FluidAudio-LICENSE-Apache-2.0",
      "model-LICENSE",
    ]);
  });

  it("refuses a Git file whose hash differs from the publisher provenance", async () => {
    const tampered = publishedProvenance.map((item) =>
      item.path === "vocab.json" ? { ...item, sha256: sha("other") } : item
    );

    await expect(generateTranscriberManifest(fakeHub(tampered), [pin])).rejects.toThrow(
      /vocab.json does not match provenance.json/
    );
  });
});
