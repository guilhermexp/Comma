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

| Field              | Value                                        |
| ------------------ | -------------------------------------------- |
| Product name       | `Comma`                                      |
| Bundle and pack ID | `com.guilhermexp.comma`                      |
| URL scheme         | `comma-gx://`                                |
| Data directory     | `~/Library/Application Support/@comma-gx`    |
| Local backend data | `~/Library/Application Support/Comma/local`  |
| API base URL       | The local backend, `http://127.0.0.1:<port>` |

The release has no fixed API URL. It runs its own backend (see local backend)
and Main sets the API URL from the port it chose. A build that sets
`COMMA_API_BASE_URL` (or `COMMA_BACKEND_MODE=remote`) uses that remote API
instead. The workflow sets neither.
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

### Local backend

The release runs on any Apple silicon Mac without Homebrew, Docker, or
developer tools. `Contents/Resources/local-backend/` contains:

| Directory   | Contents                                                             |
| ----------- | -------------------------------------------------------------------- |
| `comma/`    | The `comma` OTP release with its ERTS, NIFs, and the verified kernel |
| `postgres/` | Postgres 16 with `citext`, `pgcrypto`, `btree_gin`, and `pg_trgm`    |
| `redis/`    | `redis-server` without TLS                                           |
| `minio/`    | `minio`                                                              |

`scripts/local-backend/manifest.json` pins every source by version and
SHA-256. A download with another digest fails the build.
`pnpm build:local-backend` builds the tree into `dist/local-backend`:

1. `deps`: OpenSSL, libsodium, libopus, and libuv as static archives, then
   Erlang/OTP linked to that OpenSSL, Elixir, Postgres, Redis, and MinIO, all in
   a prefix under `.tmp/local-backend/` named by the hash of the manifest and the build scripts. The build
   environment has only `/usr/bin:/bin:/usr/sbin:/sbin` on PATH, plus single
   links to `pkg-config`, `cmake`, `go`, `lean`, and `lake`.
2. `release`: `MIX_ENV=prod mix release comma` with that Erlang and Elixir.
3. `assemble`: copies the tree, removes the build's fixed release cookie,
   signs every Mach-O ad hoc, runs the Mach-O gate, and smoke-tests the tree
   with `PATH=/usr/bin:/bin`: `bin/comma eval` and `CREATE EXTENSION` for each
   extension in a temporary `initdb`.

Source choices that differ from the first design: Postgres is built from
source, because the zonky darwin arm64 package has no `pg_dump` or `createdb`.
MinIO is built from its release tag with Go, because `dl.min.io` no longer
serves darwin binaries. OpenSSL is linked statically, so `crypto.so` references
no OpenSSL dylib.

The Mach-O gate (`scripts/local-backend/macho-gate.ts`) runs on the local
backend tree and, before `vpk pack`, on the whole app. It fails when a binary
references a library outside `@rpath`, `@loader_path`, `@executable_path`,
`/usr/lib`, and `/System`, or when an `@rpath` reference can search an
absolute run path outside the system.

At launch, Main (`src/main/local-backend/`):

1. Creates `secrets.json` (mode 0600) with random passwords, keys, the release
   cookie, the admin token, and the subscription storage key. It never
   replaces an existing value.
2. Chooses free ports on `127.0.0.1`, keeps them in `state.json`, and replaces
   a port that another program took.
3. Stops processes that a forced quit left, then starts Postgres (`initdb` and
   `createdb` the first time), Redis, MinIO, and the transcription helper
   (see local transcription).
4. Dumps the database to `backups/` with `pg_dump` when the app version
   changed. It keeps the three most recent dumps.
5. Runs `bin/comma eval "Comma.LocalInstall.run()"`, which creates the storage
   bucket and runs `Comma.FreshInstall.run/0`, then starts `bin/comma start`
   with `COMMA_ENVIRONMENT=local` and `COMMA_DESKTOP_LOCAL=1`.
6. Creates the owner (`owner@local.comma`) and a local Session through the
   loopback-only admin API. The renderer receives neither token.

#### Local transcription helper

`Contents/Resources/native/macos/CommaTranscriber` transcribes meeting
recordings on the Mac with FluidAudio (Parakeet TDT 0.6B v3 and the
Community-1 speaker diarization). The app contains no model weights.
`Contents/Resources/licenses/fluidaudio/` contains the FluidAudio license and
the model licenses and notices.

- Main starts `/usr/sbin/taskpolicy -c utility CommaTranscriber serve` on a
  `127.0.0.1` port from `state.json`, after MinIO and before the backend. It
  starts also when no model is installed.
- The helper reads its bearer token from `asr-token` (mode 0600), never from
  the command line. A request without the token gets `401`.
- `config.json` sets `meetings.asr_template: "local-meeting-asr"` and
  `meetings.local_asr`. `Comma.LocalInstall.run/0` points the
  `local-meeting-asr` template at the helper on each launch. See
  [the backend configuration](../../../systems/DEPLOYMENT.md).
- The helper loads the model only for a transcription and releases it after
  the transcription. It runs one transcription at a time.

