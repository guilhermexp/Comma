import { join } from "node:path";

/** Where the bundled programs live (read-only) and where the installation keeps its data. */
export interface LocalBackendLayout {
  resourcesDir: string;
  dataDir: string;
}

export function localBackendPaths({ resourcesDir, dataDir }: LocalBackendLayout) {
  return {
    postgresBin: (program: string) => join(resourcesDir, "postgres", "bin", program),
    redisServer: join(resourcesDir, "redis", "redis-server"),
    minio: join(resourcesDir, "minio", "minio"),
    commaBin: join(resourcesDir, "comma", "bin", "comma"),
    postgresData: join(dataDir, "postgres"),
    redisData: join(dataDir, "redis"),
    minioData: join(dataDir, "minio"),
    minioCerts: join(dataDir, "minio-certs"),
    releaseTmp: join(dataDir, "release-tmp"),
    logsDir: join(dataDir, "logs"),
    backupsDir: join(dataDir, "backups"),
    configFile: join(dataDir, "config.json"),
    redisConf: join(dataDir, "redis.conf"),
    minioEnv: join(dataDir, "minio.env"),
    pgpass: join(dataDir, "pgpass"),
  };
}

/**
 * `~/Library/Application Support/Comma/local`, separate from the development
 * profile (`@comma-dev`) and the native development stack. A launch with an
 * explicit Electron profile (`--user-data-dir`) keeps the backend inside it,
 * so isolated launches never share an installation.
 */
export function resolveLocalBackendDataDir({
  appData,
  userDataOverride,
}: {
  appData: string;
  userDataOverride?: string | undefined;
}) {
  return userDataOverride
    ? join(userDataOverride, "local-backend")
    : join(appData, "Comma", "local");
}
