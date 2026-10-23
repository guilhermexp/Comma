import {
  getCommaConfig,
  parseCommaChannelStrict,
  type CommaChannel,
} from "@comma/config";

export type CommaBuildFlavor = CommaChannel;
export type CommaReleaseChannel = "prod";
/**
 * `local`: the app starts its own backend on this Mac and Main chooses the API
 * URL at launch (clients/apps/electron/RELEASE.md). `remote`: a fixed backend.
 */
export type CommaBackendMode = "local" | "remote";

declare const COMMA_DEFINED_BUILD_FLAVOR: string | undefined;
declare const COMMA_DEFINED_R2_PUBLIC_BASE_URL: string | undefined;
declare const COMMA_DEFINED_UPDATE_URL: string | undefined;
declare const COMMA_DEFINED_API_BASE_URL: string | undefined;
declare const COMMA_DEFINED_BACKEND_MODE: string | undefined;

/** The GitHub repository whose releases carry the desktop app and its feed. */
export const defaultReleaseRepository = "guilhermexp/Comma";

export interface CommaReleaseConfig {
  flavor: CommaBuildFlavor;
  runtimeNamespace: string;
  releaseChannel?: CommaReleaseChannel;
  packageName: string;
  productName: string;
  executableName: string;
  packId: string;
  appBundleId: string;
  appUserModelId: string;
  urlScheme: string;
  backendMode: CommaBackendMode;
  /** Empty in local mode: Main resolves it from the port it chose. */
  apiBaseUrl: string;
  releaseRepository?: string;
  updateUrl?: string;
}

export type CommaPackableReleaseConfig = CommaReleaseConfig & {
  releaseChannel: CommaReleaseChannel;
  releaseRepository: string;
  updateUrl: string;
};

const configs: Record<
  CommaBuildFlavor,
  Omit<CommaReleaseConfig, "releaseRepository" | "updateUrl" | "backendMode">
> = {
  prod: {
    flavor: "prod",
    runtimeNamespace: "@comma-gx",
    releaseChannel: "prod",
    packageName: "comma",
    productName: "Comma",
    executableName: "comma",
    packId: "com.guilhermexp.comma",
    appBundleId: "com.guilhermexp.comma",
    appUserModelId: "com.guilhermexp.comma",
    urlScheme: "comma-gx",
    apiBaseUrl: getCommaConfig("prod").apiBaseUrl,
  },
  staging: {
    flavor: "staging",
    runtimeNamespace: "@comma-staging",
    packageName: "comma-staging",
    productName: "Comma Staging",
    executableName: "comma-staging",
    packId: "surf.comma.desktop.staging",
    appBundleId: "surf.comma.desktop.staging",
    appUserModelId: "surf.comma.desktop.staging",
    urlScheme: "comma-staging",
    apiBaseUrl: getCommaConfig("staging").apiBaseUrl,
  },
  dev: {
    flavor: "dev",
    runtimeNamespace: "@comma-dev",
    packageName: "comma-dev",
    productName: "Comma Dev",
    executableName: "comma-dev",
    packId: "surf.comma.desktop.dev",
    appBundleId: "surf.comma.desktop.dev",
    appUserModelId: "surf.comma.desktop.dev",
    urlScheme: "comma-dev",
    apiBaseUrl: getCommaConfig("dev").apiBaseUrl,
  },
};

function readDefinedValue(name: string) {
  switch (name) {
    case "COMMA_BUILD_FLAVOR":
      return typeof COMMA_DEFINED_BUILD_FLAVOR === "undefined"
        ? undefined
        : COMMA_DEFINED_BUILD_FLAVOR;
    case "COMMA_R2_PUBLIC_BASE_URL":
      return typeof COMMA_DEFINED_R2_PUBLIC_BASE_URL === "undefined"
        ? undefined
        : COMMA_DEFINED_R2_PUBLIC_BASE_URL;
    case "COMMA_UPDATE_URL":
      return typeof COMMA_DEFINED_UPDATE_URL === "undefined"
        ? undefined
        : COMMA_DEFINED_UPDATE_URL;
    case "COMMA_API_BASE_URL":
      return typeof COMMA_DEFINED_API_BASE_URL === "undefined"
        ? undefined
        : COMMA_DEFINED_API_BASE_URL;
    case "COMMA_BACKEND_MODE":
      return typeof COMMA_DEFINED_BACKEND_MODE === "undefined"
        ? undefined
        : COMMA_DEFINED_BACKEND_MODE;
    default:
      return undefined;
  }
}

