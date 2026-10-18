import type { LocalBackendStatus } from "@comma/native-bridge";
import type { LocalBackendSnapshot } from "./service";

/** Main's handler of the `localBackend.*` native capabilities. */
export interface LocalBackendProvider {
  state(input: void): LocalBackendStatus;
  retry(input: void): Promise<{ accepted: boolean }>;
  showLogs(input: void): Promise<{ accepted: boolean }>;
}

/** Builds with a remote backend never show the local startup screen. */
export const remoteBackendProvider: LocalBackendProvider = {
  state: () => ({ mode: "remote", phase: "ready" }),
  retry: async () => ({ accepted: false }),
  showLogs: async () => ({ accepted: false }),
};

/**
 * The renderer's view of the local backend. `signing_in` covers the moment
 * between a serving backend and the owner's adopted Session.
 */
export function toLocalBackendStatus(
  snapshot: LocalBackendSnapshot,
  { ownerSignedIn }: { ownerSignedIn: boolean }
): LocalBackendStatus {
  return {
    mode: "local",
    phase: snapshot.phase === "ready" && !ownerSignedIn ? "signing_in" : snapshot.phase,
    ...(snapshot.failure ? { failure: snapshot.failure } : {}),
    logsDir: snapshot.logsDir,
    backupsDir: snapshot.backupsDir,
    ...(snapshot.lastBackupPath ? { lastBackupPath: snapshot.lastBackupPath } : {}),
  };
}
