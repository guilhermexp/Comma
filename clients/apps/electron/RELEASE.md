# Desktop release

This document is the contract and runbook for the macOS desktop release of
this repository. It covers Apple silicon (arm64) only.
Cluster releases are in [release operations](../../../docs/release-operations.md).

## Contract

- GitHub Releases of `guilhermexp/Comma` carry the app, its DMG, and its
  Velopack update feed. No other storage is part of the release.
- The workflow is [`desktop-release.yml`](../../../.github/workflows/desktop-release.yml).
  It needs only `GITHUB_TOKEN`. Only the publish job has `contents: write`.
- Velopack is the updater. The installed app reads
  `https://github.com/guilhermexp/Comma/releases/latest/download/releases.prod.json`
  and the packages it lists. GitHub resolves `latest` to the newest
  non-draft, non-prerelease release. Thus every desktop release is a full
  release marked latest. Any other release must be a prerelease.
  The Synch mirror (`synch-v0.1.13`) is a prerelease for this reason.
- The tag is `v<version>`. The version is `clients/apps/electron/package.json`
  `version`, in `X.Y.Z` form. The build fails when the tag and the version
  differ (`scripts/release-version.ts`). Velopack orders updates by this version.
- Each release contains these files:
  - `releases.prod.json`: the feed. It lists only this version's packages.
  - `Comma-<version>-full.nupkg`: the full package.
  - `Comma-<version>-delta.nupkg`: the delta from the previous release, if
    one exists.
  - `Comma-<version>.zip`: the portable app.
  - `Comma-macos-arm64.dmg`: the first-install image. Its name does not change,
    so `releases/latest/download/Comma-macos-arm64.dmg` always starts the
    newest install. The in-app download link opens `releases/latest`.

### Deltas

Before packing, `vpk download github` fetches the latest release's feed and
full package. `vpk pack` then makes a delta from that version.
The feed lists only this version's packages, because Velopack resolves each
file beside the feed and older packages live in older releases.
A client one version behind, with its previous full package in its Velopack
cache, applies the delta. Other clients, including a fresh DMG install,
download the full package. The first release has no delta.

### Identity

| Field              | Value                                     |
| ------------------ | ----------------------------------------- |
| Product name       | `Comma`                                   |
| Bundle and pack ID | `com.guilhermexp.comma`                   |
| URL scheme         | `comma-gx://`                             |
| Data directory     | `~/Library/Application Support/@comma-gx` |
| API base URL       | `https://xperience-studio.com`            |

The repository variable `COMMA_API_BASE_URL` selects another API at build time.
`COMMA_RELEASE_REPOSITORY` (the workflow sets `github.repository`) selects the
release repository, and so the update URL. `COMMA_UPDATE_URL` replaces the
update URL completely. The dev flavor (`Comma Dev`, `@comma-dev`,
`comma-dev://`) does not change. The staging flavor is not a release target.

Limits of this identity:

- The backend maps the `prod` environment to `comma://` for billing and
  Telegram return links. These links do not open this app until the backend
  adds a mapping for `comma-gx`.
- The official app also installs as `/Applications/Comma.app`. The two apps
  cannot both use that path.

### Signing

The release is ad hoc signed (`codesign --sign -`). Apple does not notarize it.
Apple silicon runs ad hoc code, and Velopack replaces the bundle in place.
Ad hoc signing has these effects:

- Gatekeeper blocks the first open of the downloaded app. See first install.
- The designated requirement of ad hoc code is its code hash. Each update has
  a new code hash. macOS can ask again for Keychain access to `Comma Safe
Storage` and for privacy permissions (microphone, screen recording,
  accessibility) after an update.
- `vpk pack` adds its updater and signs the outer bundle again, with the
  hardened runtime. Ad hoc code has no team ID, so library validation would
  refuse Electron's frameworks. The ad hoc release therefore uses
  `build/entitlements.mac.adhoc.entitlements`, which disables library
  validation. Nested helpers are ad hoc signed without the hardened runtime.
  Developer ID releases keep library validation on.

