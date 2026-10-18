import { commaLogoUrl } from "@comma/config";
import { useCommaMessages } from "@comma/i18n/react";
import {
  getNativeBridge,
  type LocalBackendFailureCode,
  type LocalBackendStatus,
} from "@comma/native-bridge";
import {
  Button,
  CircleCheckIcon,
  CircleDashedIcon,
  ExclamationTriangleIcon,
  LoadingCircleIcon,
  Text,
} from "@comma/ui";
import { useEffect, useState, type ReactNode } from "react";

type Messages = ReturnType<typeof useCommaMessages>;
type StepState = "done" | "current" | "pending" | "failed";

/** The local backend status Main publishes; undefined until the first snapshot. */
export function useLocalBackendStatus(
  state = getNativeBridge().localBackend.state
): LocalBackendStatus | undefined {
  const [status, setStatus] = useState<LocalBackendStatus>();
  useEffect(() => state.subscribe(setStatus), [state]);
  return status;
}

/**
 * Renders the app once the local backend serves and the owner is signed in.
 * Builds with a remote backend render it at once. `children` learns whether
 * the app runs in local mode, where the login screen never appears.
 */
export function LocalBackendGate({
  children,
}: {
  children: (localMode: boolean) => ReactNode;
}) {
  const electron = getNativeBridge().platform === "electron";
  const status = useLocalBackendStatus();
  if (!electron) return children(false);
  if (!status) return null;
  if (status.mode === "remote") return children(false);
  if (status.phase === "ready") return children(true);
  return <LocalBackendStartupScreen status={status} />;
}

const stepFailure: Record<LocalBackendFailureCode, number> = {
  start_failed: 0,
  process_stopped: 0,
  backup_failed: 1,
  migration_failed: 1,
  owner_session_failed: 2,
};

function stepStates(status: LocalBackendStatus): StepState[] {
  if (status.phase === "failed" && status.failure) {
    const failed = stepFailure[status.failure.code];
    return [0, 1, 2].map((step) =>
      step < failed ? "done" : step === failed ? "failed" : "pending"
    );
  }
  const current =
    status.phase === "preparing"
      ? 1
      : status.phase === "signing_in"
        ? 2
        : status.phase === "ready"
          ? 3
          : 0;
  return [0, 1, 2].map((step) =>
    step < current ? "done" : step === current ? "current" : "pending"
  );
}

function headline(status: LocalBackendStatus, messages: Messages) {
  if (status.phase === "failed" && status.failure) {
    switch (status.failure.code) {
      case "start_failed":
        return [
          messages.local_backend_error_start_failed_title(),
          messages.local_backend_error_start_failed_copy(),
        ];
      case "backup_failed":
        return [
          messages.local_backend_error_backup_failed_title(),
          messages.local_backend_error_backup_failed_copy(),
        ];
      case "migration_failed":
        return [
          messages.local_backend_error_migration_failed_title(),
          messages.local_backend_error_migration_failed_copy(),
        ];
      case "process_stopped":
        return [
          messages.local_backend_error_process_stopped_title(),
          messages.local_backend_error_process_stopped_copy(),
        ];
      case "owner_session_failed":
        return [
          messages.local_backend_error_owner_session_failed_title(),
          messages.local_backend_error_owner_session_failed_copy(),
        ];
    }
  }
  switch (status.phase) {
    case "preparing":
      return [
        messages.local_backend_preparing_title(),
        messages.local_backend_preparing_copy(),
      ];
    case "signing_in":
    case "ready":
      return [
        messages.local_backend_signing_in_title(),
        messages.local_backend_signing_in_copy(),
      ];
    case "stopping":
    case "stopped":
      return [messages.local_backend_stopping_title(), undefined];
    default:
      return [
        messages.local_backend_starting_title(),
        messages.local_backend_starting_copy(),
      ];
  }
}

