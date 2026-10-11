import { messages } from "@comma/i18n";
import type { ComputeNodeState } from "@comma/native-bridge";
import { sessionProductLease } from "@comma/session-contract";
import { z } from "zod";
import type { ElectronMainSessionService } from "../session";
import { ComputeProblemError, computeProblem } from "./problem";

const INSTALL_AUTHORIZATION_TIMEOUT_MS = 10_000;

const installDescriptorSchema = z.strictObject({
  exchange_url: z.string().url(),
  expires_at: z.string().min(1),
  one_time_secret: z.string().min(1).max(128),
  operation_id: z.string().min(1).max(128),
  version: z.literal(1),
});

const installAuthorizationResponseSchema = z.strictObject({
  descriptor: installDescriptorSchema,
  operation: z
    .object({
      id: z.string().min(1).max(160),
      registration_id: z.string().min(1).max(160),
    })
    .passthrough(),
});

const operationResponseSchema = z.strictObject({
  operation: z
    .object({
      authorization_status: z.enum([
        "requested",
        "exchange_committed",
        "handed_off",
        "action_required",
        "revoked",
      ]),
      status: z.enum(["processing", "ready", "stopped", "action_required", "removed"]),
      work_activity: z.enum(["idle", "active", "unknown"]).default("unknown"),
    })
    .passthrough(),
});

export class ComputeNodeAuthorizationNotFoundError extends ComputeProblemError {
  constructor() {
    super((locale) =>
      messages.electron_compute_registration_unavailable({}, { locale })
    );
  }
}

const operationFailedMessages = {
  enable: messages.electron_compute_enable_failed,
  disable: messages.electron_compute_disable_failed,
  revoke: messages.electron_compute_revoke_failed,
  "initialize-workload": messages.electron_compute_initialize_workload_failed,
  status: messages.electron_compute_status_failed,
  retry: messages.electron_compute_retry_failed,
};

export type ComputeNodeInstallAuthorizationPhase = z.infer<
  typeof operationResponseSchema
>["operation"]["authorization_status"];

