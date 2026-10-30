import {
  CommaApiError,
  type CommaApiClient,
  type VoiceCallEvent,
} from "@comma/app/api";
import type { ChatTarget } from "@comma/chat-contract";
import {
  idlePushToTalkVoiceSession,
  type PushToTalkVoiceReport,
  type PushToTalkVoiceSession,
} from "@comma/native-bridge";
import type { PushToTalkClock } from "./clock";
import type { PushToTalkImage } from "./screen-capture";

export const liveVoicePollMs = 500;
export const maxAdmissionBudgetMs = 30_000;
export const maxUploadBudgetMs = 30_000;
const maxControlBudgetMs = 30_000;
const maxPollFailures = 3;
export type PushToTalkVoiceApi = Pick<
  CommaApiClient,
  | "startVoiceCall"
  | "appendVoiceCallContext"
  | "voiceCallEvents"
  | "endVoiceCall"
  | "uploadGroupFile"
>;
export interface PushToTalkVoiceHost {
  open(): Promise<void>;
  close(): void;
  publish(session: PushToTalkVoiceSession): void;
}
export interface PushToTalkVoiceProvider {
  voiceSession(_input?: void): PushToTalkVoiceSession;
  voiceOffer(input: {
    generation: number;
    sdp: string;
  }): Promise<{ sdp: string } | null>;
  voiceReport(input: { generation: number; event: PushToTalkVoiceReport }): void;
}
export const idlePushToTalkVoiceProvider: PushToTalkVoiceProvider = {
  voiceSession: () => idlePushToTalkVoiceSession,
  voiceOffer: async () => null,
  voiceReport: () => undefined,
};
export type PushToTalkCallEvent =
  | { kind: "connected" | "audible" | "silent" | "caller_turn" }
  | { kind: "media_delayed"; contextId?: number }
  | { kind: "level"; level: number }
  | { kind: "caption"; text: string; turn: number; final: boolean }
  | { kind: "delegation"; id: string; status: "pending" | "answered" | "failed" }
  | { kind: "context_failed"; contextId: number }
  | { kind: "closed"; reason: string }
  | { kind: "error"; code: string };
export interface PushToTalkLiveCall {
  open(): Promise<ChatTarget>;
  warm(): Promise<void>;
  destroy(): void;
  setListening(listening: boolean): void;
  beginContext(contextId: number, qualifiesAt: number): Promise<void>;
  appendContext(input: {
    contextId: number;
    text: string;
    attachments: PushToTalkImage[];
  }): Promise<void>;
  cancelContext(contextId: number): void;
  failContext(contextId: number): Promise<void>;
  close(): void;
  onEvent(listener: (event: PushToTalkCallEvent) => void): () => void;
}
type ActiveContext = {
  contextId: number;
  abortController: AbortController;
  admitted: Promise<void>;
  resolveAdmission: () => void;
  rejectAdmission: (reason: Error) => void;
  stopBudget?: () => void;
};

type Call = {
  generation: number;
  api: PushToTalkVoiceApi;
  target: ChatTarget;
  ready: Promise<string>;
  resolveReady: (callId: string) => void;
  rejectReady: (reason: Error) => void;
  offering: boolean;
  offerController?: AbortController;
  callId?: string;
  cursor: number;
  pollFailures: number;
  pollController?: AbortController;
  stopPoll?: () => void;
  activeContext?: ActiveContext;
  pendingControls: Set<() => void>;
};

type GptLiveVoiceOptions = {
  api: () => PushToTalkVoiceApi;
  resolveTarget: () => Promise<ChatTarget>;
  runOwned: <T>(handler: () => Promise<T>) => T | Promise<T>;
  host: PushToTalkVoiceHost;
  clock: PushToTalkClock;
  log?: (message: string) => void;
};

/** Main owns call authority; the hidden renderer owns the microphone and peer. */
export class GptLiveVoice implements PushToTalkLiveCall, PushToTalkVoiceProvider {
  readonly #options: GptLiveVoiceOptions;
  readonly #listeners = new Set<(event: PushToTalkCallEvent) => void>();
  #session: PushToTalkVoiceSession = { ...idlePushToTalkVoiceSession };
  #call: Call | undefined;
  #opening = 0;
  #openingPromise: Promise<Call> | undefined;
  #desiredListening = false;
  #currentContextId: number | undefined;
  #qualifiesAt: number | null = null;
  #stopQualification: (() => void) | undefined;
  constructor(options: GptLiveVoiceOptions) {
    this.#options = options;
  }

