import type {
  AudioCaptureRecording,
  LocalTranscriptionState,
  MeetingTranscriptionNotice,
  MeetingTranscriptionState,
} from "@comma/native-bridge";
import { CommaI18nProvider } from "@comma/i18n/react";
import {
  createNativeStateBridgeMock,
  installNativeBridgeMock,
} from "@comma/test-utils/native-bridge";
import { act, render, screen } from "@comma/test-utils/render";
import { toast } from "@comma/ui";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommaAuthContext } from "../components/auth-context";
import { LocalTranscriptionNoticeHost } from "../components/LocalTranscriptionNoticeHost";
import {
  transcribableRecordingIds,
  useRecordingTranscribeReady,
  useRecordingTranscription,
} from "../components/useRecordingFileActions";
import type { DriveFile } from "../components/drive/driveStore";
import { DriveFileMenuPopover } from "../components/drive/DriveFileMenu";
import { createTestCommaAuthValue } from "./productInboxProjectionHarness";

const navigate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  window.location.hash = "";
});

const recording: AudioCaptureRecording = {
  channels: 1,
  sampleRate: 48_000,
  durationMs: 600_000,
  file: { name: "call.m4a", size: 3_600_000, mediaType: "audio/mp4" },
  driveFile: { space: "comma-drive", path: "recording/2026-10-20/call.m4a" },
};

const groqReady: MeetingTranscriptionState = {
  provider: "groq",
  ready: true,
  cloud: {
    model: "whisper-large-v3",
    baseHost: "api.groq.com",
    hasKey: true,
    verification: "valid",
  },
  diarization: "ready",
};

const driveFile = (name: string, folderPath = "recording/2026-10-20"): DriveFile => ({
  contentsHash: name,
  deviceId: "mac",
  id: `${folderPath}/${name}`,
  folderPath,
  modifiedAt: 0,
  name,
  sizeBytes: 1,
  spaceId: "comma-drive",
});

function withAuth(children: React.ReactNode) {
  return (
    <CommaI18nProvider locale="en">
      <CommaAuthContext.Provider value={createTestCommaAuthValue()}>
        {children}
      </CommaAuthContext.Provider>
    </CommaI18nProvider>
  );
}

/** Drive's row action: transcribes the fixture recording again. */
function Harness() {
  const transcribe = useRecordingTranscription(
    useContext(CommaAuthContext)?.productLease
  );
  return (
    <button type="button" onClick={() => void transcribe(recording.driveFile)}>
      Transcribe
    </button>
  );
}

