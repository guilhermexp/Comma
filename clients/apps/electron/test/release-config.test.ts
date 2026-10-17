import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseFeedDownloadArgs } from "../scripts/download-release-feed";
import { resolveMacosSigning } from "../scripts/macos-signing";
import { resolveReleaseVersion } from "../scripts/release-version";
import { shipsSleepGuard } from "../scripts/sleep-guard-launchd";
import { getCommaReleaseConfig, getPackableReleaseConfig } from "../src/release-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("desktop release identity", () => {
  it("installs beside the official app and updates from this repository's latest release", () => {
    vi.stubEnv("COMMA_UPDATE_URL", "");
    vi.stubEnv("COMMA_API_BASE_URL", "");
    vi.stubEnv("COMMA_RELEASE_REPOSITORY", "");

    expect(getCommaReleaseConfig("prod")).toMatchObject({
      productName: "Comma",
      appBundleId: "com.guilhermexp.comma",
      packId: "com.guilhermexp.comma",
      urlScheme: "comma-gx",
      runtimeNamespace: "@comma-gx",
      apiBaseUrl: "https://xperience-studio.com",
      updateUrl: "https://github.com/guilhermexp/Comma/releases/latest/download",
    });
  });

  it("lets a build select another API, release repository, or feed", () => {
    vi.stubEnv("COMMA_API_BASE_URL", "https://api.example.test");
    vi.stubEnv("COMMA_RELEASE_REPOSITORY", "someone/Comma");
    expect(getCommaReleaseConfig("prod")).toMatchObject({
      apiBaseUrl: "https://api.example.test",
      updateUrl: "https://github.com/someone/Comma/releases/latest/download",
    });

    vi.stubEnv("COMMA_UPDATE_URL", "http://127.0.0.1:8787/feed");
    expect(getCommaReleaseConfig("prod").updateUrl).toBe("http://127.0.0.1:8787/feed");
  });

  it("packs only the prod flavor and keeps dev without a remote feed", () => {
    vi.stubEnv("COMMA_UPDATE_URL", "");
    expect(getCommaReleaseConfig("dev").updateUrl).toBeUndefined();
    expect(getCommaReleaseConfig("staging").updateUrl).toBeUndefined();

    vi.stubEnv("COMMA_BUILD_FLAVOR", "staging");
    expect(() => getPackableReleaseConfig()).toThrow(
      "Velopack releases are only enabled for COMMA_BUILD_FLAVOR=prod."
    );
    vi.stubEnv("COMMA_BUILD_FLAVOR", "prod");
    expect(getPackableReleaseConfig().releaseChannel).toBe("prod");
  });
});

describe("release tag", () => {
  it("accepts only v<package version>", () => {
    expect(resolveReleaseVersion({ packageVersion: "0.0.2", tag: "v0.0.2" })).toEqual({
      version: "0.0.2",
      tag: "v0.0.2",
    });
    expect(() =>
      resolveReleaseVersion({ packageVersion: "0.0.2", tag: "v0.0.3" })
    ).toThrow("Tag v0.0.3 does not match the app version: expected v0.0.2.");
    expect(() => resolveReleaseVersion({ packageVersion: "0.0.2-beta" })).toThrow(
      "must be X.Y.Z"
    );
  });
});

describe("macOS signing", () => {
  it("signs ad hoc unless Developer ID signing is switched on", () => {
    expect(resolveMacosSigning({})).toEqual({ identity: "-", developerId: false });
    expect(
      resolveMacosSigning({
        COMMA_MACOS_SIGN_IDENTITY: "Developer ID Application: Someone",
      })
    ).toEqual({ identity: "-", developerId: false });
  });

  it("requires an identity for Developer ID and notarizes only with a profile", () => {
    expect(() => resolveMacosSigning({ COMMA_MACOS_SIGN: "1" })).toThrow(
      "COMMA_MACOS_SIGN=1 requires COMMA_MACOS_SIGN_IDENTITY."
    );
    expect(
      resolveMacosSigning({
        COMMA_MACOS_SIGN: "1",
        COMMA_MACOS_SIGN_IDENTITY: "ABC123",
      })
    ).toEqual({
      identity: "ABC123",
      keychain: undefined,
      notaryProfile: undefined,
      developerId: true,
    });
    expect(
      resolveMacosSigning({
        COMMA_MACOS_SIGN: "1",
        COMMA_MACOS_SIGN_IDENTITY: "ABC123",
        COMMA_MACOS_NOTARY_PROFILE: "notary",
      }).notaryProfile
    ).toBe("notary");
  });
});

describe("lid-closed sleep guard", () => {
  it("ships the root daemon in a release only with a signing team to check", () => {
    expect(shipsSleepGuard({ flavor: "prod", developerId: false })).toBe(false);
    expect(shipsSleepGuard({ flavor: "staging", developerId: false })).toBe(false);
    expect(shipsSleepGuard({ flavor: "prod", developerId: true })).toBe(true);
    expect(shipsSleepGuard({ flavor: "dev", developerId: false })).toBe(true);
  });
});

describe("previous release download", () => {
  it("reads GitHub Releases by default and an HTTP feed for rehearsals", () => {
    expect(
      releaseFeedDownloadArgs({
        channel: "prod",
        outputDir: "/tmp/Releases/prod",
        repository: "guilhermexp/Comma",
      })
    ).toEqual([
      "download",
      "github",
      "--repoUrl",
      "https://github.com/guilhermexp/Comma",
      "--channel",
      "prod",
      "--outputDir",
      "/tmp/Releases/prod",
    ]);
    expect(
      releaseFeedDownloadArgs({
        channel: "prod",
        outputDir: "/tmp/Releases/prod",
        repository: "guilhermexp/Comma",
        feedUrl: "http://127.0.0.1:8787/guilhermexp/Comma/releases/latest/download",
      }).slice(0, 4)
    ).toEqual([
      "download",
      "http",
      "--url",
      "http://127.0.0.1:8787/guilhermexp/Comma/releases/latest/download",
    ]);
  });
});