  onEvent(listener: (event: PushToTalkCallEvent) => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async warm(): Promise<void> {
    if (!this.#call && !this.#session.active) {
      const generation = this.#session.generation + 1;
      this.#publish({
        generation,
        active: true,
        listening: false,
        contextId: null,
        admitted: false,
        qualified: false,
      });
    }
    try {
      await this.#options.host.open();
    } catch (error) {
      this.#options.log?.(`push-to-talk voice warmup failed: ${String(error)}`);
      throw error;
    }
  }

  async open(): Promise<ChatTarget> {
    const opening = ++this.#opening;
    const generation =
      this.#session.active && !this.#call
        ? this.#session.generation
        : this.#session.generation + 1;
    const openingPromise = Promise.resolve(
      this.#options.runOwned(async () => {
        const boundApi = this.#options.api();
        const resolvedTarget = await this.#options.resolveTarget();
        return { api: boundApi, target: resolvedTarget };
      })
    ).then(({ api, target }) => {
      if (opening !== this.#opening) throw new Error("Voice opening was cancelled.");
      const previous = this.#call;
      if (
        previous &&
        previous.target.workspaceId === target.workspaceId &&
        previous.target.groupId === target.groupId &&
        previous.target.conversationId === target.conversationId
      ) {
        return previous;
      }
      if (previous) this.#teardown(previous);
      let resolveReady!: (callId: string) => void;
      let rejectReady!: (reason: Error) => void;
      const ready = new Promise<string>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      void ready.catch(() => undefined);
      const call: Call = {
        generation,
        api,
        target,
        ready,
        resolveReady,
        rejectReady,
        offering: true,
        cursor: 0,
        pollFailures: 0,
        pendingControls: new Set(),
      };
      this.#call = call;
      this.#publish({
        generation: call.generation,
        active: true,
        listening: this.#desiredListening,
        contextId: this.#currentContextId ?? null,
        admitted: false,
      });
      return call;
    });

    this.#openingPromise = openingPromise;
    // Local capture must not wait for the Workspace Chat lookup.
    if (!this.#call) {
      this.#publish({
        generation,
        active: true,
        listening: this.#desiredListening,
        contextId: this.#currentContextId ?? null,
        admitted: false,
      });
    }

    let call: Call | undefined;
    try {
      [call] = await Promise.all([openingPromise, this.#options.host.open()]);
    } catch (error) {
      if (opening === this.#opening) {
        if (this.#call) this.#fail(this.#call, "window");
        else this.close();
      }
      throw error;
    } finally {
      if (this.#openingPromise === openingPromise) {
        this.#openingPromise = undefined;
      }
    }
    if (!call || this.#call !== call) throw new Error("Voice opening was cancelled.");
    return call.target;
  }

  setListening(listening: boolean) {
    this.#desiredListening = listening;
    if (this.#session.active && this.#session.listening !== listening) {
      this.#publish({
        listening,
        qualified:
          this.#qualifiesAt !== null && this.#options.clock.now() >= this.#qualifiesAt,
      });
    }
  }

  async beginContext(contextId: number, qualifiesAt: number): Promise<void> {
    this.#currentContextId = contextId;
    this.#stopQualification?.();
    this.#qualifiesAt = qualifiesAt;
    if (this.#session.active)
      this.#publish({ contextId, qualified: false, admitted: false });
    this.#stopQualification = this.#options.clock.setTimeout(
      () => {
        this.#stopQualification = undefined;
        if (
          this.#currentContextId === contextId &&
          this.#desiredListening &&
          this.#session.active
        ) {
          this.#publish({ qualified: true });
        }
      },
      Math.max(0, qualifiesAt - this.#options.clock.now())
    );

    let call = this.#call;
    if (!call && this.#openingPromise) {
      try {
        call = await this.#openingPromise;
      } catch {
        throw new Error("Voice call failed to open.");
      }
    }
    if (!call || this.#call !== call) throw new Error("Voice call is not active.");
    if (this.#currentContextId !== contextId) throw new Error("Context was cancelled.");

    if (call.activeContext) {
      this.#teardownActiveContext(call, new Error("Superseded by new gesture."));
    }

    const abortController = new AbortController();
    let resolveAdmission!: () => void;
    let rejectAdmission!: (reason: Error) => void;
    const admitted = new Promise<void>((resolve, reject) => {
      resolveAdmission = resolve;
      rejectAdmission = reject;
    });
    void admitted.catch(() => undefined);
    const stopAdmissionBudget = this.#options.clock.setTimeout(() => {
      const timeoutError = new Error("Context admission timed out.");
      abortController.abort(timeoutError);
      rejectAdmission(timeoutError);
    }, maxAdmissionBudgetMs);

    const activeContext: ActiveContext = {
      contextId,
      abortController,
      admitted,
      resolveAdmission,
      rejectAdmission,
      stopBudget: stopAdmissionBudget,
    };
    call.activeContext = activeContext;

    void this.#doBeginContext(call, activeContext).catch(rejectAdmission);
    try {
      await admitted;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      rejectAdmission(err);
      if (call.activeContext === activeContext) {
        delete call.activeContext;
      }
      throw err;
    } finally {
      stopAdmissionBudget();
    }
  }

  async #doBeginContext(call: Call, activeContext: ActiveContext) {
    const { contextId, abortController, resolveAdmission } = activeContext;
    const callId = await call.ready;
    this.#assertActive(call);
    if (abortController.signal.aborted || this.#currentContextId !== contextId) {
      throw new Error("Context was cancelled.");
    }

    await call.api.appendVoiceCallContext(
      call.target.workspaceId,
      callId,
      {
        context_id: contextId,
        status: "pending",
      },
      { signal: abortController.signal }
    );

    this.#assertActive(call);
    if (abortController.signal.aborted || this.#currentContextId !== contextId) {
      throw new Error("Context was cancelled.");
    }

    resolveAdmission();
    this.#publish({ contextId, admitted: true });
  }

  cancelContext(contextId: number): void {
    const call = this.#call;
    if (call?.activeContext && call.activeContext.contextId === contextId) {
      this.#teardownActiveContext(call, new Error("Context cancelled."));
    }
    if (this.#currentContextId === contextId) {
      this.#currentContextId = undefined;
      this.#clearQualification();
      this.#desiredListening = false;
      this.#publish({
        listening: false,
        contextId: null,
        qualified: false,
        admitted: false,
      });
    }
    if (!call) return;
    this.#sendBestEffortControl(call, contextId, "cancelled");
  }

  async failContext(contextId: number): Promise<void> {
    const call = this.#call;
    if (call?.activeContext && call.activeContext.contextId === contextId) {
      this.#teardownActiveContext(call, new Error("Context failed."));
    }
    if (this.#currentContextId === contextId) {
      this.#currentContextId = undefined;
      this.#clearQualification();
      this.#desiredListening = false;
      this.#publish({
        listening: false,
        contextId: null,
        qualified: false,
        admitted: false,
      });
    }
    if (!call) return;
    this.#sendBestEffortControl(call, contextId, "failed");
  }

  #clearQualification() {
    this.#qualifiesAt = null;
    this.#stopQualification?.();
    this.#stopQualification = undefined;
  }

  #sendBestEffortControl(
    call: Call,
    contextId: number,
    status: "failed" | "cancelled"
  ) {
    const abortController = new AbortController();
    let stopTimer: (() => void) | undefined;
    const cleanup = () => {
      if (stopTimer) {
        stopTimer();
        stopTimer = undefined;
      }
      call.pendingControls.delete(cancel);
    };
    const cancel = () => {
      abortController.abort();
      cleanup();
    };
    call.pendingControls.add(cancel);

    stopTimer = this.#options.clock.setTimeout(() => {
      cancel();
    }, maxControlBudgetMs);

    let rejectAbort!: (reason: Error) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(new Error("Control aborted"));
    abortController.signal.addEventListener("abort", onAbort, { once: true });
    void (async () => {
      try {
        const callId = await Promise.race([call.ready, aborted]);
        if (abortController.signal.aborted || this.#call !== call) return;
        await Promise.race([
          call.api.appendVoiceCallContext(
            call.target.workspaceId,
            callId,
            {
              context_id: contextId,
              status,
            },
            { signal: abortController.signal }
          ),
          aborted,
        ]);
      } catch {
        // Safe best effort
      } finally {
        abortController.signal.removeEventListener("abort", onAbort);
        cleanup();
      }
    })();
  }

  #teardownActiveContext(call: Call, reason: Error) {
    const context = call.activeContext;
    if (!context) return;
    delete call.activeContext;
    context.stopBudget?.();
    context.abortController.abort(reason);
    context.rejectAdmission(reason);
  }

  async appendContext(input: {
    contextId: number;
    text: string;
    attachments: PushToTalkImage[];
  }): Promise<void> {
    const call = this.#call;
    if (!call) throw new Error("Voice call is not active.");

    const activeContext = call.activeContext;
    if (!activeContext || activeContext.contextId !== input.contextId) {
      throw new Error("Context is no longer active.");
    }

    await activeContext.admitted;
    this.#assertActive(call);

    if (
      this.#currentContextId !== input.contextId ||
      call.activeContext !== activeContext
    ) {
      throw new Error("Context is no longer current.");
    }

    let rejectBudget!: (reason: Error) => void;
    const budget = new Promise<never>((_resolve, reject) => {
      rejectBudget = reject;
    });
    const budgetTimer = this.#options.clock.setTimeout(() => {
      const timeoutError = new Error("Context upload timed out.");
      activeContext.abortController.abort(timeoutError);
      rejectBudget(timeoutError);
    }, maxUploadBudgetMs);
    activeContext.stopBudget = budgetTimer;

    try {
      await Promise.race([
        this.#doAppendContext(call, input, activeContext.abortController.signal),
        budget,
      ]);
    } finally {
      if (call.activeContext === activeContext) {
        this.#teardownActiveContext(call, new Error("Context operation finished."));
      } else {
        budgetTimer();
      }
    }
  }

  async #doAppendContext(
    call: Call,
    input: { contextId: number; text: string; attachments: PushToTalkImage[] },
    signal: AbortSignal
  ) {
    const callId = await call.ready;
    this.#assertActive(call);

    const attachments = await Promise.all(
      input.attachments.map(async (image) => {
        this.#assertActive(call);
        if (signal.aborted) throw new Error("Upload aborted.");
        const uploaded = await call.api.uploadGroupFile(call.target.groupId, {
          data: new Blob([image.data as Uint8Array<ArrayBuffer>], {
            type: image.mediaType,
          }),
          name: image.name,
          signal,
        });
        this.#assertActive(call);
        return { path: uploaded.path, name: uploaded.name, mime: image.mediaType };
      })
    );

    this.#assertActive(call);
    if (signal.aborted) throw new Error("Upload aborted.");

    await call.api.appendVoiceCallContext(
      call.target.workspaceId,
      callId,
      {
        context_id: input.contextId,
        status: "complete",
        text: input.text,
        attachments,
      },
      { signal }
    );
    this.#assertActive(call);
  }

  close() {
    ++this.#opening;
    if (this.#call) this.#teardown(this.#call);
    this.#desiredListening = false;
    this.#currentContextId = undefined;
    this.#clearQualification();
    this.#publish({
      active: false,
      listening: false,
      contextId: null,
      qualified: false,
      admitted: false,
    });
  }

  destroy() {
    this.close();
    this.#options.host.close();
  }

  voiceSession(): PushToTalkVoiceSession {
    return this.#session;
  }
  async voiceOffer(input: { generation: number; sdp: string }) {
    let call = this.#call;
    if (
      !call &&
      this.#openingPromise &&
      input.generation === this.#session.generation
    ) {
      try {
        call = await this.#openingPromise;
      } catch {
        return null;
      }
    }
    if (!call || call.generation !== input.generation || !call.offering) return null;
    call.offering = false;

    const offerController = new AbortController();
    call.offerController = offerController;
    const stopOfferBudget = this.#options.clock.setTimeout(() => {
      offerController.abort(new Error("Voice offer timed out."));
    }, maxControlBudgetMs);

    try {
      const answer = await call.api.startVoiceCall(call.target.workspaceId, input.sdp, {
        mode: "push_to_talk",
        signal: offerController.signal,
      });
      stopOfferBudget();
      if (call.offerController === offerController) {
        delete call.offerController;
      }
      if (this.#call !== call) {
        void this.#hangup(call, answer.call_id);
        return null;
      }
      call.callId = answer.call_id;
      call.resolveReady(answer.call_id);
      void this.#poll(call);
      return { sdp: answer.sdp };
    } catch (error) {
      stopOfferBudget();
      if (call.offerController === offerController) {
        delete call.offerController;
      }
      this.#fail(call, voiceFailureCode(error));
      return null;
    }
  }

  voiceReport({
    generation,
    event,
  }: {
    generation: number;
    event: PushToTalkVoiceReport;
  }) {
    const call = this.#call;
    if (!this.#session.active || this.#session.generation !== generation) return;
    if (typeof event === "object") {
      if (event.kind === "level") {
        if (this.#session.listening) this.#emit({ kind: "level", level: event.level });
      } else if (event.kind === "media_delayed") {
        this.#emit({ kind: "media_delayed", contextId: event.contextId });
      }
    } else if (event === "failed" || event === "microphone_denied") {
      const code = event === "failed" ? "connection" : event;
      if (call) this.#fail(call, code);
      else {
        this.close();
        this.#emit({ kind: "error", code });
      }
    } else {
      this.#emit({ kind: event });
    }
  }

  async #poll(call: Call) {
    if (this.#call !== call || !call.callId) return;

    const controller = new AbortController();
    call.pollController = controller;
    const stopPollBudget = this.#options.clock.setTimeout(() => {
      controller.abort(new Error("Event poll timed out."));
    }, maxControlBudgetMs);

    try {
      const batch = await call.api.voiceCallEvents(
        call.target.workspaceId,
        call.callId,
        call.cursor,
        { signal: controller.signal }
      );
      stopPollBudget();
      if (call.pollController === controller) {
        delete call.pollController;
      }
      if (this.#call !== call) return;
      if (batch.truncated) {
        this.#fail(call, "events_truncated");
        return;
      }
      call.pollFailures = 0;
      call.cursor = batch.cursor;
      for (const event of batch.events) {
        if (this.#call !== call) return;
        this.#event(call, event);
      }
    } catch (error) {
      stopPollBudget();
      if (call.pollController === controller) {
        delete call.pollController;
      }
      if (this.#call !== call) return;
      if (++call.pollFailures >= maxPollFailures) {
        this.#fail(call, voiceFailureCode(error));
        return;
      }
    }
    if (this.#call === call)
      call.stopPoll = this.#options.clock.setTimeout(() => {
        void this.#poll(call);
      }, liveVoicePollMs);
  }

  #event(call: Call, event: VoiceCallEvent) {
    if (!("kind" in event)) {
      if (event.type === "delegation") {
        this.#emit({ kind: "delegation", id: event.id, status: event.status });
      } else if (event.type === "context_failed") {
        this.#emit({ kind: "context_failed", contextId: event.context_id });
      }
      return;
    }
    if (event.kind === "caption" && event.role === "agent") {
      this.#emit({
        kind: "caption",
        text: event.text,
        turn: event.turn,
        final: event.final,
      });
    } else if (
      event.kind === "caption" &&
      event.role === "caller" &&
      event.text.trim()
    ) {
      this.#emit({ kind: "caller_turn" });
    } else if (event.kind === "error") {
      this.#fail(call, event.code);
    } else if (event.kind === "closed") {
      this.#teardown(call);
      this.#emit({ kind: "closed", reason: event.reason });
    }
  }

  #fail(call: Call, code: string) {
    if (this.#call !== call) return;
    this.#teardown(call);
    this.#emit({ kind: "error", code });
  }

  #assertActive(call: Call) {
    if (this.#call !== call) throw new Error("Voice call is no longer active.");
  }

  #teardown(call: Call) {
    call.offerController?.abort();
    delete call.offerController;
    call.pollController?.abort();
    delete call.pollController;
    call.stopPoll?.();
    call.rejectReady(new Error("Voice call ended."));
    this.#teardownActiveContext(call, new Error("Voice call ended."));
    for (const cancel of call.pendingControls) {
      cancel();
    }
    call.pendingControls.clear();
    this.#currentContextId = undefined;
    this.#clearQualification();
    this.#desiredListening = false;
    if (this.#call === call) {
      this.#call = undefined;
      this.#publish({
        active: false,
        listening: false,
        contextId: null,
        qualified: false,
        admitted: false,
      });
    }
    if (call.callId) void this.#hangup(call, call.callId);
  }
  async #hangup(call: Call, callId: string) {
    const abortController = new AbortController();
    const stopBudget = this.#options.clock.setTimeout(() => {
      abortController.abort(new Error("Hangup timed out."));
    }, maxControlBudgetMs);
    try {
      await call.api.endVoiceCall(call.target.workspaceId, callId, {
        signal: abortController.signal,
      });
    } catch {
      this.#options.log?.("Push-to-talk hangup could not reach the original session.");
    } finally {
      stopBudget();
    }
  }

  #publish(patch: Partial<Omit<PushToTalkVoiceSession, "revision">>) {
    this.#session = {
      ...this.#session,
      ...patch,
      revision: this.#session.revision + 1,
    };
    this.#options.host.publish(this.#session);
  }

  #emit(event: PushToTalkCallEvent) {
    for (const listener of this.#listeners) listener(event);
  }
}

export function voiceFailureCode(error: unknown) {
  return error instanceof CommaApiError
    ? (error.body?.error ?? `http_${error.status}`)
    : "unreachable";
}
