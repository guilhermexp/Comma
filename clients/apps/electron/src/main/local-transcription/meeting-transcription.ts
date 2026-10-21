import {
  groqTranscriptionBaseUrl,
  type MeetingTranscriptionActionResult,
  type MeetingTranscriptionNotice,
  type MeetingTranscriptionSetProviderInput,
  type MeetingTranscriptionState,
} from "@comma/native-bridge";
import type { TranscriberProviderClient } from "./helper-provider-client";
import type { LocalTranscriptionManager } from "./manager";
import type { MeetingTranscriptionProvider } from "./meeting-provider";
import type {
  MeetingProviderStore,
  StoredCloudProvider,
  StoredMeetingProvider,
} from "./provider-store";
import {
  checkProviderUrl,
  verifyProviderKey,
  type ProviderVerification,
} from "./provider-verification";

type Verification = NonNullable<MeetingTranscriptionState["cloud"]>["verification"];

/** How long a just-restarted helper gets to answer /health before delivery gives up. */
const deliveryAttempts = 40;
const deliveryIntervalMs = 250;

/**
 * Main's owner of the meeting transcription provider (openspec
 * add-cloud-meeting-asr, D2/D3/D7/D8). It verifies a key before accepting
 * it, keeps the configuration in the encrypted store, delivers it to the
 * serving helper (after the helper starts, on every change, and again when
 * /health reports it lost it), installs the speaker separator a cloud
 * provider needs, and publishes the `meetingTranscription` state.
 */
export class MeetingTranscriptionService implements MeetingTranscriptionProvider {
  readonly #store: MeetingProviderStore;
  readonly #local: LocalTranscriptionManager;
  readonly #helper: TranscriberProviderClient;
  readonly #fetch: typeof fetch | undefined;
  readonly #onState: (state: MeetingTranscriptionState) => void;
  readonly #log: (message: string) => void;
  #provider: StoredMeetingProvider;
  #verification: Verification = "idle";
  #changing = false;
  #delivery: Promise<unknown> = Promise.resolve();
  #published: string | undefined;

  constructor(options: {
    store: MeetingProviderStore;
    local: LocalTranscriptionManager;
    helper: TranscriberProviderClient;
    fetch?: typeof fetch | undefined;
    onState: (state: MeetingTranscriptionState) => void;
    log?: ((message: string) => void) | undefined;
  }) {
    this.#store = options.store;
    this.#local = options.local;
    this.#helper = options.helper;
    this.#fetch = options.fetch;
    this.#onState = options.onState;
    this.#log = options.log ?? (() => undefined);
    this.#provider = this.#store.read();
  }

  /** True while a cloud provider is selected; Remove then keeps the separator (D3). */
  cloudSelected() {
    return this.#provider.kind !== "local";
  }

  async state(): Promise<MeetingTranscriptionState> {
    await this.#local.state();
    return this.#snapshot();
  }

