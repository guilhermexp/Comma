import { describe, expect, it } from "vitest";
import {
  composePushToTalkMessage,
  speakableText,
  splitSentences,
} from "../push-to-talk/message";

const header = "Screen context (captured when I pressed the shortcut):";

describe("composePushToTalkMessage", () => {
  it("describes the screenshot, the cursor and the stroke area in screenshot pixels", () => {
    expect(
      composePushToTalkMessage({
        transcript: "What does this chart show?",
        frontmostApp: { name: "Safari", bundleId: "com.apple.Safari" },
        screen: {
          kind: "screenshot",
          width: 2560,
          height: 1655,
          cursor: { x: 830, y: 741 },
          strokeBounds: { x: 100, y: 200, width: 300, height: 400 },
        },
      })
    ).toBe(
      [
        "What does this chart show?",
        "",
        header,
        "- Frontmost app: Safari",
        "- Screenshot: 2560 × 1655 px",
        "- Cursor: (830, 741) px",
        "- Stroke area: 100, 200, 300 × 400 px",
        "- The screenshot has my stroke drawn over it; the detail image is the stroke area at full resolution.",
      ].join("\n")
    );
  });

  it("says the detail is around the cursor when nothing was drawn", () => {
    const text = composePushToTalkMessage({
      transcript: "What does this button do?",
      frontmostApp: null,
      screen: { kind: "screenshot", width: 1440, height: 900, cursor: { x: 5, y: 6 } },
    });
    expect(text).not.toContain("Frontmost app");
    expect(text).not.toContain("Stroke area");
    expect(text).toContain(
      "- The detail image is the region around the cursor at full resolution."
    );
  });

  it("gives the cursor in display points when the screenshot was not included", () => {
    expect(
      composePushToTalkMessage({
        transcript: "Where is the export?",
        frontmostApp: { name: "Numbers", bundleId: null },
        screen: {
          kind: "pointer",
          cursor: { x: 12, y: 34 },
          display: { width: 1728, height: 1117 },
        },
      })
    ).toBe(
      [
        "Where is the export?",
        "",
        header,
        "- Frontmost app: Numbers",
        "- No screenshot was included.",
        "- Cursor: (12, 34) pt on a 1728 × 1117 pt display",
      ].join("\n")
    );
  });

  it("sends only the app with the screenshot turned off, and only the text without either", () => {
    expect(
      composePushToTalkMessage({
        transcript: "Summarize it",
        frontmostApp: { name: "Mail", bundleId: "com.apple.mail" },
      })
    ).toBe(["Summarize it", "", header, "- Frontmost app: Mail"].join("\n"));
    expect(composePushToTalkMessage({ transcript: "Hello", frontmostApp: null })).toBe(
      "Hello"
    );
  });
});

describe("speakableText", () => {
  it("drops Markdown marks, keeps link labels and names code blocks", () => {
    expect(
      speakableText(
        [
          "## Result",
          "",
          "The **export** button is in *File* → [Export](https://example.com/x).",
          "",
          "```sh",
          "rm -rf /tmp/x",
          "```",
          "",
          "- Use `Cmd+E`.",
          "1. Then _save_.",
          "> Note: done",
          "![chart](https://example.com/c.png)",
        ].join("\n"),
        { codeBlock: "code snippet" }
      )
    ).toBe(
      [
        "Result",
        "The export button is in File → Export.",
        "code snippet",
        "Use Cmd+E.",
        "Then save.",
        "Note: done",
      ].join("\n")
    );
  });

  it("keeps snake_case words and plain text", () => {
    expect(speakableText("Set max_tokens to 5 * 3.", { codeBlock: "code" })).toBe(
      "Set max_tokens to 5 * 3."
    );
  });
});

describe("splitSentences", () => {
  // Leitura da resposta: each sentence is read and captioned on its own.
  it("splits on sentence ends and line breaks, keeping decimals and empty-free", () => {
    expect(
      splitSentences("O arquivo tem 1.5 GB. Quer apagar?\nItem um\n\nPronto! Fim")
    ).toEqual(["O arquivo tem 1.5 GB.", "Quer apagar?", "Item um", "Pronto!", "Fim"]);
  });
});
