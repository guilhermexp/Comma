import { useCommaMessages } from "@comma/i18n/react";
import {
  groqTranscriptionModels,
  type MeetingTranscriptionActionResult,
  type MeetingTranscriptionProvider,
  type MeetingTranscriptionState,
} from "@comma/native-bridge";
import {
  Button,
  InputField,
  type SettingsPanelItem,
  type SettingsPanelSection,
} from "@comma/ui";
import { useState, type ReactNode } from "react";
import { useLocalTranscriptionSection } from "./useLocalTranscriptionSection";
import {
  meetingProviderName,
  useMeetingTranscription,
} from "./useMeetingTranscription";

type Messages = ReturnType<typeof useCommaMessages>;

/** What the user is editing; nothing reaches Main until Save. */
interface Draft {
  kind: MeetingTranscriptionProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  /** Replace was pressed: the saved key gives way to a new field. */
  replacing: boolean;
}

const defaultGroqModel = groqTranscriptionModels[0];

/** A draft for `kind`, filled from the saved cloud provider when it is that one. */
function draftFrom(
  state: MeetingTranscriptionState | undefined,
  kind: MeetingTranscriptionProvider = state?.provider ?? "local"
): Draft {
  const saved = state?.cloud?.kind === kind ? state.cloud : undefined;
  return {
    kind,
    model: saved?.model ?? (kind === "groq" ? defaultGroqModel : ""),
    baseUrl: "",
    apiKey: "",
    replacing: false,
  };
}

function urlHost(value: string) {
  try {
    return new URL(value.trim()).hostname || undefined;
  } catch {
    return undefined;
  }
}

function refusalMessage(
  m: Messages,
  reason: MeetingTranscriptionActionResult["reason"]
): string {
  switch (reason) {
    case "key_rejected":
      return m.settings_meeting_transcription_error_key_rejected();
    case "unreachable":
      return m.settings_meeting_transcription_error_unreachable();
    case "server_error":
      return m.settings_meeting_transcription_error_server();
    case "bad_response":
      return m.settings_meeting_transcription_error_bad_response();
    case "insecure_url":
      return m.settings_meeting_transcription_error_insecure_url();
    case "invalid_url":
      return m.settings_meeting_transcription_error_invalid_url();
    case "key_missing":
      return m.settings_meeting_transcription_error_key_missing();
    case "secure_storage_unavailable":
      return m.settings_meeting_transcription_error_keychain();
    default:
      return m.settings_meeting_transcription_error_other();
  }
}

/**
 * Settings → Work → Meeting → Transcription (openspec add-cloud-meeting-asr,
 * D8): the engine selector with its privacy notice, the cloud provider's
 * fields with Save and the verification state, the speaker separator a
 * cloud provider needs, and the local model row, which stays the fallback.
 * A saved key is never shown; the row offers Replace and Delete instead.
 */
