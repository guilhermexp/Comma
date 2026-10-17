import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDmgArtifactName,
  normalizeReleaseArtifactNames,
  stageGithubReleaseAssets,
  validateReleaseArtifacts,
} from "../scripts/release-artifacts";

const releaseDirectories: string[] = [];

function createReleaseDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "comma-release-artifacts-"));
  releaseDirectories.push(directory);
  return directory;
}

function getHashes(content: string) {
  return {
    SHA1: createHash("sha1").update(content).digest("hex").toUpperCase(),
    SHA256: createHash("sha256").update(content).digest("hex").toUpperCase(),
  };
}

function getReleaseAsset({
  fileName,
  type,
  content,
  version,
}: {
  fileName: string;
  type: "Full" | "Delta";
  content: string;
  version: string;
}) {
  return {
    PackageId: "com.guilhermexp.comma",
    Version: version,
    Type: type,
    FileName: fileName,
    ...getHashes(content),
    Size: Buffer.byteLength(content),
  };
}

afterEach(() => {
  for (const directory of releaseDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("getDmgArtifactName", () => {
  it("keeps one DMG name across versions for the latest-release download link", () => {
    expect(getDmgArtifactName({ arch: "arm64" })).toBe("Comma-macos-arm64.dmg");
  });
});

describe("release artifact normalization", () => {
  it("keeps full and delta packages distinct and updates every metadata file", async () => {
    const releaseOutputDir = createReleaseDirectory();
    const releaseChannel = "prod";
    const packVersion = "1.2.3";
    const originalFullName = "com.guilhermexp.comma-1.2.3-full.nupkg";
    const originalDeltaName = "com.guilhermexp.comma-1.2.3-delta.nupkg";
    const originalPortableName = "com.guilhermexp.comma-Portable.zip";
    const normalizedFullName = "Comma-1.2.3-full.nupkg";
    const normalizedDeltaName = "Comma-1.2.3-delta.nupkg";
    const normalizedPortableName = "Comma-1.2.3.zip";
    const fullContent = "full package";
    const deltaContent = "delta package";

    writeFileSync(resolve(releaseOutputDir, originalFullName), fullContent);
    writeFileSync(resolve(releaseOutputDir, originalDeltaName), deltaContent);
    writeFileSync(resolve(releaseOutputDir, originalPortableName), "portable");
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({
        Assets: [
          getReleaseAsset({
            fileName: originalFullName,
            type: "Full",
            content: fullContent,
            version: packVersion,
          }),
          getReleaseAsset({
            fileName: originalDeltaName,
            type: "Delta",
            content: deltaContent,
            version: packVersion,
          }),
        ],
      })
    );
    writeFileSync(
      resolve(releaseOutputDir, "assets.prod.json"),
      JSON.stringify([
        { RelativeFileName: originalDeltaName, Type: "Delta" },
        { RelativeFileName: originalFullName, Type: "Full" },
        { RelativeFileName: originalPortableName, Type: "Portable" },
      ])
    );
    writeFileSync(
      resolve(releaseOutputDir, "RELEASES-prod"),
      `${originalFullName}\n${originalDeltaName}\n`
    );

    normalizeReleaseArtifactNames({
      releaseOutputDir,
      packVersion,
      releaseChannel,
    });

    expect(existsSync(resolve(releaseOutputDir, normalizedFullName))).toBe(true);
    expect(existsSync(resolve(releaseOutputDir, normalizedDeltaName))).toBe(true);
    expect(existsSync(resolve(releaseOutputDir, normalizedPortableName))).toBe(true);
    expect(existsSync(resolve(releaseOutputDir, originalFullName))).toBe(false);
    expect(existsSync(resolve(releaseOutputDir, originalDeltaName))).toBe(false);

    const releaseFeed = JSON.parse(
      readFileSync(resolve(releaseOutputDir, "releases.prod.json"), "utf-8")
    ) as { Assets: Array<{ FileName: string; Type: string }> };
    expect(releaseFeed.Assets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          FileName: normalizedFullName,
          Type: "Full",
        }),
        expect.objectContaining({
          FileName: normalizedDeltaName,
          Type: "Delta",
        }),
      ])
    );

    const assetManifest = JSON.parse(
      readFileSync(resolve(releaseOutputDir, "assets.prod.json"), "utf-8")
    ) as Array<{ RelativeFileName: string; Type: string }>;
    expect(assetManifest).toEqual([
      { RelativeFileName: normalizedDeltaName, Type: "Delta" },
      { RelativeFileName: normalizedFullName, Type: "Full" },
      { RelativeFileName: normalizedPortableName, Type: "Portable" },
    ]);
    expect(readFileSync(resolve(releaseOutputDir, "RELEASES-prod"), "utf-8")).toBe(
      `${normalizedFullName}\n${normalizedDeltaName}\n`
    );

    await expect(
      validateReleaseArtifacts({
        releaseOutputDir,
        releaseChannel,
        packVersion,
      })
    ).resolves.toBeUndefined();
  });

  it("fails before renaming when two source files would overwrite one artifact", () => {
    const releaseOutputDir = createReleaseDirectory();
    const packVersion = "1.2.3";
    const firstName = `first-${packVersion}-full.nupkg`;
    const secondName = `second-${packVersion}-full.nupkg`;

    writeFileSync(resolve(releaseOutputDir, firstName), "first");
    writeFileSync(resolve(releaseOutputDir, secondName), "second");

    expect(() =>
      normalizeReleaseArtifactNames({
        releaseOutputDir,
        packVersion,
        releaseChannel: "prod",
      })
    ).toThrow(
      `Release artifact name collision: ${firstName} and ${secondName} both normalize to Comma-${packVersion}-full.nupkg`
    );
    expect(existsSync(resolve(releaseOutputDir, firstName))).toBe(true);
    expect(existsSync(resolve(releaseOutputDir, secondName))).toBe(true);
  });
});

