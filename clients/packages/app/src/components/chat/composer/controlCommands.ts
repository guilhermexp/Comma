import {
  CodeIcon,
  createAiInputRichValue,
  type AiInputMenuContext,
  type AiInputRichSegment,
  type AiInputRichValue,
} from "@comma/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

export const CONTROL_COMMANDS = [
  "new",
  "status",
  "compact",
  "emergency-compact",
  "help",
  "ls",
  "cat",
] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];

/** Token data marking a "/" menu pill as a Salix control command. */
export interface ControlCommandTokenData {
  controlCommand: ControlCommand;
}

/** The "/" menu the command pills belong to. */
export const CONTROL_COMMAND_MENU_ID = "skills";

/**
 * A pill's draft text is the bare server block, so a restored draft projects
 * back into the pill (as Task mentions do) and typed `/cat` never does. The
 * editor shows only the label; arguments are the text after the pill.
 */
export const controlCommandPlainText = (command: ControlCommand) =>
  `<salix-command>${command}</salix-command>`;

const NAMES = CONTROL_COMMANDS.join("|");
const PILL_PATTERN = new RegExp(`<salix-command>(${NAMES})</salix-command>`, "gu");
const ARGUMENT_LINE = new RegExp(
  `<salix-command>(?:${NAMES})</salix-command>[^\\n]*$`,
  "u"
);

const isControlCommandData = (data: unknown): data is ControlCommandTokenData =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as { controlCommand?: unknown }).controlCommand === "string";

/** Text after a pill on its line is its argument, not a "/" menu query. */
export const isControlCommandArgument = ({ textBeforeTrigger }: AiInputMenuContext) =>
  ARGUMENT_LINE.test(textBeforeTrigger);

let iconMarkup: string | undefined;

/** Brings bare command blocks in a restored draft back into pills. */
export function projectControlCommands(value: AiInputRichValue): AiInputRichValue {
  if (!value.plainText.includes("<salix-command>")) return value;
  const segments: AiInputRichSegment[] = [];
  let index = 0;
  for (const segment of value.segments) {
    if (segment.type === "token") {
      segments.push(segment);
      continue;
    }
    let offset = 0;
    for (const match of segment.text.matchAll(PILL_PATTERN)) {
      const command = match[1] as ControlCommand;
      if (match.index > offset) {
        segments.push({ type: "text", text: segment.text.slice(offset, match.index) });
      }
      segments.push({
        type: "token",
        instanceId: `projected-command-${index}`,
        menuId: CONTROL_COMMAND_MENU_ID,
        itemId: `salix-${command}`,
        trigger: "/",
        label: command,
        iconMarkup: (iconMarkup ??= renderToStaticMarkup(createElement(CodeIcon))),
        plainText: match[0],
        data: { controlCommand: command } satisfies ControlCommandTokenData,
      });
      offset = match.index + match[0].length;
      index += 1;
    }
    if (offset < segment.text.length) {
      segments.push({ type: "text", text: segment.text.slice(offset) });
    }
  }
  return createAiInputRichValue(segments);
}

/**
 * The text a draft sends. Each command pill and the rest of its line become
 * one `<salix-command>` block. `/new` stays the exact plain `/new` the Router
 * accepts, and text after it stays prose. Typed `/cat` stays prose.
 */
export function controlCommandWireText(richValue: AiInputRichValue): string {
  if (!richValue.tokens.some((token) => isControlCommandData(token.data))) {
    return richValue.plainText;
  }

  let wire = "";
  const segments = richValue.segments;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.type === "text") {
      wire += segment.text;
      continue;
    }
    if (!isControlCommandData(segment.data)) {
      wire += segment.plainText;
      continue;
    }
    // Arguments run to the end of the line or the next pill.
    let argument = "";
    let rest = "";
    while (segments[index + 1]?.type === "text") {
      index += 1;
      const text = (segments[index] as { text: string }).text;
      const lineEnd = text.indexOf("\n");
      if (lineEnd === -1) {
        argument += text;
        continue;
      }
      argument += text.slice(0, lineEnd);
      rest = text.slice(lineEnd);
      break;
    }
    const command = segment.data.controlCommand;
    const body = [command, argument.trim()].filter(Boolean).join(" ");
    wire +=
      (command === "new" ? `/${body}` : `<salix-command>${body}</salix-command>`) +
      rest;
  }
  return wire;
}