export function useMeetingTranscriptionSection(): {
  section: SettingsPanelSection;
  removalDialog: ReactNode;
} {
  const m = useCommaMessages();
  const { state, pending, refusal, setProvider, clearKey, retryVerify } =
    useMeetingTranscription();
  const savedName =
    state && state.provider !== "local"
      ? meetingProviderName(m, state.provider, state.cloud?.baseHost)
      : undefined;
  const local = useLocalTranscriptionSection({ fallbackProvider: savedName });

  // The draft follows Main's saved provider until the user edits it.
  const savedKey = `${state?.provider}:${state?.cloud?.model}:${state?.cloud?.baseHost}`;
  const [draftFor, setDraftFor] = useState(savedKey);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(state));
  if (draftFor !== savedKey) {
    setDraftFor(savedKey);
    setDraft(draftFrom(state));
  }

  const unavailable = !state || state.reason === "unsupported";
  if (unavailable)
    return {
      section: { ...local.section, title: m.settings_meeting_transcription() },
      removalDialog: local.removalDialog,
    };

  const busy = pending !== undefined;
  const keychainMissing = state.reason === "secure_storage_unavailable";
  const editing = { ...draft };
  const update = (patch: Partial<Draft>) => setDraft({ ...editing, ...patch });
  // The saved cloud provider stays while Local is selected (D2).
  const savedCloud = state.cloud?.kind === draft.kind ? state.cloud : undefined;
  const hasSavedKey = Boolean(savedCloud?.hasKey) && !draft.replacing;
  const verification = savedCloud?.verification;

  const draftName =
    draft.kind === "local"
      ? undefined
      : meetingProviderName(
          m,
          draft.kind,
          savedCloud?.baseHost ?? (draft.baseUrl ? urlHost(draft.baseUrl) : undefined)
        );
  const engineDescription = draftName
    ? m.settings_meeting_transcription_privacy_cloud({ provider: draftName })
    : m.settings_meeting_transcription_privacy_local();

  const engineStatus: SettingsPanelItem["status"] =
    verification === "checking" || state.applying
      ? { label: m.settings_meeting_transcription_status_checking(), color: "blue" }
      : state.reason === "key_rejected"
        ? { label: m.settings_meeting_transcription_status_rejected(), color: "error" }
        : state.ready
          ? { label: m.settings_meeting_transcription_status_ready(), color: "success" }
          : { label: m.settings_meeting_transcription_status_setup(), color: "gray" };

  const items: SettingsPanelItem[] = [
    {
      id: "meeting.transcription.engine",
      title: m.settings_meeting_transcription_engine(),
      description: engineDescription,
      ...(keychainMissing
        ? { errorMessage: m.settings_meeting_transcription_keychain_unavailable() }
        : {}),
      keywords: ["groq", "openai", "whisper", "api", "cloud", "privacy"],
      // The status is the selected engine's; an unsaved choice has none yet.
      ...(draft.kind === state.provider ? { status: engineStatus } : {}),
      control: {
        type: "dropdown",
        ariaLabel: m.settings_meeting_transcription_engine(),
        value: draft.kind,
        disabled: busy,
        items: [
          { id: "local", label: m.settings_meeting_transcription_engine_local() },
          {
            id: "groq",
            label: m.settings_meeting_transcription_engine_groq(),
            disabled: keychainMissing,
          },
          {
            id: "openai_compatible",
            label: m.settings_meeting_transcription_engine_compatible(),
            disabled: keychainMissing,
          },
        ],
        onChange: (id) => {
          const kind = id as MeetingTranscriptionProvider;
          if (kind === draft.kind) return;
          // Local needs nothing to check, so it applies at once.
          if (kind === "local") {
            setDraft(draftFrom(undefined));
            if (state.provider !== "local") void setProvider({ kind: "local" });
            return;
          }
          // A kept key of that provider is reused; Save selects it again.
          setDraft(draftFrom(state, kind));
        },
      },
    },
  ];

  if (draft.kind !== "local") {
    const field = (
      id: string,
      label: string,
      value: string,
      onChange: (value: string) => void,
      extra: { type?: string; placeholder?: string; trailing?: ReactNode } = {}
    ) => (
      <span className="flex w-full items-center gap-md">
        <InputField
          className="w-full"
          fieldSize="sm"
          aria-label={label}
          type={extra.type ?? "text"}
          autoComplete="off"
          spellCheck={false}
          placeholder={extra.placeholder}
          value={value}
          disabled={busy}
          onChange={(event) => onChange(event.target.value)}
          data-testid={id}
        />
        {extra.trailing}
      </span>
    );

    if (draft.kind === "openai_compatible")
      items.push({
        id: "meeting.transcription.url",
        title: m.settings_meeting_transcription_url(),
        description: m.settings_meeting_transcription_url_description(),
        layout: "field",
        control: {
          type: "custom",
          content: field(
            "meeting-transcription-url",
            m.settings_meeting_transcription_url(),
            draft.baseUrl,
            (baseUrl) => update({ baseUrl }),
            {
              type: "url",
              placeholder: savedCloud
                ? `https://${savedCloud.baseHost}/v1`
                : "https://api.example.com/v1",
            }
          ),
        },
      });

    if (hasSavedKey) {
      const recheck = verification === "rejected" || verification === "unreachable";
      items.push({
        id: "meeting.transcription.key",
        title: m.settings_meeting_transcription_key(),
        description: m.settings_meeting_transcription_key_saved(),
        ...(verification === "rejected"
          ? { errorMessage: m.settings_meeting_transcription_key_rejected() }
          : verification === "unreachable"
            ? { errorMessage: m.settings_meeting_transcription_key_unreachable() }
            : {}),
        controlLeading: (
          <span className="flex items-center gap-md">
            {recheck ? (
              <Button
                hierarchy="secondary-gray"
                size="xs"
                isDisabled={busy}
                onPress={() => void retryVerify()}
              >
                {m.settings_meeting_transcription_key_check()}
              </Button>
            ) : null}
            <Button
              hierarchy="secondary-gray"
              size="xs"
              isDisabled={busy}
              onPress={() => update({ replacing: true, apiKey: "" })}
            >
              {m.settings_meeting_transcription_key_replace()}
            </Button>
          </span>
        ),
        control: {
          type: "button",
          label: m.settings_meeting_transcription_key_delete(),
          tone: "danger",
          disabled: busy,
          onPress: () => void clearKey(),
        },
      });
    } else {
      items.push({
        id: "meeting.transcription.key",
        title: m.settings_meeting_transcription_key(),
        description: m.settings_meeting_transcription_key_new(),
        layout: "field",
        control: {
          type: "custom",
          content: field(
            "meeting-transcription-key",
            m.settings_meeting_transcription_key(),
            draft.apiKey,
            (apiKey) => update({ apiKey }),
            {
              type: "password",
              trailing: draft.replacing ? (
                <Button
                  hierarchy="tertiary-gray"
                  size="xs"
                  isDisabled={busy}
                  onPress={() => update({ replacing: false, apiKey: "" })}
                >
                  {m.settings_local_transcription_cancel()}
                </Button>
              ) : null,
            }
          ),
        },
      });
    }

    items.push(
      draft.kind === "groq"
        ? {
            id: "meeting.transcription.model",
            title: m.settings_meeting_transcription_model(),
            description: m.settings_meeting_transcription_groq_quota(),
            control: {
              type: "dropdown",
              ariaLabel: m.settings_meeting_transcription_model(),
              value: draft.model,
              disabled: busy,
              items: groqTranscriptionModels.map((model, index) => ({
                id: model,
                label: model,
                subtitle:
                  index === 0
                    ? m.settings_meeting_transcription_model_accurate()
                    : m.settings_meeting_transcription_model_fast(),
              })),
              onChange: (model) => update({ model }),
            },
          }
        : {
            id: "meeting.transcription.model",
            title: m.settings_meeting_transcription_model(),
            description: m.settings_meeting_transcription_model_compatible(),
            layout: "field",
            control: {
              type: "custom",
              content: field(
                "meeting-transcription-model",
                m.settings_meeting_transcription_model(),
                draft.model,
                (model) => update({ model }),
                { placeholder: "whisper-1" }
              ),
            },
          }
    );

    const apiKey = draft.apiKey.trim();
    const baseUrl = draft.baseUrl.trim();
    const changed =
      Boolean(apiKey) ||
      (savedCloud !== undefined &&
        (state.provider !== draft.kind ||
          draft.model.trim() !== savedCloud.model ||
          Boolean(baseUrl)));
    // A saved OpenAI-compatible API keeps its URL unless a new one is typed.
    const ready =
      changed &&
      Boolean(draft.model.trim()) &&
      (draft.kind === "groq" || Boolean(baseUrl) || savedCloud !== undefined);
    const saving = pending === "setProvider";
    items.push({
      id: "meeting.transcription.save",
      title: m.settings_meeting_transcription_save(),
      description: m.settings_meeting_transcription_save_description(),
      ...(saving
        ? {
            status: {
              label: m.settings_meeting_transcription_status_checking(),
              color: "blue" as const,
            },
          }
        : {}),
      ...(refusal && !saving ? { errorMessage: refusalMessage(m, refusal) } : {}),
      control: {
        type: "button",
        label: m.settings_meeting_transcription_save(),
        disabled: busy || !ready,
        onPress: () =>
          void setProvider(
            draft.kind === "groq"
              ? {
                  kind: "groq",
                  model: draft.model as (typeof groqTranscriptionModels)[number],
                  ...(apiKey ? { apiKey } : {}),
                }
              : {
                  kind: "openai_compatible",
                  ...(baseUrl ? { baseUrl } : {}),
                  model: draft.model.trim(),
                  ...(apiKey ? { apiKey } : {}),
                }
          ),
      },
    });
  }

  if (state.provider !== "local") {
    const diarization = state.diarization;
    items.push({
      id: "meeting.transcription.diarization",
      title: m.settings_meeting_transcription_diarization(),
      description: m.settings_meeting_transcription_diarization_description(),
      keywords: ["speaker", "diarization"],
      status:
        diarization === "ready"
          ? { label: m.settings_meeting_transcription_status_ready(), color: "success" }
          : diarization === "downloading"
            ? {
                label: m.settings_meeting_transcription_diarization_installing(),
                color: "blue",
              }
            : diarization === "failed"
              ? {
                  label: m.settings_meeting_transcription_diarization_failed_status(),
                  color: "error",
                }
              : {
                  label: m.settings_meeting_transcription_diarization_not_installed(),
                  color: "gray",
                },
      ...(diarization === "failed"
        ? {
            errorMessage: m.settings_meeting_transcription_diarization_failed(),
            control: {
              type: "button" as const,
              label: m.settings_meeting_transcription_retry(),
              disabled: busy,
              onPress: () => void retryVerify(),
            },
          }
        : {}),
    });
  }

  return {
    section: {
      id: "meeting.transcription",
      title: m.settings_meeting_transcription(),
      items: [...items, ...local.section.items],
    },
    removalDialog: local.removalDialog,
  };
}
