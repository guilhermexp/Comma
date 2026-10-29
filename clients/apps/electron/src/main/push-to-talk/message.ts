import type { PushToTalkFrontmostApp, PushToTalkPoint, PushToTalkRect } from "./types";

export type PushToTalkContextScreen =
  | {
      kind: "screenshot";
      width: number;
      height: number;
      cursor: PushToTalkPoint;
      strokeBounds?: PushToTalkRect;
    }
  | {
      kind: "pointer";
      cursor: PushToTalkPoint;
      display: { width: number; height: number };
    };

/** Text for the voice session; the Router receives the image attachments. */
export function composePushToTalkContext(input: {
  frontmostApp: PushToTalkFrontmostApp | null;
  screen: PushToTalkContextScreen;
  fileNames: string[];
}) {
  const lines = ["Screen context captured when the shortcut was pressed:"];
  if (input.frontmostApp) lines.push(`- Frontmost app: ${input.frontmostApp.name}`);
  const { screen } = input;
  if (screen.kind === "screenshot") {
    lines.push(`- Screenshot: ${screen.width} × ${screen.height} px`);
    lines.push(`- Cursor: (${screen.cursor.x}, ${screen.cursor.y}) px`);
    if (screen.strokeBounds) {
      const { x, y, width, height } = screen.strokeBounds;
      lines.push(`- Marked area: ${x}, ${y}, ${width} × ${height} px`);
      lines.push(
        "- The screenshot includes the stroke; the detail image covers the marked area."
      );
    } else lines.push("- The detail image covers the cursor's surroundings.");
    lines.push(`- Files: ${input.fileNames.join(", ")}`);
    lines.push(
      "Delegate screen questions to the Router; only the Router can inspect these images."
    );
  } else {
    lines.push("- No screenshot was included.");
    lines.push(
      `- Cursor: (${screen.cursor.x}, ${screen.cursor.y}) pt on a ${screen.display.width} × ${screen.display.height} pt display`
    );
  }
  return lines.join("\n");
}

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
/** Caption the current phrase without splitting decimal numbers. */
export function splitSentences(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) =>
      Array.from(sentenceSegmenter.segment(line), ({ segment }) => segment.trim())
    )
    .filter(Boolean);
}
