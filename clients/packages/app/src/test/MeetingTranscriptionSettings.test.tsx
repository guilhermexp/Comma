import type {
  LocalTranscriptionState,
  MeetingTranscriptionActionResult,
  MeetingTranscriptionState,
} from "@comma/native-bridge";
import { CommaI18nProvider } from "@comma/i18n/react";
import {
  createNativeStateBridgeMock,
  installNativeBridgeMock,
} from "@comma/test-utils/native-bridge";
import userEvent from "@testing-library/user-event";
import { fireEvent, render, screen, waitFor } from "@comma/test-utils/render";
import { SettingsPanel } from "@comma/ui";
import { describe, expect, it, vi } from "vitest";
import { useMeetingTranscriptionSection } from "../components/useMeetingTranscriptionSection";

const localNotInstalled: LocalTranscriptionState = {
  supported: true,
  phase: "not_installed",
  sizeBytes: 654_000_000,
};
const localReady: LocalTranscriptionState = { ...localNotInstalled, phase: "ready" };
const local: MeetingTranscriptionState = {
  provider: "local",
  ready: false,
  reason: "local_model_missing",
  diarization: "not_installed",
};
const groqReady: MeetingTranscriptionState = {
  provider: "groq",
  ready: true,
  cloud: {
    kind: "groq",
    model: "whisper-large-v3",
    baseHost: "api.groq.com",
    hasKey: true,
    verification: "valid",
  },
  diarization: "ready",
};

function Section() {
  const { section, removalDialog } = useMeetingTranscriptionSection();
  return (
    <>
      <SettingsPanel sections={[section]} title="Meeting" />
      {removalDialog}
    </>
  );
}

function renderSection(
  state: MeetingTranscriptionState,
  {
    localState = localNotInstalled,
    result = { accepted: true },
  }: {
    localState?: LocalTranscriptionState;
    result?:
      | MeetingTranscriptionActionResult
      | Promise<MeetingTranscriptionActionResult>;
  } = {}
) {
  const actions = {
    setProvider: vi.fn(async () => result),
    clearKey: vi.fn(async () => ({ accepted: true })),
    retryVerify: vi.fn(async () => ({ accepted: true })),
  };
  installNativeBridgeMock({
    platform: "electron",
    localTranscription: {
      state: createNativeStateBridgeMock(() => localState),
      install: vi.fn(async () => ({ accepted: true })),
      cancel: vi.fn(async () => ({ accepted: true })),
      remove: vi.fn(async () => ({ accepted: true })),
    },
    meetingTranscription: {
      state: createNativeStateBridgeMock(() => state),
      ...actions,
    },
  } as never);
  render(
    <CommaI18nProvider locale="en">
      <Section />
    </CommaI18nProvider>
  );
  return actions;
}

const engine = () => screen.findByRole("button", { name: /Transcription engine/ });

async function choose(option: string) {
  await userEvent.click(await engine());
  await userEvent.click(await screen.findByRole("option", { name: option }));
}