function StepIcon({ state }: { state: StepState }) {
  switch (state) {
    case "done":
      return <CircleCheckIcon aria-hidden="true" className="local-backend-step-icon" />;
    case "current":
      return (
        <LoadingCircleIcon
          aria-hidden="true"
          className="local-backend-step-icon motion-safe:animate-spin"
        />
      );
    case "failed":
      return (
        <ExclamationTriangleIcon
          aria-hidden="true"
          className="local-backend-step-icon"
        />
      );
    default:
      return (
        <CircleDashedIcon aria-hidden="true" className="local-backend-step-icon" />
      );
  }
}

/**
 * The window's content while the local backend starts, prepares the data, or
 * signs the owner in, and when any of that fails. It follows the login shell
 * so the first launch reads as one surface.
 */
export function LocalBackendStartupScreen({
  status,
  onRetry = () => void getNativeBridge().localBackend.retry(),
  onShowLogs = () => void getNativeBridge().localBackend.showLogs(),
}: {
  status: LocalBackendStatus;
  onRetry?: () => void;
  onShowLogs?: () => void;
}) {
  const messages = useCommaMessages();
  const [title, copy] = headline(status, messages);
  const failed = status.phase === "failed";
  const states = stepStates(status);
  const stepLabels = [
    messages.local_backend_step_services(),
    messages.local_backend_step_data(),
    messages.local_backend_step_account(),
  ];
  const stateLabel: Record<StepState, string> = {
    done: messages.local_backend_step_done(),
    current: messages.local_backend_step_current(),
    pending: messages.local_backend_step_pending(),
    failed: messages.local_backend_step_failed(),
  };
  const backup = status.lastBackupPath;

  return (
    <main
      aria-busy={!failed}
      className="app-login-shell local-backend-startup"
      data-phase={status.phase}
    >
      <div className="app-login-container">
        <img className="app-login-logo" src={commaLogoUrl} alt="" draggable={false} />
        <section
          className="app-login-panel local-backend-panel"
          aria-label={messages.local_backend_status_label()}
        >
          <div
            className="local-backend-heading"
            key={`${status.phase}:${status.failure?.code ?? ""}`}
          >
            <Text as="h1" weight="semibold" className="app-login-title">
              {title}
            </Text>
            {copy ? (
              <Text size="textSm" className="app-login-copy local-backend-copy">
                {copy}
              </Text>
            ) : null}
          </div>
          {status.phase === "stopping" || status.phase === "stopped" ? null : (
            <ol className="local-backend-steps" aria-live="polite">
              {stepLabels.map((label, index) => (
                <li
                  key={label}
                  className="local-backend-step"
                  data-state={states[index]}
                  aria-current={states[index] === "current" ? "step" : undefined}
                >
                  <StepIcon state={states[index]!} />
                  <span className="local-backend-step-label">{label}</span>
                  <span className="app-sr-only">{stateLabel[states[index]!]}</span>
                </li>
              ))}
            </ol>
          )}
          {failed ? (
            <div className="local-backend-failure">
              {status.failure?.message ? (
                <output role="alert" className="local-backend-detail">
                  <span className="app-sr-only">
                    {messages.local_backend_error_detail_label()}:{" "}
                  </span>
                  {status.failure.message}
                </output>
              ) : null}
              <dl className="local-backend-paths">
                {status.logsDir ? (
                  <div>
                    <dt>{messages.local_backend_logs_label()}</dt>
                    <dd>{status.logsDir}</dd>
                  </div>
                ) : null}
                {backup || status.backupsDir ? (
                  <div>
                    <dt>
                      {backup
                        ? messages.local_backend_backup_label()
                        : messages.local_backend_backups_label()}
                    </dt>
                    <dd>{backup ?? status.backupsDir}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="app-login-actions">
                <Button className="app-login-primary" onPress={onRetry}>
                  {messages.local_backend_try_again()}
                </Button>
                <Button
                  hierarchy="secondary-gray"
                  className="app-login-secondary"
                  onPress={onShowLogs}
                >
                  {messages.local_backend_show_logs()}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