describe("install notice for a recording without the local model", () => {
  it("shows the notice with Install, which opens Settings → Meeting", async () => {
    let deliver!: (notice: MeetingTranscriptionNotice) => void;
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: {
        onNotice: (listener: (notice: MeetingTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
      },
    } as never);
    const shown = vi.spyOn(toast, "info");
    render(withAuth(<LocalTranscriptionNoticeHost />));

    act(() => deliver({ kind: "install_local", recording }));

    expect(shown).toHaveBeenCalledOnce();
    const [message, options] = shown.mock.calls[0]!;
    expect(message).toBe(
      "Recording saved. Install local transcription to transcribe it on this Mac."
    );
    expect(options?.actions?.map((action) => action.label)).toEqual([
      "Install",
      "Show in Drive",
    ]);
    act(() => options!.actions![0]!.onPress!());
    expect(window.location.hash).toBe("#/settings?category=meeting");
  });

  it("dismisses every install notice once the model is ready", async () => {
    let deliver!: (notice: MeetingTranscriptionNotice) => void;
    let publish!: (state: LocalTranscriptionState) => void;
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: {
        onNotice: (listener: (notice: MeetingTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
      },
      localTranscription: {
        state: {
          subscribe: (listener: (state: LocalTranscriptionState) => void) => {
            publish = listener;
            return () => undefined;
          },
        },
      },
      audioCapture: {
        transcribeSaved: async () => ({
          status: "failed" as const,
          reason: "local_asr_model_not_installed",
        }),
      } as never,
    } as never);
    const shown = vi.spyOn(toast, "info");
    const failed = vi.spyOn(toast, "error");
    const dismissed = vi.spyOn(toast, "dismiss");
    render(
      withAuth(
        <>
          <LocalTranscriptionNoticeHost />
          <Harness />
        </>
      )
    );
    act(() => deliver({ kind: "install_local", recording }));
    await act(async () => screen.getByRole("button", { name: "Transcribe" }).click());
    const noticeIds = [shown, failed].map((spy) => spy.mock.calls.at(-1)![1]!.id);

    act(() => publish({ supported: true, phase: "downloading", sizeBytes: 1 }));
    expect(dismissed).not.toHaveBeenCalled();
    act(() => publish({ supported: true, phase: "ready", sizeBytes: 1 }));
    for (const id of noticeIds) expect(dismissed).toHaveBeenCalledWith(id);
  });

  it("dismisses the install notices once a cloud provider is selected", () => {
    let deliver!: (notice: MeetingTranscriptionNotice) => void;
    let publish!: (state: MeetingTranscriptionState) => void;
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: {
        onNotice: (listener: (notice: MeetingTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
        state: {
          subscribe: (listener: (state: MeetingTranscriptionState) => void) => {
            publish = listener;
            return () => undefined;
          },
        },
      },
    } as never);
    const shown = vi.spyOn(toast, "info");
    const dismissed = vi.spyOn(toast, "dismiss");
    render(withAuth(<LocalTranscriptionNoticeHost />));
    act(() => deliver({ kind: "install_local", recording }));
    act(() => publish(groqReady));
    expect(dismissed).toHaveBeenCalledWith(shown.mock.calls.at(-1)![1]!.id);
  });

  it("asks to set up a cloud provider that is not ready, from Settings → Meeting", () => {
    let deliver!: (notice: MeetingTranscriptionNotice) => void;
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: {
        onNotice: (listener: (notice: MeetingTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
      },
    } as never);
    const shown = vi.spyOn(toast, "info");
    render(withAuth(<LocalTranscriptionNoticeHost />));

    act(() => deliver({ kind: "configure", recording }));

    const [message, options] = shown.mock.calls.at(-1)!;
    expect(message).toBe("Recording saved. Set up transcription to transcribe it.");
    expect(options?.actions?.map((action) => action.label)).toEqual([
      "Set up",
      "Show in Drive",
    ]);
    act(() => options!.actions![0]!.onPress!());
    expect(window.location.hash).toBe("#/settings?category=meeting");
  });

  it("says a recording was transcribed on this Mac because Groq was unavailable", async () => {
    let deliver!: (notice: MeetingTranscriptionNotice) => void;
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: {
        onNotice: (listener: (notice: MeetingTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
        state: createNativeStateBridgeMock(() => groqReady),
      },
    } as never);
    const shown = vi.spyOn(toast, "info");
    render(withAuth(<LocalTranscriptionNoticeHost />));
    await act(async () => undefined);

    act(() => deliver({ kind: "fallback", reason: "cloud_unreachable", recording }));

    expect(shown.mock.calls.at(-1)![0]).toBe(
      "Transcribed on this Mac: Groq unavailable (no connection)."
    );
  });

  it("does nothing on the web", () => {
    installNativeBridgeMock({ platform: "web" });
    const { container } = render(withAuth(<LocalTranscriptionNoticeHost />));
    expect(container.textContent).toBe("");
  });
});