A process that stops restarts after 1, 2, 4 … 30 seconds. Five stops within two
minutes show the error screen. Quit stops the backend, Postgres in fast mode,
Redis, and MinIO, kills what remains after the timeout, and then any helper
that still runs from `local-backend/`.

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

On the first open, Comma shows a startup screen while it creates its local
backend: services, then the database, then the account. This takes about one
minute. Comma then opens Home signed in as the owner of the Mac. It shows no
login screen and sends no email. The first open of a new version can take
longer, because Comma backs up the database and applies migrations first.

The local data stays in `~/Library/Application Support/Comma/local`:

| Path           | Contents                                         |
| -------------- | ------------------------------------------------ |
| `postgres/`    | The database                                     |
| `minio/`       | Files                                            |
| `redis/`       | Cache and rate-limit state                       |
| `logs/`        | One log per process; Show logs opens this folder |
| `backups/`     | The three most recent pre-update database dumps  |
| `secrets.json` | This installation's keys (mode 0600)             |
| `state.json`   | Ports, process IDs, app version, owner ID        |

Updates keep this folder. To restore a backup, quit Comma and run
`pg_restore` from `Comma.app/Contents/Resources/local-backend/postgres/bin`
against the database.

To delete the local installation, quit Comma, make sure that no process runs
from `Comma.app/Contents/Resources/local-backend`, and remove
`~/Library/Application Support/Comma/local`. Removing `secrets.json` alone
makes the stored subscription accounts unreadable; remove the whole folder or
keep it.

### Local transcription

Comma can transcribe meeting recordings on the Mac, with a speaker label on
each line. The audio does not leave the Mac. The model is not part of the app.
Install it only if you want this feature.

Requirements: Apple silicon, macOS 15 or later, and the local backend. On other
Macs, Settings shows the reason and no Install button.

To install the model:

1. Open Settings > Work > Meeting.
2. In Local transcription, click Install. The download is about 654 MB.
3. Wait for Ready. The status shows Downloading with a percentage, then
   Preparing. Comma checks the SHA-256 and the size of each file before it
   marks the model ready. A failed or cancelled download leaves no model.
   Ready closes the "Install local transcription" notices.

The model stays in `~/Library/Application Support/Comma/Models`, outside
`local/`. Removing one does not remove the other.

After the install, each new meeting recording gets `<name>.transcript.txt` and
`<name>.transcript.json` beside it in Drive. Each line has the form
`[HH:MM:SS] Speaker N: text`. Without the model, Comma saves the recording and
shows "Install local transcription" with an Install button. To transcribe a saved recording later,
select Transcribe on the recording in Drive. Recordings up to 64 MiB (about
two hours) are accepted.

To remove the model, click Remove in the same section and confirm. Comma
deletes the `Models` folder. Remove is refused while a transcription runs.

Limits:

- The model learned Portuguese mostly from European Portuguese. Names and
  slang in Brazilian Portuguese can be wrong.
- When two people speak at the same time, the line gets one speaker.
- A word more than one second away from any detected speech has no speaker
  and starts a line without a `Speaker N` label.
- The first transcription after a macOS update can be slower, because macOS
  prepares the model again.

Attribution: FluidAudio (Apache-2.0, Fluid Inference). Parakeet TDT 0.6B v3
(CC BY 4.0, NVIDIA; Core ML conversion by Fluid Inference). Speaker
diarization Community-1 (CC BY 4.0, pyannote; with WeSpeaker and BUT
Speech@FIT components). The full texts are in
`Comma.app/Contents/Resources/licenses/fluidaudio/`.

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
- `pnpm --dir clients exec vitest run apps/electron/src/main/test/local-backend-*.test.ts`
  checks secrets, ports, configuration, supervision, backups, and the owner
  Session with fake processes.
- After `pnpm build:local-backend`, `pnpm --dir clients exec vitest run
apps/electron/test/local-backend-runtime.test.ts` starts the real tree on an
  empty data directory. The workflow runs it after the build.
- With a packaged app, `COMMA_ELECTRON_LOCAL_MODE_APP=<path>/Comma.app pnpm
--dir clients exec playwright test apps/electron/e2e/local-mode-packaged.spec.ts
--no-deps` launches it with `PATH=/usr/bin:/bin`, checks Home without login,
  a Router answer, quit, and reopen.
- With a packaged app on Apple silicon, add
  `COMMA_ELECTRON_LOCAL_ASR_AUDIO=<short two-voice .m4a>` to the command above
  and select `-g "local transcription"`. The test downloads the real model,
  checks the install notice, Downloading, Preparing, and Ready (which closes
  the notice), a transcript with Speaker 1 and Speaker 2 lines, and Remove
  with its confirmation. It moves the profile's Drive
  source to a temporary folder first, because Drive otherwise publishes
  `~/Comma Drive`. Set `COMMA_PLAYWRIGHT_SKIP_WEB_SERVER=1` for both packaged
  tests.
- `swift test` in `native/macos/CommaTranscriber` checks the model manifest,
  the staged install, the speaker merge, and the HTTP routes of the helper.
- Unit tests do not prove signing, packaging, or an update. Those need a build.