function readEnv(name: string) {
  return readDefinedValue(name)?.trim() || process.env[name]?.trim();
}

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/**
 * Velopack treats a `github.com` URL as a GitHub source: given the repository
 * URL it asks the GitHub API for the newest non-prerelease release and reads
 * `releases.<channel>.json` and the packages from its assets. Any other path
 * under `github.com` (such as `releases/latest/download`) makes that API lookup
 * answer 404, so the feed must be the bare repository URL.
 */
export function githubReleaseUpdateUrl(repository: string) {
  return `https://github.com/${repository}`;
}

function assertPackableReleaseConfig(
  config: CommaReleaseConfig
): asserts config is CommaPackableReleaseConfig {
  if (!config.releaseChannel || !config.releaseRepository || !config.updateUrl) {
    throw new Error("Velopack releases are only enabled for COMMA_BUILD_FLAVOR=prod.");
  }
}

export function getCommaReleaseConfig(
  flavor = parseCommaChannelStrict(readEnv("COMMA_BUILD_FLAVOR"))
): CommaReleaseConfig {
  const base = configs[flavor];
  const explicitApiBaseUrl = readEnv("COMMA_API_BASE_URL");
  const backendMode = resolveBackendMode(flavor, explicitApiBaseUrl);
  const config: CommaReleaseConfig = {
    ...base,
    backendMode,
    apiBaseUrl: backendMode === "local" ? "" : explicitApiBaseUrl || base.apiBaseUrl,
  };

  if (base.releaseChannel) {
    const releaseRepository =
      readEnv("COMMA_RELEASE_REPOSITORY") || defaultReleaseRepository;
    config.releaseRepository = releaseRepository;
    config.updateUrl =
      readEnv("COMMA_UPDATE_URL") || githubReleaseUpdateUrl(releaseRepository);
  } else {
    const explicitUpdateUrl = readEnv("COMMA_UPDATE_URL");
    if (explicitUpdateUrl) {
      config.updateUrl = explicitUpdateUrl;
    }
  }

  return config;
}

/**
 * The prod release runs its own local backend unless the build names a remote
 * API. Development and staging builds keep their remote backend.
 */
function resolveBackendMode(
  flavor: CommaBuildFlavor,
  explicitApiBaseUrl: string | undefined
): CommaBackendMode {
  const requested = readEnv("COMMA_BACKEND_MODE");
  if (requested === "local" || requested === "remote") return requested;
  if (requested)
    throw new Error(`COMMA_BACKEND_MODE must be local or remote, got ${requested}.`);
  return flavor === "prod" && !explicitApiBaseUrl ? "local" : "remote";
}

export function getPackableReleaseConfig(): CommaPackableReleaseConfig {
  const config = getCommaReleaseConfig();

  assertPackableReleaseConfig(config);

  return config;
}

/**
 * Compute Node host artifacts are published outside the desktop release. A
 * build without `COMMA_R2_PUBLIC_BASE_URL` has no published host; the user
 * must point `COMMA_VMM_DOWNLOAD_URL` at one instead.
 */
export function getPublishedAssetUrl(path: string): string {
  const baseUrl =
    readEnv("COMMA_R2_PUBLIC_BASE_URL") || readEnv("CLOUDFLARE_R2_PUBLIC_BASE_URL");
  return baseUrl ? joinUrl(baseUrl, path) : "";
}