export interface ComputeNodeInstallAuthorizationOwner {
  inspectUnexchangedRequest?(input: {
    workspaceId: string;
    requestId: string;
  }): Promise<{ operationId: string; registrationId: string }>;
  abandon?(input: { workspaceId: string; operationId: string }): Promise<void>;
  inspectRecoveredBinding?(input: {
    workspaceId: string;
    operationId: string;
  }): Promise<RecoveredComputeBinding>;
  authorize(input: {
    requestId: string;
    workspaceId: string;
  }): Promise<{ descriptor: string; operationId: string; registrationId: string }>;
  observe(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]>;
  inspect(input: { operationId: string; workspaceId: string }): Promise<{
    authorizationStatus: ComputeNodeInstallAuthorizationPhase;
    status: ComputeNodeState["status"];
    workActivity: "idle" | "active" | "unknown";
  }>;
  retry(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<{ descriptor: string; operationId: string; registrationId: string }>;
  configure(input: {
    enabled: boolean;
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]>;
  initializeWorkload(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<void>;
  revoke(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]>;
}

export const localWorkloadTargetSchema = z.object({
  registration_id: z.string().min(1).max(200),
  allocation_id: z.string().min(1).max(200),
  generation: z
    .string()
    .max(20)
    .regex(/^[1-9][0-9]*$/),
});
export type LocalWorkloadTarget = z.infer<typeof localWorkloadTargetSchema>;

export const recoveryOperationSchema = z
  .object({
    id: z.string().min(1).max(160),
    registration_id: z.string().min(1).max(160),
    scope_key: z.string().min(1).max(160),
    authorization_status: z.literal("handed_off"),
    status: z.enum(["processing", "ready", "stopped", "action_required"]),
    environment_id: z.string().min(1).max(160),
  })
  .passthrough();
export type RecoveredComputeBinding = z.infer<typeof recoveryOperationSchema>;
export const recoveryChallengeSchema = z
  .object({
    operation_id: z.string(),
    registration_id: z.string(),
    challenge: z
      .object({
        purpose: z.literal("agent-vmm/comma-recovery/1"),
        audience: z.string(),
        subject: z.string(),
        session_id: z.string(),
        tenant_id: z.string(),
        group_id: z.string(),
        scope_key: z.string(),
        environment_id: z.string(),
        operation_id: z.string(),
        registration_id: z.string(),
        nonce: z.string(),
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        expires_at: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type ComputeRecoveryChallenge = z.infer<typeof recoveryChallengeSchema>;

/**
 * Main-owned product authorization. Bearer credentials and one-time
 * descriptors never enter renderer IPC or native replay state.
 */
export class ComputeNodeInstallAuthorization implements ComputeNodeInstallAuthorizationOwner {
  constructor(
    private readonly session: ElectronMainSessionService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = INSTALL_AUTHORIZATION_TIMEOUT_MS
  ) {}

  async inspectUnexchangedRequest(input: { workspaceId: string; requestId: string }) {
    const response = await this.recoveryRequest(
      input.workspaceId,
      `install-operations/requests/${encodeURIComponent(input.requestId)}`,
      undefined,
      false,
      "GET"
    );
    const result = z
      .strictObject({
        operation: z.strictObject({
          id: z.string().min(1).max(160),
          registration_id: z.string().min(1).max(160),
          scope_key: z.literal(input.workspaceId),
          authorization_status: z.enum(["requested", "action_required", "revoked"]),
        }),
      })
      .parse(response);
    return {
      operationId: result.operation.id,
      registrationId: result.operation.registration_id,
    };
  }

  async authorize(input: {
    requestId: string;
    workspaceId: string;
  }): Promise<{ descriptor: string; operationId: string; registrationId: string }> {
    const { credential, lease } = this.credential(
      messages.electron_compute_sign_in_to_enable
    );
    const response = await this.fetcher(
      new URL(
        `/v1/comma/workspaces/${encodeURIComponent(input.workspaceId)}/compute-nodes/agent-vmm/install-operations`,
        lease.audience
      ),
      {
        body: JSON.stringify({}),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          "idempotency-key": input.requestId,
          "x-comma-session-transport": "bearer",
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([
          credential.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      }
    );
    if (response.status === 401) {
      await this.session.reportUnauthorized(credential);
      throw computeProblem(messages.electron_compute_authorization_expired, {});
    }
    if (!response.ok) {
      throw computeProblem(messages.electron_compute_authorization_failed, {
        status: response.status,
      });
    }
    const result = installAuthorizationResponseSchema.parse(await response.json());
    if (result.operation.id !== result.descriptor.operation_id) {
      throw computeProblem(
        messages.electron_compute_authorization_identity_mismatch,
        {}
      );
    }
    return {
      descriptor: JSON.stringify(result.descriptor),
      operationId: result.operation.id,
      registrationId: result.operation.registration_id,
    };
  }

  async observe(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]> {
    return (await this.inspect(input)).status;
  }

  async inspect(input: { operationId: string; workspaceId: string }) {
    const operation = await this.request(input, "GET");
    return {
      authorizationStatus: operation.authorization_status,
      status: operation.status,
      workActivity: operation.work_activity,
    };
  }

  async retry(input: { operationId: string; workspaceId: string }) {
    const result = await this.authorizationRequest(input, "retry");
    if (result.operation.id !== input.operationId) {
      throw computeProblem(messages.electron_compute_retry_identity_mismatch, {});
    }
    return {
      descriptor: JSON.stringify(result.descriptor),
      operationId: result.operation.id,
      registrationId: result.operation.registration_id,
    };
  }

  async configure(input: {
    enabled: boolean;
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]> {
    return (await this.request(input, "POST", input.enabled ? "enable" : "disable"))
      .status;
  }

  async initializeWorkload(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<void> {
    await this.request(input, "POST", "initialize-workload");
  }

  async revoke(input: {
    operationId: string;
    workspaceId: string;
  }): Promise<ComputeNodeState["status"]> {
    return (await this.request(input, "POST", "revoke")).status;
  }

  private async request(
    input: { operationId: string; workspaceId: string },
    method: "GET" | "POST",
    action?: "enable" | "disable" | "revoke" | "initialize-workload"
  ) {
    const { credential, lease } = this.credential(
      messages.electron_compute_sign_in_to_read_status
    );
    const suffix = action ? `/${action}` : "";
    const response = await this.fetcher(
      new URL(
        `/v1/comma/workspaces/${encodeURIComponent(input.workspaceId)}/compute-nodes/agent-vmm/install-operations/${encodeURIComponent(input.operationId)}${suffix}`,
        lease.audience
      ),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.token}`,
          "x-comma-session-transport": "bearer",
        },
        method,
        redirect: "manual",
        signal: AbortSignal.any([
          credential.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      }
    );
    if (response.status === 401) await this.session.reportUnauthorized(credential);
    if (method === "GET")
      this.requireCurrent(credential, messages.electron_compute_status_session_changed);
    if (response.status === 404) throw new ComputeNodeAuthorizationNotFoundError();
    if (!response.ok) {
      throw computeProblem(operationFailedMessages[action ?? "status"], {
        status: response.status,
      });
    }
    const result = operationResponseSchema.parse(await response.json());
    if (method === "GET")
      this.requireCurrent(credential, messages.electron_compute_status_session_changed);
    return result.operation;
  }

  private async authorizationRequest(
    input: { operationId: string; workspaceId: string },
    action: "retry"
  ) {
    const { credential, lease } = this.credential(
      messages.electron_compute_sign_in_to_retry
    );
    const response = await this.fetcher(
      new URL(
        `/v1/comma/workspaces/${encodeURIComponent(input.workspaceId)}/compute-nodes/agent-vmm/install-operations/${encodeURIComponent(input.operationId)}/${action}`,
        lease.audience
      ),
      {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.token}`,
          "x-comma-session-transport": "bearer",
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.any([
          credential.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      }
    );
    if (response.status === 401) await this.session.reportUnauthorized(credential);
    if (!response.ok)
      throw computeProblem(operationFailedMessages[action], {
        status: response.status,
      });
    const result = installAuthorizationResponseSchema.parse(await response.json());
    if (result.operation.id !== result.descriptor.operation_id) {
      throw computeProblem(
        messages.electron_compute_authorization_identity_mismatch,
        {}
      );
    }
    return result;
  }

  async inspectRecoveredBinding(input: { workspaceId: string; operationId: string }) {
    return recoveryOperationSchema.parse(await this.request(input, "GET"));
  }

  async abandon(input: { workspaceId: string; operationId: string }) {
    const response = z
      .object({
        operation: z
          .object({ id: z.string(), authorization_status: z.literal("revoked") })
          .passthrough(),
      })
      .parse(
        await this.recoveryRequest(
          input.workspaceId,
          `install-operations/${encodeURIComponent(input.operationId)}/recovery/abandon`,
          { confirmed: true },
          true
        )
      );
    if (response.operation.id !== input.operationId)
      throw computeProblem(messages.electron_compute_request_identity_changed, {});
  }

  async localMappings(workspaceId: string, targets: LocalWorkloadTarget[]) {
    return z
      .object({
        mappings: z
          .array(
            localWorkloadTargetSchema.extend({
              can_read: z.boolean(),
              can_operate: z.boolean(),
            })
          )
          .max(32),
      })
      .parse(await this.recoveryRequest(workspaceId, "local-mappings", { targets }))
      .mappings;
  }

  async localWorkloads(
    workspaceId: string,
    target: LocalWorkloadTarget,
    afterId?: string
  ) {
    return z
      .object({
        workloads: z
          .array(
            z.object({
              id: z.string().min(1).max(200),
              kind: z.string().max(80),
              observed_state: z.string().max(80),
              phase: z
                .enum([
                  "stopped",
                  "draining",
                  "action_required",
                  "ready",
                  "waiting_connection",
                  "allocating",
                  "starting",
                  "unknown",
                ])
                .optional(),
              updated_at: z.string().optional(),
            })
          )
          .max(32),
        next_cursor: z.string().max(200).nullable().optional(),
      })
      .parse(
        await this.recoveryRequest(workspaceId, "local-workloads", {
          target,
          after_id: afterId ?? "",
        })
      );
  }

  async recoveryCandidates(workspaceId: string, registrationIds: string[]) {
    const response = await this.recoveryRequest(workspaceId, "recovery/candidates", {
      registration_ids: registrationIds,
    });
    return z
      .object({ candidates: z.array(recoveryChallengeSchema).max(32) })
      .parse(response).candidates;
  }

  async recoverBinding(
    workspaceId: string,
    operationId: string,
    proof: unknown,
    consume: boolean
  ) {
    const response = await this.recoveryRequest(
      workspaceId,
      `install-operations/${encodeURIComponent(operationId)}/recovery/${consume ? "consume" : "preview"}`,
      { proof },
      consume
    );
    const operation = z
      .object({ operation: recoveryOperationSchema })
      .parse(response).operation;
    if (operation.id !== operationId || operation.scope_key !== workspaceId)
      throw computeProblem(messages.electron_compute_recovery_binding_changed, {});
    return operation;
  }

  private async recoveryRequest(
    workspaceId: string,
    path: string,
    body: unknown,
    acceptedResult = false,
    method: "GET" | "POST" = "POST"
  ) {
    const { credential, lease } = this.credential(
      messages.electron_compute_sign_in_to_recover
    );
    const response = await this.fetcher(
      new URL(
        `/v1/comma/workspaces/${encodeURIComponent(workspaceId)}/compute-nodes/agent-vmm/${path}`,
        lease.audience
      ),
      {
        method,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
        redirect: "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          "x-comma-session-transport": "bearer",
        },
        signal: AbortSignal.any([
          credential.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      }
    );
    if (response.status === 401) await this.session.reportUnauthorized(credential);
    if (!response.ok) {
      this.requireCurrent(
        credential,
        messages.electron_compute_recovery_session_changed
      );
      throw computeProblem(messages.electron_compute_recovery_failed, {
        status: response.status,
      });
    }
    const result: unknown = await response.json();
    // An already accepted transfer belongs to the original account record even after logout.
    if (!acceptedResult)
      this.requireCurrent(
        credential,
        messages.electron_compute_recovery_session_changed
      );
    return result;
  }

  private credential(
    signInRequired: typeof messages.electron_compute_sign_in_to_enable
  ) {
    const lease = sessionProductLease(this.session.state());
    if (!lease) throw computeProblem(signInRequired, {});
    const credential = this.session.acquireProductCredential({
      authorityInstanceId: lease.authorityInstanceId,
      expectedAudience: lease.audience,
      expectedSessionId: lease.sessionId,
      generation: lease.generation,
    });
    if (!credential)
      throw computeProblem(messages.electron_compute_session_unavailable, {});
    return { credential, lease };
  }

  private requireCurrent(
    credential: ReturnType<ElectronMainSessionService["acquireProductCredential"]> & {},
    sessionChanged: typeof messages.electron_compute_status_session_changed
  ) {
    if (!this.session.isCurrentProductCredential(credential)) {
      throw computeProblem(sessionChanged, {});
    }
  }
}
