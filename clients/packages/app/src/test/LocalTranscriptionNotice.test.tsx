import type {
  AudioCaptureRecording,
  LocalTranscriptionNotice,
} from "@comma/native-bridge";
import { CommaI18nProvider } from "@comma/i18n/react";
import { installNativeBridgeMock } from "@comma/test-utils/native-bridge";
import { act, render, screen } from "@comma/test-utils/render";
import { toast } from "@comma/ui";
import { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommaAuthContext } from "../components/auth-context";
import { LocalTranscriptionNoticeHost } from "../components/LocalTranscriptionNoticeHost";
import {
  transcribableRecordingIds,
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

describe("install notice for a recording without the local model", () => {
  it("shows the notice with Install, which opens Settings → Meeting", async () => {
    let deliver!: (notice: LocalTranscriptionNotice) => void;
    installNativeBridgeMock({
      platform: "electron",
      localTranscription: {
        onNotice: (listener: (notice: LocalTranscriptionNotice) => void) => {
          deliver = listener;
          return () => undefined;
        },
      },
    } as never);
    const shown = vi.spyOn(toast, "info");
    render(withAuth(<LocalTranscriptionNoticeHost />));

    act(() => deliver({ reason: "local_asr_model_not_installed", recording }));

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
});