describe("Settings → Meeting → Transcription engine (add-cloud-meeting-asr, D8)", () => {
  it("starts on Local and says the audio never leaves the Mac", async () => {
    renderSection(local);
    expect(await engine()).toHaveTextContent("Local (on this Mac)");
    expect(
      screen.getByText(
        "Recordings are transcribed on this Mac. The audio never leaves your Mac."
      )
    ).toBeTruthy();
    expect(screen.getByText("Needs setup")).toBeTruthy();
    expect(screen.queryByText("API key")).toBeNull();
    expect(screen.queryByText("Speaker separator")).toBeNull();
    // The local model row stays.
    expect(screen.getByText("Speech model")).toBeTruthy();
  });

  it("asks only for a masked key and a Groq model, and saves after verification", async () => {
    const verification = Promise.withResolvers<MeetingTranscriptionActionResult>();
    const { setProvider } = renderSection(local, { result: verification.promise });
    await choose("Groq");

    const key = screen.getByLabelText("API key");
    expect(key).toHaveAttribute("type", "password");
    expect(screen.queryByLabelText("Base URL")).toBeNull();
    expect(screen.getByRole("button", { name: /Model/ })).toHaveTextContent(
      "whisper-large-v3"
    );
    expect(
      screen.getByText(
        "Groq's free plan transcribes up to 2 hours of audio per hour and 8 hours per day."
      )
    ).toBeTruthy();

    fireEvent.change(key, { target: { value: "  gsk_new_key  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setProvider).toHaveBeenCalledExactlyOnceWith({
      kind: "groq",
      model: "whisper-large-v3",
      apiKey: "gsk_new_key",
    });
    expect(await screen.findByText("Checking…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    verification.resolve({ accepted: false, reason: "key_rejected" });
    expect(await screen.findByText("The provider rejected this key.")).toBeTruthy();
  });

  it("sends the turbo model when chosen", async () => {
    const { setProvider } = renderSection(local);
    await choose("Groq");
    await userEvent.click(screen.getByRole("button", { name: /Model/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: "whisper-large-v3-turbo" })
    );
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "gsk_key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setProvider).toHaveBeenCalledWith({
      kind: "groq",
      model: "whisper-large-v3-turbo",
      apiKey: "gsk_key",
    });
  });

  it("shows a saved key without its value, with Replace and Delete, and names Groq", async () => {
    const { clearKey, setProvider } = renderSection(groqReady, {
      localState: localReady,
    });
    await engine();
    expect(screen.getByText("A key is saved. It is not shown again.")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(
      screen.getByText(
        "Meeting audio is sent to Groq for transcription. Speakers are told apart on this Mac."
      )
    ).toBeTruthy();
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
    expect(screen.getByText("Speaker separator")).toBeTruthy();
    expect(
      screen.getByText(
        "Transcribes on this Mac when Groq is unavailable. The model uses 654 MB."
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(screen.getByLabelText("API key")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("API key")).toBeNull();

    // A model change keeps the saved key: Main reuses it.
    await userEvent.click(screen.getByRole("button", { name: /Model/ }));
    await userEvent.click(
      await screen.findByRole("option", { name: "whisper-large-v3-turbo" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setProvider).toHaveBeenCalledWith({
      kind: "groq",
      model: "whisper-large-v3-turbo",
    });

    const remove = screen.getByRole("button", { name: "Delete" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(clearKey).toHaveBeenCalledOnce();
  });

  it("marks a rejected key and checks it again on request", async () => {
    const { retryVerify } = renderSection({
      ...groqReady,
      ready: false,
      reason: "key_rejected",
      cloud: { ...groqReady.cloud!, verification: "rejected" },
    });
    await engine();
    expect(screen.getByText("Key rejected")).toBeTruthy();
    expect(
      screen.getByText(
        "The provider rejected the saved key. Replace it, or check it again."
      )
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(retryVerify).toHaveBeenCalledOnce();
  });

  it("shows the check in progress", async () => {
    renderSection({
      ...groqReady,
      cloud: { ...groqReady.cloud!, verification: "checking" },
    });
    await engine();
    expect(screen.getByText("Checking…")).toBeTruthy();
  });

  it("installs the speaker separator as its own row and retries a failed one", async () => {
    const { retryVerify } = renderSection({
      ...groqReady,
      ready: false,
      reason: "diarization_missing",
      diarization: "failed",
    });
    await engine();
    expect(screen.getByText("The speaker separator was not installed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retryVerify).toHaveBeenCalledOnce();
  });

  it("asks for URL, key and model for an OpenAI-compatible API and explains HTTPS", async () => {
    const { setProvider } = renderSection(local, {
      result: { accepted: false, reason: "insecure_url" },
    });
    await choose("OpenAI-compatible API");
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "http://asr.example.com/v1" },
    });
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-1" } });
    fireEvent.change(screen.getByLabelText("Model"), {
      target: { value: "whisper-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setProvider).toHaveBeenCalledWith({
      kind: "openai_compatible",
      baseUrl: "http://asr.example.com/v1",
      model: "whisper-1",
      apiKey: "sk-1",
    });
    expect(
      await screen.findByText("Use an HTTPS URL. Plain HTTP works only for localhost.")
    ).toBeTruthy();
  });

  it("names the compatible API's host in the privacy notice", async () => {
    renderSection({
      ...groqReady,
      provider: "openai_compatible",
      cloud: {
        ...groqReady.cloud!,
        kind: "openai_compatible",
        model: "whisper-1",
        baseHost: "asr.example.com",
      },
    });
    await engine();
    expect(
      screen.getByText(
        "Meeting audio is sent to asr.example.com for transcription. Speakers are told apart on this Mac."
      )
    ).toBeTruthy();
    expect(screen.getByLabelText("Model")).toHaveValue("whisper-1");
  });

  it("reuses the kept Groq key when Groq is chosen again after Local", async () => {
    const { setProvider, clearKey } = renderSection(
      { provider: "local", ready: true, diarization: "ready", cloud: groqReady.cloud! },
      { localState: localReady }
    );
    expect(await engine()).toHaveTextContent("Local (on this Mac)");
    expect(
      screen.getByText(
        "Recordings are transcribed on this Mac. The audio never leaves your Mac."
      )
    ).toBeTruthy();

    // The engine row and the local model row are both ready.
    expect(screen.getAllByText("Ready")).toHaveLength(2);

    await choose("Groq");
    // Local's status no longer sits beside the unsaved Groq choice.
    expect(screen.getAllByText("Ready")).toHaveLength(1);
    expect(screen.getByText("A key is saved. It is not shown again.")).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(setProvider).toHaveBeenCalledExactlyOnceWith({
      kind: "groq",
      model: "whisper-large-v3",
    });

    const remove = screen.getByRole("button", { name: "Delete" });
    await waitFor(() => expect(remove).toBeEnabled());
    fireEvent.click(remove);
    expect(clearKey).toHaveBeenCalledOnce();
  });

  it("switches back to a kept OpenAI-compatible API without retyping its URL or key", async () => {
    const { setProvider } = renderSection({
      ...local,
      cloud: {
        ...groqReady.cloud!,
        kind: "openai_compatible",
        model: "whisper-1",
        baseHost: "asr.example.com",
      },
    });
    await choose("OpenAI-compatible API");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(setProvider).toHaveBeenCalledExactlyOnceWith({
      kind: "openai_compatible",
      model: "whisper-1",
    });
  });

  it("returns to Local at once when Local is chosen", async () => {
    const { setProvider } = renderSection(groqReady);
    await choose("Local (on this Mac)");
    expect(setProvider).toHaveBeenCalledExactlyOnceWith({ kind: "local" });
  });

  it("keeps cloud providers unavailable without the Keychain", async () => {
    renderSection({ ...local, reason: "secure_storage_unavailable" });
    await engine();
    expect(
      screen.getByText(
        "Groq and OpenAI-compatible APIs need the macOS Keychain to store their key, and it is unavailable now."
      )
    ).toBeTruthy();
    await userEvent.click(await engine());
    expect(await screen.findByRole("option", { name: "Groq" })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("shows only the local model row where transcription is unavailable", async () => {
    renderSection(
      { ...local, reason: "unsupported" },
      {
        localState: {
          supported: false,
          reason: "remote_backend",
          phase: "not_installed",
          sizeBytes: 0,
        },
      }
    );
    expect(await screen.findByText("Speech model")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Transcription engine/ })).toBeNull()
    );
  });
});
