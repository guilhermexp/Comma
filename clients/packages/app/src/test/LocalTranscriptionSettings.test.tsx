import type {
  LocalTranscriptionActionResult,
  LocalTranscriptionState,
} from "@comma/native-bridge";
import { CommaI18nProvider } from "@comma/i18n/react";
import {
  createNativeStateBridgeMock,
  installNativeBridgeMock,
} from "@comma/test-utils/native-bridge";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@comma/test-utils/render";
import { SettingsPanel } from "@comma/ui";
import type { NativeStateBridge } from "@comma/native-bridge";
import { describe, expect, it, vi } from "vitest";
import { useLocalTranscriptionSection } from "../components/useLocalTranscriptionSection";

// The manifest's total, which the docs and release notes call about 654 MB.
const size = 653_769_228;

function Section() {
  const { section, removalDialog } = useLocalTranscriptionSection();
  return (
    <>
      <SettingsPanel sections={[section]} title="Meeting" />
      {removalDialog}
    </>
  );
}

function renderSection(
  state: LocalTranscriptionState | NativeStateBridge<LocalTranscriptionState>,
  results: Partial<
    Record<"install" | "cancel" | "remove", LocalTranscriptionActionResult>
  > = {}
) {
  const actions = {
    install: vi.fn(async () => results.install ?? { accepted: true }),
    cancel: vi.fn(async () => results.cancel ?? { accepted: true }),
    remove: vi.fn(async () => results.remove ?? { accepted: true }),
  };
  installNativeBridgeMock({
    platform: "electron",
    localTranscription: {
      state: "subscribe" in state ? state : createNativeStateBridgeMock(() => state),
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

const row = () => screen.findByText("Speech model");
const buttons = () =>
  screen.queryAllByRole("button").map((button) => button.textContent?.trim());

describe("Settings → Meeting → Local transcription", () => {
  it("explains why an Intel Mac or macOS 14 cannot install it", async () => {
    renderSection({
      supported: false,
      reason: "unsupported_os",
      phase: "not_installed",
      sizeBytes: size,
    });
    await row();
    expect(screen.getByText("Local transcription")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(
      screen.getByText(
        "Local transcription needs a Mac with Apple silicon and macOS 15 or later."
      )
    ).toBeTruthy();
    expect(buttons()).not.toContain("Install");
  });

  it("says it needs the app's own backend in a remote build", async () => {
    renderSection({
      supported: false,
      reason: "remote_backend",
      phase: "not_installed",
      sizeBytes: 0,
    });
    expect(
      await screen.findByText("Available when Comma runs its own backend on this Mac.")
    ).toBeTruthy();
    expect(buttons()).not.toContain("Install");
  });

  it("offers Install with the download size when the model is missing", async () => {
    const actions = renderSection({
      supported: true,
      phase: "not_installed",
      sizeBytes: size,
    });
    await row();
    expect(screen.getByText("Not installed")).toBeTruthy();
    expect(screen.getByText(/Download: 653\.8 MB\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(actions.install).toHaveBeenCalledOnce());
  });

  it("shows the download percentage and offers Cancel", async () => {
    const actions = renderSection({
      supported: true,
      phase: "downloading",
      fraction: 0.424,
      sizeBytes: size,
    });
    expect(await screen.findByText("Downloading 42%")).toBeTruthy();
    expect(buttons()).not.toContain("Install");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(actions.cancel).toHaveBeenCalledOnce());
  });

  it("shows Preparing without actions", async () => {
    renderSection({ supported: true, phase: "preparing", sizeBytes: size });
    expect(await screen.findByText("Preparing")).toBeTruthy();
    expect(
      screen.getByText("Preparing the model for this Mac. This can take a few minutes.")
    ).toBeTruthy();
    for (const label of ["Install", "Cancel", "Remove"])
      expect(buttons()).not.toContain(label);
  });

  it("shows Ready and removes the model only after confirmation", async () => {
    const actions = renderSection({ supported: true, phase: "ready", sizeBytes: size });
    expect(await screen.findByText("Ready")).toBeTruthy();
    expect(screen.getByText(/The model uses 653\.8 MB\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Remove the speech model?",
    });
    expect(dialog.textContent).toContain(
      "Meeting recordings will no longer be transcribed on this Mac until you install it again (653.8 MB download)."
    );
    expect(actions.remove).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.remove).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" })
    );
    await waitFor(() => expect(actions.remove).toHaveBeenCalledOnce());
  });

  it("does not leave keyboard focus on Remove when an install finishes", async () => {
    let publish!: (state: LocalTranscriptionState) => void;
    let current: LocalTranscriptionState = {
      supported: true,
      phase: "downloading",
      fraction: 0.5,
      sizeBytes: size,
    };
    const get = vi.fn(async () => current);
    renderSection(
      Object.assign(get, {
        get,
        subscribe: (listener: (state: LocalTranscriptionState) => void) => {
          publish = (state) => {
            current = state;
            listener(state);
          };
          listener(current);
          return () => undefined;
        },
      }) as unknown as NativeStateBridge<LocalTranscriptionState>
    );
    (await screen.findByRole("button", { name: "Cancel" })).focus();
    act(() => publish({ supported: true, phase: "preparing", sizeBytes: size }));
    act(() => publish({ supported: true, phase: "ready", sizeBytes: size }));
    const remove = await screen.findByRole("button", { name: "Remove" });
    expect(document.activeElement).not.toBe(remove);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Enter" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains a refused removal while a recording is transcribed", async () => {
    renderSection(
      { supported: true, phase: "ready", sizeBytes: size },
      { remove: { accepted: false, reason: "busy" } }
    );
    await row();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    });
    expect(
      await screen.findByText(
        "A recording is being transcribed. Remove the model after it finishes."
      )
    ).toBeTruthy();
  });

  it("names a checksum failure and offers Try again", async () => {
    const actions = renderSection({
      supported: true,
      phase: "failed",
      sizeBytes: size,
      error: { code: "checksum_mismatch", message: "weight.bin does not match" },
    });
    expect(await screen.findByText("Error")).toBeTruthy();
    expect(
      screen.getByText(
        "A downloaded file did not match its expected checksum, so nothing was installed."
      )
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(actions.install).toHaveBeenCalledOnce());
  });

  it("shows the helper's message for another failure", async () => {
    renderSection({
      supported: true,
      phase: "failed",
      sizeBytes: size,
      error: { code: "io", message: "The disk is full." },
    });
    expect(
      await screen.findByText("The model could not be installed: The disk is full.")
    ).toBeTruthy();
  });
});
