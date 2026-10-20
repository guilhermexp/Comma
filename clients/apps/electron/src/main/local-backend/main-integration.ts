import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LocalBackendStatus } from "@comma/native-bridge";
import { sessionExpectation } from "@comma/session-contract";
import type { CommaReleaseConfig } from "../../release-config";
import {
  persistStartupSession,
  type ElectronMainContext,
} from "../modules/electron-main.module";
import type { SecureSessionInput } from "../secure-store";
import { resolveElectronStartupSession } from "../startup-session";
import { LocalBackendController } from "./controller";
import {
  localTranscriberPath,
  resolveLocalBackendDataDir,
  resolveLocalTranscriptionModelsDir,
} from "./layout";
import { nodeLocalBackendRuntime } from "./runtime";
import { LocalBackendService } from "./service";

/**
 * The local backend of a release build (backendMode "local"). E2E launches
 * that name their own API keep using it.
 */
export function createMainLocalBackend({
  releaseConfig,
  e2eApiBaseUrl,
  isPackaged,
  resourcesPath,
  appPath,
  appData,
  userData,
  appVersion,
  emitStatus,
  openPath,
  log,
}: {
  releaseConfig: Pick<CommaReleaseConfig, "backendMode" | "runtimeNamespace">;
  e2eApiBaseUrl?: string | undefined;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  appData: string;
  userData: string;
  appVersion: string;
  emitStatus: (status: LocalBackendStatus) => void;
  openPath: (path: string) => Promise<string>;
  log: (message: string) => void;
}): LocalBackendController | undefined {
  if (releaseConfig.backendMode !== "local" || e2eApiBaseUrl) return undefined;
  const userDataOverridden = userData !== join(appData, releaseConfig.runtimeNamespace);
  const transcriber = localTranscriber({
    isPackaged,
    resourcesPath,
    appPath,
    appData,
    userDataOverride: userDataOverridden ? userData : undefined,
  });
  const service = new LocalBackendService({
    layout: {
      resourcesDir: isPackaged
        ? join(resourcesPath, "local-backend")
        : (process.env.COMMA_LOCAL_BACKEND_DIR ??
          join(appPath, "dist", "local-backend")),
      dataDir: resolveLocalBackendDataDir({
        appData,
        userDataOverride: userDataOverridden ? userData : undefined,
      }),
    },
    appVersion,
    runtime: nodeLocalBackendRuntime,
    onSnapshot: () => controller.publish(),
    log,
    transcriber,
  });
  const controller = new LocalBackendController({
    service,
    onStatus: emitStatus,
    openPath,
  });
  return controller;
}

/**
 * The bundled CommaTranscriber and its models folder. A build without the
 * helper still starts its backend, with meeting ASR left unconfigured.
 */
export function localTranscriber({
  isPackaged,
  resourcesPath,
  appPath,
  appData,
  userDataOverride,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  appData: string;
  userDataOverride: string | undefined;
}) {
  const executable = localTranscriberPath({ isPackaged, resourcesPath, appPath });
  if (!existsSync(executable)) return undefined;
  return {
    executable,
    modelsDir: resolveLocalTranscriptionModelsDir({ appData, userDataOverride }),
  };
}

/**
 * Stores the owner's Session through the startup-Session path and lets
 * SessionService verify it: the first time as its startup reconcile, later
 * (after Sign out or a rejected Session) as a manual retry.
 */
export async function adoptLocalOwnerSession(
  context: Pick<ElectronMainContext, "secureSessionStore" | "session">,
  apiBaseUrl: string,
  input: SecureSessionInput
) {
  const startupSession = resolveElectronStartupSession({
    apiBaseUrl,
    env: {},
    isPackaged: true,
    localOwnerSession: input,
  });
  if (!startupSession) throw new Error("The local owner Session was not resolved.");
  await persistStartupSession(context.secureSessionStore, startupSession);
  const current = context.session.state();
  const result =
    current.phase === "initializing"
      ? await context.session.initialize()
      : current.phase === "signed_in" || current.phase === "signed_out"
        ? await context.session.reconcile({
            expected: sessionExpectation(current),
            reason: "manual_retry",
          })
        : await context.session.reconcile({ reason: "manual_retry" });
  if (!result.ok) {
    throw new Error(`The local owner Session was not accepted (${result.error.code}).`);
  }
  if (context.session.state().phase !== "signed_in") {
    throw new Error("The local owner Session did not sign in.");
  }
}
