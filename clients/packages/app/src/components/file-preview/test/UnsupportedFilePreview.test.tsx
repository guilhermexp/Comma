import { act, fireEvent, render, screen } from "@comma/test-utils/render";
import type { ChatPanelFileOpenInAction } from "@comma/ui";
import { expect, it } from "vitest";
import { UnsupportedFilePreview } from "../UnsupportedFilePreview";

const preview = (source: string, openIn: ChatPanelFileOpenInAction) => (
  <UnsupportedFilePreview
    key={source}
    openIn={openIn}
    download={{
      fileName: "sources.zip",
      capability: { execute: async () => ({ status: "success" }) },
    }}
  />
);

it("keeps an in-flight open across action refreshes and cancels it when its source closes", async () => {
  let complete!: () => void;
  let signal: AbortSignal | undefined;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const action: ChatPanelFileOpenInAction = {
    listApplications: async () => [],
    openApplication: async () => {},
    openDefault: async (operationSignal) => {
      signal = operationSignal;
      await pending;
    },
  };
  const { rerender } = render(preview("first-source", action));
  fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();

  rerender(preview("first-source", { ...action }));
  expect(signal?.aborted).toBe(false);
  expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();

  rerender(preview("second-source", action));
  expect(signal?.aborted).toBe(true);
  expect(screen.getByRole("button", { name: "Open in default app" })).toBeEnabled();
  await act(async () => {
    complete();
    await pending;
  });
  expect(screen.getByRole("button", { name: "Open in default app" })).toBeEnabled();
});

it("shows the download result after opening the file failed", async () => {
  render(
    preview("source", {
      listApplications: async () => [],
      openApplication: async () => {},
      openDefault: async () => {
        throw new Error("No default application");
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Open in default app" }));
  expect(await screen.findByText("Could not open the file.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByText("File downloaded.")).toBeVisible();
  expect(screen.queryByText("Could not open the file.")).not.toBeInTheDocument();
});
