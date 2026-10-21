import type { useCommaMessages } from "@comma/i18n/react";
import { toolWorkLabel, type ToolWork } from "./toolWorkCopy";

type CommaMessages = ReturnType<typeof useCommaMessages>;

const toolWork = new Map<string, ToolWork>([
  ["fs.read_file", "filesRead"],
  ["fs.stat_file", "filesRead"],
  ["fs.list_files", "filesRead"],
  ["fs.glob", "filesRead"],
  ["fs.grep", "filesRead"],
  ["compute.workspace.read", "filesRead"],
  ["compute.workspace.stat", "filesRead"],
  ["compute.workspace.list", "filesRead"],
  ["fs.write_file", "filesEdit"],
  ["fs.edit_file", "filesEdit"],
  ["compute.workspace.write", "filesEdit"],
  ["fs.copy_file", "filesOrganize"],
  ["fs.move_file", "filesOrganize"],
  ["env.copy", "filesOrganize"],
  ["fs.delete_file", "filesDelete"],
  ["env.exec", "command"],
  ["env.remote_shell", "command"],
  ["compute.exec", "command"],
  ["compute.build.run", "command"],
  ["process.start", "command"],
  ["script.run", "code"],
  ["script.run_file", "code"],
  ["env.computer_use", "computer"],
  ["env.ensure_runtime", "workspace"],
  ["web.search", "webSearch"],
  ["web.read_pages", "webRead"],
  ["web.http_request", "webRequest"],
  ["im_api.internal.task.create", "taskCreate"],
  ["im_api.internal.task.update", "taskUpdate"],
  ["im_api.internal.update_conversation", "taskUpdate"],
  ["im_api.internal.task.list", "taskList"],
  ["im_api.internal.list_conversation_participants", "progress"],
  ["im_api.internal.get_conversation_participant_status", "progress"],
  ["tool_call.get_status", "progress"],
  ["tool_call.get_result", "progress"],
  ["im_api.internal.read_conversation", "messages"],
  ["im_api.internal.search_conversations", "messages"],
  ["history.search", "messages"],
  ["history.list", "messages"],
  ["history.get", "messages"],
  ["im_api.internal.add_agent_participant", "workerAdd"],
  ["agent.list", "workers"],
  ["agent.get", "workers"],
  ["agent.create_worker", "workerCreate"],
  ["agent.update", "workerUpdate"],
  ["agent.rebind_runtime", "workerUpdate"],
  ["agent.archive", "workerUpdate"],
  ["email.send_to_owners", "email"],
  ["composio.execute", "pluginUse"],
  ["composio.list_toolkits", "pluginUse"],
  ["composio.list_tools", "pluginUse"],
  ["composio.get_tool", "pluginUse"],
  ["composio.list_connections", "pluginUse"],
  ["composio.check_connection", "pluginUse"],
  ["composio.delete_connection", "pluginsSetup"],
  ["oauth.request_authorization", "access"],
  ["oauth.complete_authorization", "access"],
  ["composio.request_connection", "access"],
  ["mcp_manager.authorize", "access"],
  ["permission.request", "approval"],
  ["ifc.request_declassification", "approval"],
  ["location.request", "location"],
  ["calendar.calendars", "calendarRead"],
  ["calendar.events", "calendarRead"],
  ["calendar.event", "calendarRead"],
  ["calendar.create", "calendarWrite"],
  ["calendar.update", "calendarWrite"],
  ["calendar.update_context", "calendarWrite"],
  ["calendar.delete", "calendarDelete"],
  ["meeting.join", "meetingJoin"],
  ["meeting.get", "meetingRead"],
  ["meeting.read_summary_materials", "meetingRead"],
  ["meeting.submit_summary", "meetingNotes"],
  ["schedule.create", "schedule"],
  ["schedule.delete", "schedule"],
  ["proactive.act", "reminderSet"],
  ["proactive.watch", "reminderSet"],
  ["proactive.present", "reminderSend"],
  ["composio.create_trigger", "automation"],
  ["composio.bind_trigger", "automation"],
  ["composio.manage_trigger", "automation"],
  ["composio.list_triggers", "automation"],
  ["composio.list_trigger_types", "automation"],
  ["composio.get_trigger_type", "automation"],
  ["image.generate", "image"],
  ["video.generate", "video"],
  ["audio.transcribe", "audio"],
  ["preview.publish_html", "page"],
  ["device.list", "devices"],
  ["device.get", "devices"],
  ["memory.search", "memoryRead"],
  ["memory.get", "memoryRead"],
  ["memory.write", "memoryWrite"],
  ["wait_for", "wait"],
  // Native tools of external runtimes (Claude Code, Codex, Pi) as the
  // Connector names their operations.
  ["Bash", "command"],
  ["bash", "command"],
  ["read", "filesRead"],
  ["write", "filesEdit"],
  ["edit", "filesEdit"],
  ["commandExecution", "command"],
  ["Read", "filesRead"],
  ["Glob", "filesRead"],
  ["Grep", "filesRead"],
  ["LS", "filesRead"],
  ["Write", "filesEdit"],
  ["Edit", "filesEdit"],
  ["MultiEdit", "filesEdit"],
  ["NotebookEdit", "filesEdit"],
  ["fileChange", "filesEdit"],
  ["WebFetch", "webRead"],
  ["WebSearch", "webSearch"],
  ["webSearch", "webSearch"],
]);

// Families whose every operation does the same kind of work. MCP plugin
// operations are named mcp.<binding>.<tool>.
const toolWorkFamilies: ReadonlyArray<readonly [prefix: string, work: ToolWork]> = [
  ["meeting.preparation.", "meetingPrep"],
  ["im_api.internal.label.", "labels"],
  ["mcp_manager.", "pluginsSetup"],
  ["plugin.", "pluginsSetup"],
  ["skill.", "skills"],
  ["loop.", "automation"],
  ["mcp.", "pluginUse"],
];

// Messaging apps expose provider operations as im_api.<provider>.<operation>.
const messagingWork = new Map<string, readonly [send: ToolWork, use: ToolWork]>([
  ["slack", ["slackSend", "slackUse"]],
  ["telegram", ["telegramSend", "telegramUse"]],
  ["feishu", ["feishuSend", "feishuUse"]],
  ["wechat", ["wechatSend", "wechatUse"]],
  ["imessage", ["imessageSend", "imessageUse"]],
  ["signal", ["signalSend", "signalUse"]],
]);

function toolWorkFor(toolName: string): ToolWork | undefined {
  const work =
    toolWork.get(toolName) ??
    toolWorkFamilies.find(([prefix]) => toolName.startsWith(prefix))?.[1];
  if (work) return work;

  const [, provider = "", operation = ""] =
    /^im_api\.([a-z]+)\.(.+)$/.exec(toolName) ?? [];
  const [send, use] = messagingWork.get(provider) ?? [];
  return /^(send|post|reply)_/.test(operation) ? send : use;
}

/**
 * Plain wording, in the reader's language, for the work behind a tool call.
 * A tool identifier is never wording: a tool without wording returns
 * undefined, and the indicator shows a generic line with the public
 * identifier as its technical detail.
 */
export function toolActivityLabel(
  messages: CommaMessages,
  toolName: string | undefined,
  status: "running" | "failed"
): string | undefined {
  const work = toolName ? toolWorkFor(toolName.trim()) : undefined;
  if (!work) return undefined;
  return toolWorkLabel(messages, work, status);
}
