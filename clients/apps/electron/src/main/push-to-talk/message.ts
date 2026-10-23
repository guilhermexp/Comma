import type { PushToTalkFrontmostApp, PushToTalkPoint, PushToTalkRect } from "./types";

/** The screen part of a turn, in the coordinates the agent can cite. */
export type PushToTalkMessageScreen =
  // Pixels of the attached screenshot.
  | {
      kind: "screenshot";
      width: number;
      height: number;
      cursor: PushToTalkPoint;
      region?: PushToTalkRect;
    }
  // No screenshot: display-relative points of the cursor's display.
  | {
      kind: "pointer";
      cursor: PushToTalkPoint;
      display: { width: number; height: number };
    };

const contextHeader = "Screen context (captured when I pressed the shortcut):";

/**
 * The user message of a turn (openspec add-push-to-talk-agent, D6): the
 * transcript, then the context block. The composer's attachment section is
 * appended by the detached send.
 */
export function composePushToTalkMessage(input: {
  transcript: string;
  frontmostApp: PushToTalkFrontmostApp | null;
  screen?: PushToTalkMessageScreen;
}) {
  const lines: string[] = [];
  if (input.frontmostApp) lines.push(`- Frontmost app: ${input.frontmostApp.name}`);
  const { screen } = input;
  if (screen?.kind === "screenshot") {
    lines.push(`- Screenshot: ${screen.width} × ${screen.height} px`);
    lines.push(`- Cursor: (${screen.cursor.x}, ${screen.cursor.y}) px`);
    if (screen.region) {
      const { x, y, width, height } = screen.region;
      lines.push(`- Marked area: ${x}, ${y}, ${width} × ${height} px`);
    }
    lines.push(
      `- The detail image is ${
        screen.region ? "the marked area" : "the region around the cursor"
      } at full resolution.`
    );
  } else if (screen?.kind === "pointer") {
    lines.push("- No screenshot was included.");
    lines.push(
      `- Cursor: (${screen.cursor.x}, ${screen.cursor.y}) pt on a ${screen.display.width} × ${screen.display.height} pt display`
    );
  }
  if (lines.length === 0) return input.transcript;
  return [input.transcript, "", contextHeader, ...lines].join("\n");
}

/**
 * The reply as `say` should read it: Markdown marks removed, link labels
 * kept, images dropped and each code block replaced by `codeBlock`.
 */
export function speakableText(markdown: string, options: { codeBlock: string }) {
  return markdown
    .replace(/```[\s\S]*?(?:```|$)/g, `\n${options.codeBlock}\n`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*>\s?/, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/(\*\*|__)(\S(?:.*?\S)?)\1/g, "$2")
        .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
        .replace(/(^|\W)_(\S(?:.*?\S)?)_(?=\W|$)/g, "$1$2")
        .trim()
    )
    .filter(Boolean)
    .join("\n");
}
