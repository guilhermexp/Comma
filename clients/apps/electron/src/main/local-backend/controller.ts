import type { LocalBackendStatus } from "@comma/native-bridge";
import type { LocalTranscriptionManager } from "../local-transcription/manager";
import type { MeetingTranscriptionService } from "../local-transcription/meeting-transcription";
import type { LocalPushToTalkTranscriber } from "../local-transcription/push-to-talk-transcriber";
import type { SecureSessionInput } from "../secure-store";
import { LocalOwnerSessionKeeper, mintLocalOwnerSession } from "./owner-session";
import { toLocalBackendStatus, type LocalBackendProvider } from "./provider";
import type { LocalBackendService } from "./service";

/**
 * Main's local-mode composition: starts the backend, keeps the owner signed
 * in, and publishes the startup status the renderer shows. The admin token
 * and the Session token stay in Main; the status carries neither.
 */
export class LocalBackendController implements LocalBackendProvider {
  readonly #service: LocalBackendService;
  readonly #onStatus: (status: LocalBackendStatus) => void;
  readonly #openPath: (path: string) => Promise<string>;
  readonly #fetch: typeof fetch | undefined;
  /** The speech models of this Mac; present in every local-mode build. */
  readonly localTranscription: LocalTranscriptionManager | undefined;
  /** Which engine transcribes meetings: this Mac, Groq or an OpenAI-compatible API. */
  readonly meetingTranscription: MeetingTranscriptionService | undefined;
  /** Transcribes push-to-talk turns with the meeting engine. */
  readonly pushToTalkTranscriber: LocalPushToTalkTranscriber | undefined;
  #keeper: LocalOwnerSessionKeeper | undefined;
  #ownerSignedIn = false;
  #shuttingDown = false;
  #stopping: Promise<void> | undefined;

  constructor(options: {
    service: LocalBackendService;
    onStatus: (status: LocalBackendStatus) => void;
    openPath: (path: string) => Promise<string>;
    fetch?: typeof fetch | undefined;
    localTranscription?: LocalTranscriptionManager | undefined;
    meetingTranscription?: MeetingTranscriptionService | undefined;
    pushToTalkTranscriber?: LocalPushToTalkTranscriber | undefined;
  }) {
    this.#service = options.service;
    this.#onStatus = options.onStatus;
    this.#openPath = options.openPath;
    this.#fetch = options.fetch;
    this.localTranscription = options.localTranscription;
    this.meetingTranscription = options.meetingTranscription;
    this.pushToTalkTranscriber = options.pushToTalkTranscriber;
  }

  /** Chooses ports and writes the configuration; returns the API base URL. */
  prepare() {
    return this.#service.prepare();
  }

  /** Called by the service on every change; republishes the renderer's status. */
  publish() {
    this.#onStatus(this.state());
  }

  state(): LocalBackendStatus {
    return toLocalBackendStatus(this.#service.snapshot(), {
      ownerSignedIn: this.#ownerSignedIn,
    });
  }

  /** Connects the owner's Session to Main's Session store once it exists. */
  attachSession(adopt: (input: SecureSessionInput) => Promise<void>) {
    this.#keeper = new LocalOwnerSessionKeeper({
      mint: () =>
        mintLocalOwnerSession({
          apiBaseUrl: this.#service.apiBaseUrl,
          adminToken: this.#service.adminToken,
          ownerUserId: this.#service.ownerUserId,
          rememberOwner: (userId) => this.#service.rememberOwner(userId),
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
        }),
      adopt,
      onFailure: (message) => this.#service.reportOwnerSessionFailure(message),
    });
  }

  /** Starts the backend and signs the owner in; failures land in the status. */
  async launch() {
    if ((await this.#service.start()) && !this.#shuttingDown)
      await this.#keeper?.ensure();
  }

  /**
   * Quit has begun: closing Main's Session service ends the Session, and that
   * must not mint and adopt a new one while the services close.
   */
  beginShutdown() {
    this.#shuttingDown = true;
  }

  /** Quit was cancelled before the backend stopped: the app keeps running. */
  cancelShutdown() {
    if (!this.#stopping) this.#shuttingDown = false;
  }

  followSessionState(state: { phase: string; reason?: string }) {
    if (this.#shuttingDown) return;
    const signedIn = state.phase === "signed_in";
    if (signedIn !== this.#ownerSignedIn) {
      this.#ownerSignedIn = signedIn;
      this.publish();
    }
    if (this.#service.snapshot().phase === "ready") {
      void this.#keeper?.followSessionState(state);
    }
  }

  async retry() {
    if (this.#shuttingDown) return { accepted: false };
    void (async () => {
      if (await this.#service.retry()) await this.#keeper?.ensure();
    })();
    return { accepted: true };
  }

  async showLogs() {
    const error = await this.#openPath(this.#service.snapshot().logsDir);
    return { accepted: error === "" };
  }

  /** Stops every process once; later calls wait for the same stop. */
  stop() {
    this.#shuttingDown = true;
    this.#stopping ??= this.#service.stop();
    return this.#stopping;
  }
}