describe("transcribing a saved recording again", () => {
  it("offers Transcribe only for recordings without a transcript text", () => {
    const files = [
      driveFile("call.m4a"),
      driveFile("done.m4a"),
      driveFile("done.transcript.txt"),
      driveFile("done.transcript.json"),
      driveFile("failed.m4a"),
      driveFile("failed.transcript.json"),
      driveFile("notes.m4a", "notes"),
      driveFile("old.wav", "recording"),
    ];
    expect([...transcribableRecordingIds(files)].toSorted()).toEqual([
      "recording/2026-10-20/call.m4a",
      "recording/2026-10-20/failed.m4a",
    ]);
  });

  it("puts Transcribe in a recording's row menu", async () => {
    const onAction = vi.fn();
    const menu = (transcribeLabel?: string) => (
      <DriveFileMenuPopover
        askCommaAgentLabel="Ask Comma"
        deleteLabel="Delete"
        downloadLabel="Download"
        isOpen
        keepOfflineLabel="Keep Offline"
        onAction={onAction}
        onOpenChange={() => undefined}
        pointerOffsets={null}
        transcribeLabel={transcribeLabel}
        triggerRef={{ current: document.body }}
        writable
      />
    );
    const view = render(menu());
    expect(screen.queryByRole("menuitem", { name: "Transcribe" })).toBeNull();

    view.rerender(menu("Transcribe"));
    await act(async () => screen.getByRole("menuitem", { name: "Transcribe" }).click());
    expect(onAction).toHaveBeenCalledWith("transcribe");
  });

  it("reports a saved transcript", async () => {
    const transcribeSaved = vi.fn(async () => ({ status: "ready" as const }));
    installNativeBridgeMock({
      platform: "electron",
      audioCapture: { transcribeSaved } as never,
    });
    const started = vi.spyOn(toast, "info");
    const done = vi.spyOn(toast, "success");
    render(withAuth(<Harness />));

    await act(async () => screen.getByRole("button", { name: "Transcribe" }).click());

    expect(started).toHaveBeenCalledWith("Transcribing call.m4a…", expect.anything());
    expect(transcribeSaved).toHaveBeenCalledWith({
      driveFile: recording.driveFile,
      session: expect.anything(),
    });
    expect(done.mock.calls.at(-1)![0]).toBe("Transcript saved next to call.m4a.");
  });

  it("turns a missing model into the install notice", async () => {
    installNativeBridgeMock({
      platform: "electron",
      audioCapture: {
        transcribeSaved: async () => ({
          status: "failed" as const,
          reason: "local_asr_model_not_installed",
        }),
      } as never,
    });
    const failed = vi.spyOn(toast, "error");
    render(withAuth(<Harness />));

    await act(async () => screen.getByRole("button", { name: "Transcribe" }).click());

    expect(failed.mock.calls.at(-1)![0]).toBe(
      "call.m4a was not transcribed. Install local transcription in Settings → Meeting."
    );
    const options = failed.mock.calls.at(-1)![1]!;
    expect(options.actions?.map((action) => action.label)).toEqual(["Install"]);
  });

  it("shows the provider's refusal with Try again when no local model can take over", async () => {
    const transcribeSaved = vi.fn(async () => ({
      status: "failed" as const,
      reason: "cloud_asr_failed:cloud_quota",
    }));
    installNativeBridgeMock({
      platform: "electron",
      audioCapture: { transcribeSaved } as never,
      meetingTranscription: { state: createNativeStateBridgeMock(() => groqReady) },
    } as never);
    const failed = vi.spyOn(toast, "error");
    render(withAuth(<Harness />));

    await act(async () => screen.getByRole("button", { name: "Transcribe" }).click());

    expect(failed.mock.calls.at(-1)![0]).toBe(
      "call.m4a was not transcribed. Groq unavailable: quota reached."
    );
    const options = failed.mock.calls.at(-1)![1]!;
    expect(options.actions?.map((action) => action.label)).toEqual(["Try again"]);
    await act(async () => options.actions![0]!.onPress!());
    expect(transcribeSaved).toHaveBeenCalledTimes(2);
  });
});

function Gate() {
  return (
    <p>{useRecordingTranscribeReady() ? "can transcribe" : "cannot transcribe"}</p>
  );
}

describe("Drive's Transcribe gate (add-cloud-meeting-asr, D8)", () => {
  it.each([
    [groqReady, "can transcribe"],
    [
      { ...groqReady, ready: false, reason: "key_rejected" as const },
      "cannot transcribe",
    ],
    [
      {
        provider: "local" as const,
        ready: true,
        diarization: "ready" as const,
      },
      "can transcribe",
    ],
    [
      {
        provider: "local" as const,
        ready: false,
        reason: "local_model_missing" as const,
        diarization: "not_installed" as const,
      },
      "cannot transcribe",
    ],
  ])("follows the selected provider's readiness (%#)", async (state, shown) => {
    installNativeBridgeMock({
      platform: "electron",
      meetingTranscription: { state: createNativeStateBridgeMock(() => state) },
    } as never);
    render(withAuth(<Gate />));
    expect(await screen.findByText(shown)).toBeTruthy();
  });
});
