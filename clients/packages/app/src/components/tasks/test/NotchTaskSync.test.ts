import { describe, expect, it } from "vitest";
import { toNotchTaskItems } from "../NotchTaskSync";
import type { TaskViewModel } from "../useWorkspaceTasks";

describe("toNotchTaskItems", () => {
  it("projects only in-progress tasks into the native Notch contract", () => {
    expect(
      toNotchTaskItems(
        [
          task("running", "in_progress", 20),
          task("queued", "backlog", 10),
          task("done", "done", 5),
        ],
        "In progress"
      )
    ).toEqual([
      {
        conversationId: "conversation-running",
        groupId: "group-1",
        id: "running",
        status: "in_progress",
        subtitle: "In progress",
        title: "Task running",
        updatedAt: 20,
        workspaceId: "workspace-1",
      },
    ]);
  });

  it("returns an empty projection when no task is in progress", () => {
    expect(toNotchTaskItems([task("queued", "backlog", 10)], "In progress")).toEqual(
      []
    );
  });
});

function task(
  id: string,
  statusBucket: TaskViewModel["statusBucket"],
  updatedAt: number
): TaskViewModel {
  return {
    activityStatus: id,
    conversationId: `conversation-${id}`,
    freshness: "fresh",
    groupId: "group-1",
    id,
    messages: [],
    origin: undefined,
    statusBucket,
    title: `Task ${id}`,
    updatedAt,
    workspaceId: "workspace-1",
  };
}