describe("release artifact validation", () => {
  it("rejects a stale feed without the version being published", async () => {
    const releaseOutputDir = createReleaseDirectory();
    const fileName = "Comma-1.2.2-full.nupkg";
    const content = "previous full package";

    writeFileSync(resolve(releaseOutputDir, fileName), content);
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({
        Assets: [
          getReleaseAsset({
            fileName,
            type: "Full",
            content,
            version: "1.2.2",
          }),
        ],
      })
    );

    await expect(
      validateReleaseArtifacts({
        releaseOutputDir,
        releaseChannel: "prod",
        packVersion: "1.2.3",
      })
    ).rejects.toThrow(
      "Release feed must contain exactly one Full asset for 1.2.3; found 0"
    );
  });

  it("rejects a feed where full and delta point at the same physical file", async () => {
    const releaseOutputDir = createReleaseDirectory();
    const fileName = "Comma-1.2.3.nupkg";
    const content = "full package";
    const fullAsset = getReleaseAsset({
      fileName,
      type: "Full",
      content,
      version: "1.2.3",
    });

    writeFileSync(resolve(releaseOutputDir, fileName), content);
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({
        Assets: [{ ...fullAsset }, { ...fullAsset, Type: "Delta" }],
      })
    );

    await expect(
      validateReleaseArtifacts({
        releaseOutputDir,
        releaseChannel: "prod",
        packVersion: "1.2.3",
      })
    ).rejects.toThrow(
      `Release feed filename collision: ${fileName} is used by Full and Delta`
    );
  });

  it("rejects an artifact whose hash does not match the release feed", async () => {
    const releaseOutputDir = createReleaseDirectory();
    const fileName = "Comma-1.2.3-full.nupkg";
    const content = "full package";
    const asset = getReleaseAsset({
      fileName,
      type: "Full",
      content,
      version: "1.2.3",
    });

    writeFileSync(resolve(releaseOutputDir, fileName), content);
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({
        Assets: [{ ...asset, SHA256: "0".repeat(64) }],
      })
    );

    await expect(
      validateReleaseArtifacts({
        releaseOutputDir,
        releaseChannel: "prod",
        packVersion: "1.2.3",
      })
    ).rejects.toThrow(`Release artifact SHA256 mismatch: ${fileName}`);
  });
});

describe("GitHub release asset staging", () => {
  it("publishes only this version's packages so every feed entry resolves beside the feed", () => {
    const releaseOutputDir = createReleaseDirectory();
    const stageDir = resolve(createReleaseDirectory(), "github");
    const previous = getReleaseAsset({
      fileName: "Comma-1.2.2-full.nupkg",
      type: "Full",
      content: "previous full",
      version: "1.2.2",
    });
    const full = getReleaseAsset({
      fileName: "Comma-1.2.3-full.nupkg",
      type: "Full",
      content: "full",
      version: "1.2.3",
    });
    const delta = getReleaseAsset({
      fileName: "Comma-1.2.3-delta.nupkg",
      type: "Delta",
      content: "delta",
      version: "1.2.3",
    });
    for (const [name, content] of [
      [previous.FileName, "previous full"],
      [full.FileName, "full"],
      [delta.FileName, "delta"],
      ["Comma-1.2.3.zip", "portable"],
      ["Comma-macos-arm64.dmg", "dmg"],
      ["assets.prod.json", "[]"],
      ["RELEASES-prod", ""],
    ] as const) {
      writeFileSync(resolve(releaseOutputDir, name), content);
    }
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({ Assets: [previous, full, delta] })
    );

    const files = stageGithubReleaseAssets({
      releaseOutputDir,
      releaseChannel: "prod",
      packVersion: "1.2.3",
      dmgName: "Comma-macos-arm64.dmg",
      stageDir,
    });

    expect(readdirSync(stageDir).toSorted()).toEqual(files.toSorted());
    expect(files.toSorted()).toEqual(
      [
        "releases.prod.json",
        full.FileName,
        delta.FileName,
        "Comma-1.2.3.zip",
        "Comma-macos-arm64.dmg",
      ].toSorted()
    );
    const feed = JSON.parse(
      readFileSync(resolve(stageDir, "releases.prod.json"), "utf-8")
    ) as { Assets: unknown[] };
    expect(feed.Assets).toEqual([full, delta]);
  });

  it("refuses to stage a release whose DMG was not built", () => {
    const releaseOutputDir = createReleaseDirectory();
    const full = getReleaseAsset({
      fileName: "Comma-1.2.3-full.nupkg",
      type: "Full",
      content: "full",
      version: "1.2.3",
    });
    writeFileSync(resolve(releaseOutputDir, full.FileName), "full");
    writeFileSync(resolve(releaseOutputDir, "Comma-1.2.3.zip"), "portable");
    writeFileSync(
      resolve(releaseOutputDir, "releases.prod.json"),
      JSON.stringify({ Assets: [full] })
    );

    expect(() =>
      stageGithubReleaseAssets({
        releaseOutputDir,
        releaseChannel: "prod",
        packVersion: "1.2.3",
        dmgName: "Comma-macos-arm64.dmg",
        stageDir: resolve(createReleaseDirectory(), "github"),
      })
    ).toThrow("Release asset not found");
  });
});
