import { useCommaMessages } from "@comma/i18n/react";
import { getNativeBridge, type NotchTaskItem } from "@comma/native-bridge";
import { useEffect, useMemo } from "react";
import { useWorkspaceTasks, type TaskViewModel } from "./useWorkspaceTasks";

/**
 * Owns the desktop task-to-Notch projection for the authenticated session.
 * The Swift host receives only in-progress tasks, so an empty projection can
 * unambiguously collapse and hide the native surface.
 */
export function NotchTaskSync() {
  const bridge = getNativeBridge();
  const isDesktop = bridge.platform === "electron";
  const messages = useCommaMessages();
  // This authenticated-session owner retains the same projection for Web and
  // Electron. Only the native Notch side effect remains Electron-specific.
  const { tasks } = useWorkspaceTasks({ enabled: true });
  const notchTasks = useMemo(
    () => toNotchTaskItems(tasks, messages.tasks_in_progress()),
    [messages, tasks]
  );

  useEffect(() => {
    if (!isDesktop) return;

    void bridge.notch
      .update({
        hasActivity: notchTasks.length > 0,
        listSubtitle: messages.notch_tasks_subtitle(),
        listTitle: messages.notch_tasks_title(),
        openChatLabel: messages.inbox_open_chat(),
        tasks: notchTasks,
      })
      .catch(() => undefined);
  }, [bridge, isDesktop, messages, notchTasks]);

  useEffect(
    () => () => {
      if (!isDesktop) return;
      void bridge.notch.hide().catch(() => undefined);
    },
    [bridge, isDesktop]
  );

  return null;
}

export function toNotchTaskItems(
  tasks: readonly TaskViewModel[],
  inProgressLabel: string
): NotchTaskItem[] {
  return tasks
    .filter((task) => task.statusBucket === "in_progress")
    .map((task) => ({
      conversationId: task.conversationId,
      groupId: task.groupId,
      id: task.id,
      status: "in_progress",
      subtitle: inProgressLabel,
      title: task.title,
      updatedAt: task.updatedAt,
      workspaceId: task.workspaceId,
    }));
}
