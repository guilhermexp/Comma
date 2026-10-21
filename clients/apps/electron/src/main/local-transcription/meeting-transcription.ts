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
import {
  selectedProvider,
  type MeetingProviderStore,
  type StoredCloudProvider,
  type StoredMeetingRecord,
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
/** Tries before a change is refused, so Settings answers within about a second. */
const changeAttempts = 3;
/**
 * The background retry of a provider the helper has not acknowledged: one
 * PUT per interval, doubling up to 30 s, until that revision is acknowledged.
 */
const retryFirstMs = 1_000;
const retryMaxMs = 30_000;

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
  #record: StoredMeetingRecord;
  /** The saved cloud key's last check; kept while Local is selected. */
  #verification: Verification = "idle";
  #changing = false;
  #delivery: Promise<unknown> = Promise.resolve();
  #published: string | undefined;
  /** Counts saved records; the helper acknowledged `#acknowledged` of them. */
  #revision = 0;
  #acknowledged = -1;
  #retry: ReturnType<typeof setTimeout> | undefined;
  #retryDelay = retryFirstMs;

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
    this.#record = this.#store.read();
    // A helper starts with Local, so a saved Local choice is already applied.
    if (this.#record.selected === "local") this.#acknowledged = this.#revision;
  }

  /** True while a cloud provider is selected; Remove then keeps the separator (D3). */
  cloudSelected() {
    return this.#record.selected !== "local";
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
    // Local keeps the saved cloud key, so choosing that provider again needs no new key.
    if (input.kind === "local")
      return this.#select(
        { selected: "local", cloud: this.#record.cloud },
        this.#verification
      );
    if (!this.#store.available())
      return { accepted: false, reason: "secure_storage_unavailable" };
    const saved = this.#record.cloud;
    const baseUrl =
      input.kind === "groq"
        ? groqTranscriptionBaseUrl
        : (input.baseUrl ?? (saved?.kind === input.kind ? saved.baseUrl : undefined));
    if (!baseUrl) return { accepted: false, reason: "invalid_url" };
    const url = checkProviderUrl(baseUrl);
    if (!url.ok) return { accepted: false, reason: url.reason };
    // A saved key is reused only by the provider and origin it was saved for.
    const apiKey =
      input.apiKey?.trim() ??
      (saved?.kind === input.kind && sameOrigin(saved.baseUrl, url.baseUrl)
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
      return await this.#select(
        { selected: candidate.kind, cloud: candidate },
        "valid"
      );
    } finally {
      this.#changing = false;
    }
  }

  /** Deletes the saved key; a selected cloud provider returns to Local. */
  async clearKey(): Promise<MeetingTranscriptionActionResult> {
    if (this.#changing) return { accepted: false, reason: "in_progress" };
    return this.#select({ selected: "local" }, "idle");
  }

  /** Checks the saved key again; also retries a failed separator install. */
  async retryVerify(): Promise<MeetingTranscriptionActionResult> {
    const provider = this.#record.cloud;
    if (!provider) return { accepted: false, reason: "key_missing" };
    if (this.#changing) return { accepted: false, reason: "in_progress" };
    this.#changing = true;
    this.#verification = "checking";
    this.#publish();
    try {
      const outcome = await this.#verify(provider);
      if (this.#record.cloud !== provider)
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
   * the provider so Settings shows it (D6). Returns the selected cloud
   * provider, which the notice names.
   */
  cloudFailed(reason: string): StoredCloudProvider["kind"] | undefined {
    const selected = this.#record.selected;
    if (selected === "local") return undefined;
    if (reason === "cloud_auth_rejected") {
      this.#verification = "rejected";
      this.#publish();
    }
    return selected;
  }

  /**
   * The helper's last cloud failure that no local model took over, if it
   * came at or after `since` while a cloud provider is selected. A meeting
   * Task's audio.transcribe reaches the helper through the backend, so Main
   * learns the reason only here.
   */
  async cloudFailureSince(
    since: Date
  ): Promise<{ reason: string; provider: StoredCloudProvider["kind"] } | undefined> {
    const failure = (await this.#helper.health())?.provider?.lastFailure;
    // The helper reports whole seconds.
    if (!failure || Date.parse(failure.at) < Math.floor(since.getTime() / 1000) * 1000)
      return undefined;
    const provider = this.cloudFailed(failure.reason);
    return provider ? { reason: failure.reason, provider } : undefined;
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

  /**
   * Delivers the saved provider again when the helper has not acknowledged
   * this revision or /health says it lost it; true when sent.
   */
  ensureDelivered(): Promise<boolean> {
    return this.#queueDelivery(async () => {
      const health = await this.#helper.health();
      // A helper from before C6 reports no provider and runs Local only.
      if (!health?.provider) return false;
      if (
        this.#acknowledged === this.#revision &&
        health.provider.configured &&
        health.provider.kind === this.#record.selected
      )
        return false;
      return this.#deliverNow();
    });
  }

  /**
   * Local (also after deleting the key) is never refused: it is saved at
   * once and sent until the helper acknowledges it, with `applying` in the
   * state meanwhile. A cloud provider goes to the helper before it is saved:
   * a change it does not acknowledge is refused and the saved one stays. The
   * helper may still have applied it, so the saved one becomes
   * unacknowledged and goes again.
   */
  async #select(
    record: StoredMeetingRecord,
    verification: Verification
  ): Promise<MeetingTranscriptionActionResult> {
    const provider = selectedProvider(record);
    if (provider.kind === "local") {
      try {
        this.#store.write(record);
      } catch (error) {
        if (error instanceof Error && error.message === "secure_storage_unavailable")
          return { accepted: false, reason: "secure_storage_unavailable" };
        throw error;
      }
      this.#record = record;
      this.#revision++;
      this.#verification = verification;
      this.#log("Meeting transcription uses this Mac.");
      await this.#queueDelivery(() => this.#deliverNow());
      this.localChanged();
      return { accepted: true };
    }
    const acknowledged = await this.#queueDelivery(async () => {
      for (let attempt = 0; attempt < changeAttempts; attempt++) {
        if (attempt > 0)
          await new Promise((resolve) => setTimeout(resolve, deliveryIntervalMs));
        if (await this.#helper.setProvider(provider)) return true;
      }
      return false;
    });
    if (!acknowledged) {
      this.#log("The transcription helper did not acknowledge the new provider.");
      this.#unacknowledged();
      return { accepted: false, reason: "helper_unavailable" };
    }
    try {
      this.#store.write(record);
    } catch (error) {
      this.#unacknowledged();
      if (error instanceof Error && error.message === "secure_storage_unavailable")
        return { accepted: false, reason: "secure_storage_unavailable" };
      throw error;
    }
    this.#record = record;
    this.#revision++;
    this.#acknowledged = this.#revision;
    this.#cancelRetry();
    this.#verification = verification;
    this.#log(
      `Meeting transcription uses ${provider.kind} at ${new URL(provider.baseUrl).host} (${provider.model}).`
    );
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

  /** Sends the saved provider; an acknowledgment counts only for the revision sent. */
  async #deliverNow() {
    const revision = this.#revision;
    const delivered = await this.#helper.setProvider(selectedProvider(this.#record));
    if (!delivered) {
      this.#log("The transcription helper did not accept the provider.");
      this.#scheduleRetry();
      return false;
    }
    if (revision === this.#revision) {
      this.#acknowledged = revision;
      this.#cancelRetry();
      this.#publish();
    }
    return true;
  }

  /** The helper may hold something other than the saved provider. */
  #unacknowledged() {
    this.#revision++;
    this.#scheduleRetry();
    this.#publish();
  }

  #scheduleRetry() {
    if (this.#retry || this.#acknowledged === this.#revision) return;
    const delay = this.#retryDelay;
    this.#retryDelay = Math.min(delay * 2, retryMaxMs);
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      if (this.#acknowledged !== this.#revision)
        void this.#queueDelivery(() => this.#deliverNow());
    }, delay);
    this.#retry.unref?.();
  }

  #cancelRetry() {
    clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#retryDelay = retryFirstMs;
  }

  #snapshot(): MeetingTranscriptionState {
    const local = this.#local.currentState();
    const diarization = this.#local.diarization();
    const { selected, cloud: saved } = this.#record;
    // The saved cloud provider is reported while Local is selected too.
    const cloud = saved
      ? {
          cloud: {
            kind: saved.kind,
            model: saved.model,
            baseHost: new URL(saved.baseUrl).hostname,
            hasKey: true,
            verification: this.#verification,
          },
        }
      : {};
    const base = {
      provider: selected,
      diarization,
      ...cloud,
      ...(this.#acknowledged === this.#revision ? {} : { applying: true as const }),
    } as const;
    if (!local.supported) return { ...base, ready: false, reason: "unsupported" };
    const storageReason = this.#store.available()
      ? undefined
      : ("secure_storage_unavailable" as const);
    if (selected === "local") {
      const ready = local.phase === "ready";
      const reason = storageReason ?? (ready ? undefined : "local_model_missing");
      return { ...base, ready, ...(reason ? { reason } : {}) };
    }
    const reason =
      this.#verification === "rejected"
        ? "key_rejected"
        : diarization !== "ready"
          ? "diarization_missing"
          : undefined;
    return { ...base, ready: !reason, ...(reason ? { reason } : {}) };
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