  async setProvider(
    input: MeetingTranscriptionSetProviderInput
  ): Promise<MeetingTranscriptionActionResult> {
    if (!(await this.#local.state()).supported)
      return { accepted: false, reason: "unsupported" };
    if (this.#changing) return { accepted: false, reason: "in_progress" };
    if (input.kind === "local") return this.#select({ kind: "local" }, "idle");
    if (!this.#store.available())
      return { accepted: false, reason: "secure_storage_unavailable" };
    const url =
      input.kind === "groq"
        ? ({ ok: true, baseUrl: groqTranscriptionBaseUrl } as const)
        : checkProviderUrl(input.baseUrl);
    if (!url.ok) return { accepted: false, reason: url.reason };
    const saved = this.#provider;
    // A saved key is reused only by the provider and origin it was saved for.
    const apiKey =
      input.apiKey?.trim() ??
      (saved.kind === input.kind && sameOrigin(saved.baseUrl, url.baseUrl)
        ? saved.apiKey
        : undefined);
    if (!apiKey) return { accepted: false, reason: "key_missing" };
    const candidate: StoredCloudProvider = {
      kind: input.kind,
      baseUrl: url.baseUrl,
      model: input.model.trim(),
      apiKey,
    };
    this.#changing = true;
    try {
      const outcome = await this.#verify(candidate);
      if (outcome !== "valid") {
        this.#log(
          `The ${candidate.kind} transcription key was not accepted (${outcome}) for ${new URL(candidate.baseUrl).host}.`
        );
        return { accepted: false, reason: refusalReason(outcome) };
      }
      return await this.#select(candidate, "valid");
    } finally {
      this.#changing = false;
    }
  }

  async clearKey(): Promise<MeetingTranscriptionActionResult> {
    if (this.#changing) return { accepted: false, reason: "in_progress" };
    return this.#select({ kind: "local" }, "idle");
  }

  /** Checks the saved key again; also retries a failed separator install. */
  async retryVerify(): Promise<MeetingTranscriptionActionResult> {
    const provider = this.#provider;
    if (provider.kind === "local") return { accepted: false, reason: "key_missing" };
    if (this.#changing) return { accepted: false, reason: "in_progress" };
    this.#changing = true;
    this.#verification = "checking";
    this.#publish();
    try {
      const outcome = await this.#verify(provider);
      if (this.#provider !== provider)
        return { accepted: false, reason: "in_progress" };
      this.#verification =
        outcome === "valid"
          ? "valid"
          : outcome === "rejected"
            ? "rejected"
            : "unreachable";
      this.#publish();
      if (outcome !== "valid")
        return { accepted: false, reason: refusalReason(outcome) };
      if (this.#local.diarization() === "failed") void this.#local.installDiarization();
      return { accepted: true };
    } finally {
      this.#changing = false;
    }
  }

  /** The local models changed: republish, and install the separator a cloud provider needs. */
  localChanged() {
    if (this.cloudSelected() && this.#local.diarization() === "not_installed")
      void this.#local.installDiarization();
    this.#publish();
  }

  /**
   * A transcription reported a cloud failure (`cloud_auth_rejected`, …),
   * through a fallback or `cloud_asr_failed:<reason>`. A rejected key marks
   * the provider so Settings shows it (D6).
   */
  cloudFailed(reason: string) {
    if (this.cloudSelected() && reason === "cloud_auth_rejected") {
      this.#verification = "rejected";
      this.#publish();
    }
  }

  /** The notice a just-saved recording needs, if any (D8). */
  async recordingNotice(): Promise<MeetingTranscriptionNotice["kind"] | undefined> {
    const state = await this.state();
    if (state.reason === "unsupported") return undefined;
    if (state.provider === "local")
      return this.#local.needsInstall() ? "install_local" : undefined;
    return state.ready ? undefined : "configure";
  }

  /** The helper (re)started: deliver the provider once it answers /health. */
  helperStarted(): Promise<boolean> {
    return this.#queueDelivery(async () => {
      for (let attempt = 0; attempt < deliveryAttempts; attempt++) {
        if (await this.#helper.health()) return this.#deliverNow();
        await new Promise((resolve) => setTimeout(resolve, deliveryIntervalMs));
      }
      this.#log(
        "The transcription helper did not answer; the provider was not delivered."
      );
      return false;
    });
  }

  /** Delivers the provider again when /health says the helper lost it; true when sent. */
  ensureDelivered(): Promise<boolean> {
    return this.#queueDelivery(async () => {
      const health = await this.#helper.health();
      // A helper from before C6 reports no provider and runs Local only.
      if (!health?.provider) return false;
      if (health.provider.configured && health.provider.kind === this.#provider.kind)
        return false;
      return this.#deliverNow();
    });
  }

  async #select(
    provider: StoredMeetingProvider,
    verification: Verification
  ): Promise<MeetingTranscriptionActionResult> {
    try {
      this.#store.write(provider);
    } catch (error) {
      if (error instanceof Error && error.message === "secure_storage_unavailable")
        return { accepted: false, reason: "secure_storage_unavailable" };
      throw error;
    }
    this.#provider = provider;
    this.#verification = verification;
    this.#log(
      provider.kind === "local"
        ? "Meeting transcription uses this Mac."
        : `Meeting transcription uses ${provider.kind} at ${new URL(provider.baseUrl).host} (${provider.model}).`
    );
    await this.#queueDelivery(() => this.#deliverNow());
    this.localChanged();
    return { accepted: true };
  }

  #verify(provider: StoredCloudProvider): Promise<ProviderVerification> {
    return verifyProviderKey(provider, {
      helperVerify: (candidate) => this.#helper.verify(candidate),
      fetch: this.#fetch,
    });
  }

  #queueDelivery(task: () => Promise<boolean>): Promise<boolean> {
    const next = this.#delivery.then(task, task);
    this.#delivery = next.catch(() => undefined);
    return next;
  }

  async #deliverNow() {
    const delivered = await this.#helper.setProvider(this.#provider);
    if (!delivered) this.#log("The transcription helper did not accept the provider.");
    return delivered;
  }

  #snapshot(): MeetingTranscriptionState {
    const local = this.#local.currentState();
    const diarization = this.#local.diarization();
    const provider = this.#provider;
    const base = { provider: provider.kind, diarization } as const;
    if (!local.supported) return { ...base, ready: false, reason: "unsupported" };
    const storageReason = this.#store.available()
      ? undefined
      : ("secure_storage_unavailable" as const);
    if (provider.kind === "local") {
      const ready = local.phase === "ready";
      const reason = storageReason ?? (ready ? undefined : "local_model_missing");
      return { ...base, ready, ...(reason ? { reason } : {}) };
    }
    const cloud = {
      model: provider.model,
      baseHost: new URL(provider.baseUrl).hostname,
      hasKey: true,
      verification: this.#verification,
    };
    const reason =
      this.#verification === "rejected"
        ? "key_rejected"
        : diarization !== "ready"
          ? "diarization_missing"
          : undefined;
    return { ...base, ready: !reason, ...(reason ? { reason } : {}), cloud };
  }

  #publish() {
    const state = this.#snapshot();
    const serialized = JSON.stringify(state);
    if (serialized === this.#published) return;
    this.#published = serialized;
    this.#onState(state);
  }
}

function sameOrigin(left: string, right: string) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function refusalReason(
  outcome: Exclude<ProviderVerification, "valid">
): NonNullable<MeetingTranscriptionActionResult["reason"]> {
  switch (outcome) {
    case "rejected":
      return "key_rejected";
    case "unreachable":
      return "unreachable";
    case "server_error":
      return "server_error";
    case "insecure_url":
      return "insecure_url";
    case "invalid_url":
      return "invalid_url";
    default:
      return "bad_response";
  }
}