Developer ID signing stays available as an opt-in switch. Set
`COMMA_MACOS_SIGN=1` and `COMMA_MACOS_SIGN_IDENTITY`. Set
`COMMA_MACOS_KEYCHAIN` if the identity is not in the default keychain search
list. Set `COMMA_MACOS_NOTARY_PROFILE` to notarize and staple the app and the
DMG. Without `COMMA_MACOS_SIGN=1` these values have no effect.
The workflow does not configure them.

### Features that need more than ad hoc signing

- Lid-closed keep-awake: the root `CommaSleepGuard` daemon accepts a client
  only by the signing team of the daemon itself. Ad hoc code has no team, and
  any local process can claim a bundle identifier. Thus a release ships the
  daemon, its addon, and its LaunchDaemon plist only with Developer ID
  signing (`scripts/sleep-guard-launchd.ts`). The ad hoc release reports the
  setting as unavailable. Dev builds keep the bundle-identifier check for
  local work.
- AirDrop: OpenDropKit comes from a private repository. A build without
  `OPENDROPKIT_RELEASE_TOKEN` or `COMMA_OPENDROPKIT_BINARY` ships no helper,
  and the app reports AirDrop unavailable. The release workflow never sets them.

## Cut a release

1. Make sure that `main` contains the change. Do not release a feature branch.
2. Set `version` in `clients/apps/electron/package.json` to the new `X.Y.Z`.
   It must be higher than the latest release. Merge that change to `main`.
3. Tag the merge commit and push the tag:

   ```sh
   git tag v0.0.2 <main commit>
   git push origin v0.0.2
   ```

4. Monitor the `Desktop Release` run. The build job takes about one hour on
   `macos-26`.
5. Open the new release. Make sure that it is marked latest and contains the
   files in the contract.
6. Make sure that an installed earlier version shows the update.

To build without publishing, run the workflow manually with `publish` off.
It uploads the release files as a workflow artifact. A manual run with
`publish` on works only with a tag as the ref.

The release name must not exist. To redo a failed publish, delete the release
first. Do not reuse a tag for different code. Use the next version.

## First install

1. Download `Comma-macos-arm64.dmg` from the latest release.
2. Open the DMG and drag `Comma` to `Applications`.
3. Remove the quarantine attribute:

   ```sh
   xattr -dr com.apple.quarantine /Applications/Comma.app
   ```

   Or open Comma, close the warning, and select Open Anyway in System
   Settings > Privacy & Security. On macOS 15 and later, Control-click Open
   no longer bypasses the warning.

4. Open Comma from `Applications`. Do not run it from the DMG: macOS then runs
   a read-only copy that cannot update.

## Rehearse an update locally

The release command runs locally with the same steps as the workflow.
It needs Xcode, Go, Node.js, pnpm, and `vpk` (`dotnet tool install vpk
--version <velopack npm version>`).

1. Serve two release directories under GitHub's URL layout,
   `/<owner>/<repo>/releases/latest/download/<file>` and
   `/<owner>/<repo>/releases/download/<tag>/<file>`.
2. Build version N with `COMMA_UPDATE_URL` and `COMMA_RELEASE_FEED_URL` set to
   the local `releases/latest/download` URL, `COMMA_PACK_VERSION=N`, and
   `pnpm --dir clients/apps/electron release:velopack:prod`.
3. Install N from its DMG. Publish N locally as latest.
4. Build N+1 the same way. It downloads N and makes a delta.
5. Publish N+1 locally. Open N. It downloads N+1 at launch and applies it.

A local rehearsal does not prove GitHub's redirects, API rate limits, or the
runner toolchain. Only the first workflow run proves them.

## Verification

- `pnpm --dir clients exec vitest run apps/electron/test` checks the release
  identity, tag rule, signing switch, SleepGuard gate, and asset staging.
- `actionlint .github/workflows/desktop-release.yml` checks the workflow.
- Unit tests do not prove signing, packaging, or an update. Those need a build.
