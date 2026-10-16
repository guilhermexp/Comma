import { CommaI18nProvider } from "@comma/i18n/react";
import { initializeCommaI18n } from "@comma/i18n";
import { render, screen } from "@comma/test-utils/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { ParticipantStatusSlot } from "../ActivityLine";
import type {
  ChatActivity,
  ChatParticipantStatus,
} from "../../../model/conversationChannel";
import { workerMeshGradientStyle } from "../workerAvatar";

beforeEach(() => {
  initializeCommaI18n(["en"]);
});
afterEach(() => {
  initializeCommaI18n(["en"]);
});

const router: ChatParticipantStatus = {
  conversationId: "task_1",
  participantId: "router",
  actorId: "actor_router",
  actorRole: "router",
  name: "Default workspace Router",
  state: "active",
  status: "is thinking...",
  updatedAt: 1,
};
const worker: ChatParticipantStatus = {
  ...router,
  participantId: "worker_1",
  actorId: "actor_worker_1",
  actorRole: "worker",
  name: "Default workspace Worker",
};
const designer = {
  ...worker,
  participantId: "worker_2",
  actorId: "actor_worker_2",
  name: "Designer",
};
const reviewer = {
  ...worker,
  participantId: "worker_3",
  actorId: "actor_worker_3",
  name: "Reviewer",
};

function statusView(
  participants: ChatParticipantStatus[],
  locale: "en" | "zh-CN" = "en"
) {
  return (
    <CommaI18nProvider locale={locale}>
      <ParticipantStatusSlot
        participantStatus={undefined}
        participantStatuses={participants}
      />
    </CommaI18nProvider>
  );
}

function zhErrorView(issue: string, status: string) {
  return render(
    <CommaI18nProvider locale="zh-CN">
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          issue,
          participantId: "ptp_1",
          state: "error",
          status,
          updatedAt: 1_780_000_000_700,
        }}
      />
    </CommaI18nProvider>
  );
}

describe("Task activity summary", () => {
  it("animates only the active Router avatar at a smaller size", () => {
    const view = render(statusView([router, worker]));
    const routerAvatar = view.container.querySelector('[data-actor-role="router"]');
    const workerAvatar = view.container.querySelector('[data-actor-role="worker"]');
    const logo = routerAvatar?.querySelector('[data-slot="comma-logo-animation"]');
    expect(logo).toBeInTheDocument();
    // Real 16px sizing is asserted with the application CSS in Playwright.
    expect(routerAvatar).toHaveClass("comma-chat-assistant-router-mark");
    expect(logo).toHaveAttribute("data-paused", "false");
    expect(workerAvatar?.querySelector("svg")).toBeNull();
    expect(workerAvatar).toHaveStyle({
      backgroundImage: workerMeshGradientStyle(worker.actorId!).backgroundImage,
    });

    view.rerender(statusView([{ ...router, updatedAt: 2 }, worker]));
    expect(view.container.querySelector('[data-slot="comma-logo-animation"]')).toBe(
      logo
    );

    view.rerender(
      statusView([{ ...router, state: "error", status: "Runtime unavailable" }])
    );
    expect(
      view.container.querySelector('[data-slot="comma-logo-animation"]')
    ).toBeNull();
    expect(view.container.querySelector(".comma-chat-activity-avatars")).toBeNull();
    expect(view.container.querySelector(".comma-chat-activity-avatar")).toBeNull();

    view.rerender(statusView([{ ...router, state: "stopped", status: "" }]));
    expect(view.container.querySelector(".comma-chat-activity-avatar")).toBeNull();
  });

  it("uses the animated mark for the single-participant thinking row", () => {
    const view = render(<ParticipantStatusSlot participantStatus={router} />);
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("is thinking...")).not.toBeInTheDocument();
    expect(
      view.container.querySelector('[data-slot="comma-logo-animation"]')
    ).toBeInTheDocument();
    expect(
      view.container.querySelector(
        '.comma-chat-thinking-bubble [data-slot="comma-logo-animation"]'
      )
    ).toBeInTheDocument();
  });
  it.each([
    [[router], "Router is thinking"],
    [[worker], "Worker is thinking"],
    [[worker, router], "Router and Worker are thinking"],
    [[worker, designer], "Worker and Designer are thinking"],
    [[router, worker, designer], "Router and 2 workers are thinking"],
    [[worker, designer, reviewer], "3 workers are thinking"],
  ] as const)("groups active names in one line: %s", (participants, label) => {
    render(statusView([...participants]));
    expect(screen.getByRole("status")).toHaveTextContent(label);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByTestId("participant-status-slot")).not.toHaveTextContent(
      "Default workspace"
    );
  });

  it.each([
    [[worker], "Worker 正在思考"],
    [[worker, router], "Router 和 Worker 正在思考"],
    [[router, worker, designer], "Router 和 2 个 Worker 正在思考"],
    [[worker, designer, reviewer], "3 个 Worker 正在思考"],
  ] as const)("localizes the complete thinking status: %s", (participants, label) => {
    render(statusView([...participants], "zh-CN"));
    expect(screen.getByRole("status")).toHaveTextContent(label);
  });

  it("keeps the activity and avatar mounted when only the status timestamp/text changes", () => {
    const view = render(statusView([worker]));
    const avatar = view.container.querySelector(".comma-chat-activity-avatar");
    const activity = view.container.querySelector('[data-slot="ai-activity"]');
    const text = screen.getByText("Worker is thinking");
    expect(avatar).toHaveStyle({
      backgroundImage: workerMeshGradientStyle(worker.actorId!).backgroundImage,
    });

    view.rerender(
      statusView([{ ...worker, status: "is executing a tool...", updatedAt: 2 }])
    );
    expect(view.container.querySelector(".comma-chat-activity-avatar")).toBe(avatar);
    expect(view.container.querySelector('[data-slot="ai-activity"]')).toBe(activity);
    expect(screen.getByText("Worker is thinking")).toBe(text);
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "title",
      "Worker · Working"
    );
  });

  it("does not count stopped or failed workers as active, and keeps errors available", () => {
    const view = render(
      statusView([
        router,
        { ...worker, state: "stopped", status: "" },
        {
          ...designer,
          issue: "runtime_failed",
          state: "error",
          status: "error: runtime failed",
        },
      ])
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Router");
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "title",
      expect.stringContaining(
        "Designer · Stopped because of an error. Try sending again."
      )
    );
    view.rerender(statusView([]));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "false"
    );
  });
});

describe("ParticipantStatusSlot", () => {
  it("clears the channel when work stops and preserves localized channel copy", () => {
    const view = render(
      <CommaI18nProvider locale="zh-CN">
        <ParticipantStatusSlot
          participantStatus={{ ...router, workingProvider: "wechat" }}
        />
      </CommaI18nProvider>
    );
    expect(screen.getByRole("status")).toHaveTextContent("Comma 正在微信上处理消息");
    view.rerender(
      <ParticipantStatusSlot
        participantStatus={{ ...router, state: "stopped", status: "" }}
      />
    );
    return vi.waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    );
  });

  it("holds brief empty snapshots without remounting the thinking avatar", () => {
    vi.useFakeTimers();
    try {
      const view = render(statusView([router]));
      const slot = screen.getByTestId("participant-status-slot");
      const avatar = view.container.querySelector(".comma-chat-activity-avatar");
      view.rerender(statusView([]));
      act(() => vi.advanceTimersByTime(100));
      expect(slot).toHaveAttribute("data-active", "true");
      view.rerender(statusView([router]));
      expect(view.container.querySelector(".comma-chat-activity-avatar")).toBe(avatar);
      act(() => vi.advanceTimersByTime(200));
      expect(slot).toHaveAttribute("data-active", "true");
      view.rerender(statusView([]));
      act(() => vi.advanceTimersByTime(180));
      expect(slot).toHaveAttribute("data-active", "false");
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["en", "zh-CN"] as const)(
    "keeps owner-backed work after a reply without exposing private status (%s)",
    async (locale) => {
      const status = { ...router, status: "is waiting: private implementation detail" };
      const slotView = (
        participantStatus: ChatParticipantStatus | undefined,
        streaming = false
      ) => (
        <CommaI18nProvider locale={locale}>
          <ParticipantStatusSlot
            hasResponse
            participantStatus={participantStatus}
            streaming={streaming}
          />
        </CommaI18nProvider>
      );
      const view = render(slotView(status));
      const slot = screen.getByTestId("participant-status-slot");
      expect(slot).toHaveAttribute("data-active", "true");
      expect(currentSummary(view.container)).toHaveTextContent(
        locale === "en" ? "Working" : "正在处理"
      );
      expect(slot).not.toHaveTextContent("private implementation detail");
      view.rerender(slotView({ ...status, state: "stopped" }));
      expect(slot).toHaveAttribute("data-active", "false");
      view.rerender(slotView(status, true));
      expect(slot).toHaveAttribute("data-active", "false");
      view.rerender(slotView({ ...status, state: "stopped" }));
      expect(slot).toHaveAttribute("data-active", "false");
      view.rerender(slotView(undefined));
      expect(slot).toHaveAttribute("data-active", "false");
      view.rerender(
        slotView({
          ...status,
          issue: "runtime_observation_lost",
          state: "error",
          status: "error: runtime observation was lost",
        })
      );
      const lost =
        locale === "en"
          ? "Lost connection to the computer while working. Check that it’s online."
          : "运行中与电脑断开了连接，请确认电脑在线。";
      await screen.findByText(lost);
      expect(screen.getByRole("alert")).toHaveTextContent(lost);
      expect(slot).not.toHaveTextContent("runtime observation");
      expect(view.container.querySelector(".comma-chat-activity-avatar")).toBeNull();
    }
  );

  it("keeps a background Loop wake out of the previous chat reply", () => {
    const view = render(
      <ParticipantStatusSlot hasResponse participantStatus={router} />
    );
    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute("data-active", "true");

    view.rerender(
      <ParticipantStatusSlot
        hasResponse
        participantStatus={{ ...router, loopWake: true }}
      />
    );
    expect(slot).toHaveAttribute("data-active", "false");

    view.rerender(
      <ParticipantStatusSlot
        hasResponse
        participantStatus={{ ...router, loopWake: true }}
        streaming
      />
    );
    expect(slot).toHaveAttribute("data-active", "false");
  });

  it("keeps Side Chat tool execution separate and visible after prose, then retires it with the owner", () => {
    const activity = {
      phase: "execution",
      status: "running",
      summaryClass: "public" as const,
      summary: "Working",
      toolName: "calendar.list_items",
    };
    const view = render(
      <ParticipantStatusSlot
        activity={activity}
        hasResponse
        participantStatus={router}
        toolPresentation="bubble"
      />
    );
    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute("data-presentation", "tool-call");
    expect(slot).toHaveAttribute("data-tool-name", "calendar.list_items");
    expect(screen.getByRole("status")).toHaveTextContent("Checking your calendar");

    view.rerender(
      <ParticipantStatusSlot
        activity={{ ...activity, toolName: undefined }}
        hasResponse
        participantStatus={router}
        toolPresentation="bubble"
      />
    );
    expect(slot).toHaveAttribute("data-presentation", "tool-call");
    expect(screen.getByRole("status")).toHaveTextContent("Working");

    view.rerender(
      <ParticipantStatusSlot
        activity={activity}
        hasResponse
        participantStatus={router}
      />
    );
    // A first reply does not stop the active owner in full chat either.
    expect(slot).toHaveAttribute("data-active", "true");
    expect(slot).not.toHaveAttribute("data-presentation");

    view.rerender(
      <ParticipantStatusSlot
        activity={activity}
        hasResponse
        participantStatus={{ ...router, state: "stopped" }}
        toolPresentation="bubble"
      />
    );
    expect(slot).toHaveAttribute("data-active", "false");
    expect(slot).not.toHaveAttribute("data-presentation");
  });

  it("does not promote private tool copy and preserves public execution errors", () => {
    const activity = {
      phase: "execution",
      status: "running",
      summaryClass: "none" as const,
      summary: "Internal implementation detail",
      toolName: "calendar.list_items",
    };
    const view = render(
      <ParticipantStatusSlot
        activity={activity}
        hasResponse
        participantStatus={router}
        toolPresentation="bubble"
      />
    );
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(currentSummary(view.container)).toHaveTextContent("Working");
    expect(view.container).not.toHaveTextContent("calendar.list_items");
    expect(view.container).not.toHaveTextContent("Internal implementation detail");
    view.rerender(
      <ParticipantStatusSlot
        activity={{
          ...activity,
          status: "failed",
          summaryClass: "public",
          summary: "Calendar unavailable",
        }}
        hasResponse
        participantStatus={router}
        toolPresentation="bubble"
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t check your calendar");
    expect(screen.getByTestId("participant-status-slot")).not.toHaveAttribute(
      "data-presentation"
    );
  });

  it("keeps a silent acknowledged wait visible without inventing a runtime failure", async () => {
    const view = render(
      <ParticipantStatusSlot participantStatus={undefined} replyTimedOut />
    );
    expect(
      screen.getByText("Message sent. No reply received yet.")
    ).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-state",
      "waiting"
    );
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(view.container.querySelector('[data-slot="ai-activity"]')).toHaveAttribute(
      "aria-busy",
      "false"
    );
    expect(currentSummary(view.container)).toHaveAttribute("data-shimmer", "false");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.container.querySelector(".comma-chat-activity-avatar")).toBeNull();

    // The local deadline cannot mask resumed streaming or a later failure.
    view.rerender(
      <ParticipantStatusSlot participantStatus={undefined} replyTimedOut streaming />
    );
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-state",
      "active"
    );
    expect(currentSummary(view.container)).toHaveTextContent("Typing");
    view.rerender(
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "error",
          status: "Public runtime error",
          updatedAt: 100,
        }}
        replyTimedOut
      />
    );
    const generic = "Something went wrong. Try sending again.";
    expect(await screen.findByText(generic)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(generic);
    expect(screen.queryByText("Public runtime error")).toBeNull();
  });

  it("shows optimistic thinking and yields to real participant activity", () => {
    const view = render(
      <ParticipantStatusSlot participantStatus={undefined} optimisticThinking />
    );

    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(currentSummary(view.container)).toHaveAttribute("data-shimmer", "true");
    expect(
      view.container.querySelector(".comma-chat-thinking-logo")
    ).toBeInTheDocument();

    view.rerender(
      <ParticipantStatusSlot
        activity={{
          phase: "execution",
          status: "running",
          summaryClass: "public",
          summary: "Working",
          toolName: "calendar.list_items",
        }}
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "active",
          status: "is executing a tool...",
          updatedAt: 1_780_000_000_100,
        }}
      />
    );

    expect(screen.getByText("Checking your calendar")).toBeInTheDocument();
    expect(slot).toHaveAttribute("title", "Checking your calendar");
  });

  it("keeps current local send feedback despite the previous stopped snapshot", () => {
    render(
      <ParticipantStatusSlot
        optimisticThinking
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "stopped",
          status: "",
          updatedAt: 1_780_000_000_100,
        }}
      />
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "true"
    );
  });

  it("keeps an inaccessible empty row when no exact Participant status is available", () => {
    const { container } = render(
      <ParticipantStatusSlot participantStatus={undefined} />
    );

    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute("data-active", "false");
    expect(slot.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[data-slot="ai-activity"]')).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("uses localized active copy, words errors from their issue and hides stopped", () => {
    const view = render(
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "active",
          status: "is executing a tool...",
          updatedAt: 1_780_000_000_100,
        }}
      />
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("is executing a tool...")).toBeNull();
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "true"
    );
    expect(currentSummary(view.container)).toHaveAttribute("data-shimmer", "true");

    view.rerender(
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          issue: "rate_limited",
          state: "error",
          status: "error: model request failed.",
          updatedAt: 1_780_000_000_200,
        }}
      />
    );
    expect(
      screen.getByText("Too many requests right now. Try again in a moment.")
    ).toBeInTheDocument();
    expect(screen.queryByText("error: model request failed.")).toBeNull();
    expect(view.container.querySelector('[data-slot="ai-activity"]')).toHaveAttribute(
      "data-status",
      "failed"
    );
    expect(view.container.querySelector(".comma-chat-activity-avatars")).toBeNull();
    expect(view.container.querySelector(".comma-chat-activity-avatar")).toBeNull();

    view.rerender(
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "stopped",
          status: "",
          updatedAt: 1_780_000_000_300,
        }}
      />
    );
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-active",
      "false"
    );
  });

  // A source-bound failure frame has no stable runtime issue. Keep it visible
  // while the durable Participant snapshot is still stopped, but do not infer
  // a model-specific cause from the presentation lifecycle alone.
  it("surfaces a generic failed turn while the Participant status reads stopped", () => {
    const view = render(
      <ParticipantStatusSlot
        activity={{
          phase: "thinking",
          responseKey: "rsp_1",
          sequence: 7,
          status: "failed",
          summaryClass: "generic",
        }}
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "stopped",
          status: "",
          updatedAt: 1_780_000_000_400,
        }}
      />
    );

    expect(screen.getByText("Generation failed")).toBeInTheDocument();
    expect(
      screen.queryByText("Could not connect to the model. Try sending again.")
    ).not.toBeInTheDocument();
    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute("data-active", "true");
    expect(slot).toHaveAttribute("data-state", "error");
    expect(view.container.querySelector('[data-slot="ai-activity"]')).toHaveAttribute(
      "data-status",
      "failed"
    );
    expect(view.container.querySelector(".comma-chat-activity-avatars")).toBeNull();
  });

  it("keeps a public tool failure distinct from a model connection failure", () => {
    render(
      <ParticipantStatusSlot
        activity={{
          phase: "execution",
          responseKey: "rsp_tool",
          sequence: 8,
          status: "failed",
          summary: "Running a command",
          summaryClass: "public",
          toolName: "env.exec",
        }}
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "stopped",
          status: "",
          updatedAt: 1_780_000_000_450,
        }}
      />
    );

    expect(screen.getByText("The command failed")).toBeInTheDocument();
    expect(
      screen.queryByText("Could not connect to the model. Try sending again.")
    ).not.toBeInTheDocument();
  });

  it("words a tool call after a reply in the reader's language, never as its identifier", () => {
    const slotView = (activity: ChatActivity) => (
      <CommaI18nProvider locale="zh-CN">
        <ParticipantStatusSlot
          activity={activity}
          hasResponse
          participantStatus={router}
        />
      </CommaI18nProvider>
    );
    const execution = {
      phase: "execution",
      status: "running",
      summaryClass: "public" as const,
    };
    // Earlier producers put the raw identifier into their English summary.
    const task = render(
      slotView({
        ...execution,
        summary: "Running im_api.internal.update_conversation",
        toolName: "im_api.internal.update_conversation",
      })
    );
    expect(currentSummary(task.container)).toHaveTextContent("正在更新任务");
    expect(task.container).not.toHaveTextContent("im_api");
    expect(task.container).not.toHaveTextContent("Running");
    task.unmount();

    // The model's own label for its command is the most specific wording.
    const command = render(
      slotView({
        ...execution,
        goal: "正在检查日志",
        summary: "正在检查日志",
        toolName: "env.exec",
      })
    );
    expect(currentSummary(command.container)).toHaveTextContent("正在检查日志");
    command.unmount();

    // A messaging app's operation names the app and whether it sends.
    const send = render(
      slotView({
        ...execution,
        summary: "Working",
        toolName: "im_api.feishu.send_text",
      })
    );
    expect(currentSummary(send.container)).toHaveTextContent("正在发送飞书消息");
    send.unmount();
    const read = render(
      slotView({
        ...execution,
        summary: "Working",
        toolName: "im_api.slack.get_channel_history",
      })
    );
    expect(currentSummary(read.container)).toHaveTextContent("正在使用 Slack");
    read.unmount();

    // A public tool without wording names itself as the technical detail.
    const unworded = render(
      slotView({ ...execution, summary: "Working", toolName: "agent.access_set" })
    );
    expect(currentSummary(unworded.container)).toHaveTextContent(
      "正在使用工具 · agent.access_set"
    );
    unworded.unmount();

    // Without a name, or with prose instead of an identifier, nothing is shown
    // beyond the generic line.
    for (const toolName of [undefined, "Run the deploy script now"]) {
      const unnamed = render(slotView({ ...execution, summary: "Working", toolName }));
      expect(currentSummary(unnamed.container)?.textContent).toBe("正在处理");
      unnamed.unmount();
    }

    // A generic frame never shows a tool name, even if one is present.
    const generic = render(
      slotView({
        ...execution,
        phase: "thinking",
        summaryClass: "generic",
        summary: "Thinking",
        toolName: "agent.access_set",
      })
    );
    expect(generic.container).not.toHaveTextContent("agent.access_set");
  });

  it("keeps a canonical non-model error ahead of a failed presentation frame", () => {
    render(
      <ParticipantStatusSlot
        activity={{
          phase: "thinking",
          responseKey: "rsp_repair",
          sequence: 9,
          status: "failed",
          summaryClass: "generic",
        }}
        participantStatus={{
          conversationId: "cnv_1",
          issue: "visible_reply_repair_exhausted",
          participantId: "ptp_1",
          state: "error",
          status: "error: the session could not produce a visible reply",
          updatedAt: 1_780_000_000_475,
        }}
      />
    );

    expect(
      screen.getByText("Couldn’t finish the reply. Try sending again.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("error: the session could not produce a visible reply")
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Generation failed")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Could not connect to the model. Try sending again.")
    ).not.toBeInTheDocument();
  });

  // The durable half: the in-memory failure frame dies with an SSE reconnect
  // (the agent's activity surface drops the session on the terminal idle), so
  // the runtime also settles the session's own activity to error with a stable
  // reason code. That one survives a reload, and carries localized copy rather
  // than the runtime's English text.
  it("localizes a durable model-connection failure from the Participant status", () => {
    render(
      <ParticipantStatusSlot
        participantStatus={{
          conversationId: "cnv_1",
          issue: "model_connection_failed",
          participantId: "ptp_1",
          state: "error",
          status: "error: the model could not be reached",
          updatedAt: 1_780_000_000_600,
        }}
      />
    );

    expect(
      screen.getByText("Could not connect to the model. Try sending again.")
    ).toBeInTheDocument();
    expect(
      screen.queryByText("error: the model could not be reached")
    ).not.toBeInTheDocument();
  });

  it("words runtime issues in the reader's language, never the runtime's text", () => {
    const parked = zhErrorView("runaway_guard_parked", "error: runaway guard parked");
    expect(parked.getByRole("alert")).toHaveTextContent(
      "一直没有进展，已自动停止。请换个说法再试。"
    );
    expect(parked.container).not.toHaveTextContent("runaway");
    parked.unmount();

    // An external runtime's own message stays out of the chat; the Router
    // relays provider details such as a reset time in its reply.
    const limited = zhErrorView(
      "quota_exhausted",
      "error: You've hit your usage limit. Resets at 5pm."
    );
    expect(limited.getByRole("alert")).toHaveTextContent(
      "已达到用量上限，请在额度恢复后再试。"
    );
    expect(limited.container).not.toHaveTextContent("usage limit");
    limited.unmount();

    const unknown = zhErrorView("future_issue", "error: future issue");
    expect(unknown.getByRole("alert")).toHaveTextContent("出了点问题，请重新发送。");
    expect(unknown.container).not.toHaveTextContent("future");
  });

  it("words each Task Participant from its state and issue, never its runtime text", () => {
    render(
      statusView(
        [
          { ...router, status: "is executing a tool..." },
          {
            ...worker,
            issue: "authentication_required",
            state: "error",
            status: "error: Codex needs `codex login` on host-7",
          },
        ],
        "zh-CN"
      )
    );
    const slot = screen.getByTestId("participant-status-slot");
    expect(slot).toHaveAttribute(
      "title",
      "Router · 正在处理\nWorker · 需要重新登录才能继续。"
    );
    expect(slot.getAttribute("title")).not.toContain("executing");
    expect(slot).not.toHaveTextContent("codex");
  });

  it("shows Comma Center router thinking with generic copy and the animated mark", () => {
    const view = render(
      <ParticipantStatusSlot
        activity={{ phase: "thinking", status: "running" }}
        participantStatus={{
          conversationId: "cnv_1",
          participantId: "ptp_1",
          state: "active",
          status: "is thinking...",
          updatedAt: 1_780_000_000_500,
        }}
      />
    );

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("is thinking...")).not.toBeInTheDocument();
    expect(
      view.container.querySelector('[data-slot="comma-logo-animation"]')
    ).toBeInTheDocument();
    expect(
      view.container.querySelector(
        '.comma-chat-thinking-bubble [data-slot="comma-logo-animation"]'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId("participant-status-slot")).toHaveAttribute(
      "data-state",
      "active"
    );
  });
});

describe("Current action", () => {
  const T0 = 1_790_000_000_000;
  const turn = { conversationId: "cnv_1", responseKey: "rsp_1" };
  const running = {
    ...turn,
    phase: "execution",
    status: "running",
    summaryClass: "public" as const,
    summary: "Working",
  };
  const command: ChatActivity = {
    ...running,
    detail: "git",
    startedAt: T0 / 1000,
    toolCallId: "call_a",
    toolName: "env.exec",
    sequence: 2,
  };
  const read: ChatActivity = {
    ...running,
    detail: "notes.md",
    startedAt: (T0 + 7_000) / 1000,
    toolCallId: "call_b",
    toolName: "fs.read_file",
    sequence: 3,
  };
  const slot = (activity: ChatActivity | undefined, extra: object = {}) => (
    <CommaI18nProvider locale="en">
      <ParticipantStatusSlot
        activity={activity}
        participantStatus={router}
        {...extra}
      />
    </CommaI18nProvider>
  );
  const line = (container: HTMLElement) =>
    (currentSummary(container)?.textContent ?? "").replaceAll("\u00a0", " ");
  // The outgoing text layer of a swap stays mounted while it animates out.
  const shown = (container: HTMLElement, testId: string) =>
    currentSummary(container)?.querySelector(`[data-testid="${testId}"]`) ?? null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows thinking, tool A, tool B and the reply in one indicator", () => {
    const view = render(
      slot({ ...turn, phase: "thinking", status: "running", summaryClass: "generic" })
    );
    const indicator = view.getByTestId("participant-status-slot");
    expect(line(view.container)).toBe("Thinking");

    vi.setSystemTime(T0 + 1_000);
    view.rerender(slot(command));
    settle();
    expect(line(view.container)).toBe("Running a command · git · 2s");
    act(() => vi.advanceTimersByTime(3_000));
    expect(line(view.container)).toBe("Running a command · git · 5s");

    // A replay of the same call (new frame, same start) keeps its time.
    view.rerender(slot({ ...command, sequence: 4, updatedAt: (T0 + 5_000) / 1000 }));
    expect(line(view.container)).toBe("Running a command · git · 5s");

    // A new call starts its own time from its own start evidence.
    act(() => vi.advanceTimersByTime(3_000));
    view.rerender(slot(read));
    settle();
    expect(line(view.container)).toBe("Reading files · notes.md · 2s");

    view.rerender(
      slot({ ...turn, phase: "messaging", status: "running", summaryClass: "generic" })
    );
    settle();
    expect(line(view.container)).toBe("Typing");
    expect(shown(view.container, "live-action-elapsed")).not.toBeInTheDocument();
    expect(view.getByTestId("participant-status-slot")).toBe(indicator);
  });

  it("puts the model's goal first and never invents a start or a detail", () => {
    const view = render(
      slot({ ...command, goal: "Checking logs", startedAt: undefined })
    );
    expect(line(view.container)).toBe("Running a command · Checking logs");
    expect(shown(view.container, "live-action-elapsed")).not.toBeInTheDocument();

    // A start without the call's identity cannot be attributed to one action.
    view.rerender(slot({ ...read, detail: undefined, toolCallId: undefined }));
    expect(line(view.container)).toBe("Reading files");
  });

  it("words external runtime tools and names an unknown one by its identifier", () => {
    const view = render(slot({ ...command, toolName: "Bash", toolCallId: "toolu_1" }));
    expect(line(view.container)).toBe("Running a command · git · 0s");

    view.rerender(
      slot({
        ...command,
        detail: undefined,
        toolCallId: "call_mcp",
        toolName: "mcpToolCall",
        sequence: 7,
      })
    );
    settle();
    expect(line(view.container)).toBe("Using a tool · mcpToolCall · 1s");
  });

  it("keeps the original start of a call renewed for 52 minutes", () => {
    const view = render(slot(command));
    vi.setSystemTime(T0 + 52 * 60_000);
    view.rerender(slot({ ...command, sequence: 99 }));
    act(() => vi.advanceTimersByTime(1_000));
    expect(line(view.container)).toBe("Running a command · git · 52m 1s");
  });

  it("retires the running claim when the owner stops or the tool fails", () => {
    const view = render(slot(command));
    expect(shown(view.container, "live-action")).toBeInTheDocument();

    view.rerender(
      <CommaI18nProvider locale="en">
        <ParticipantStatusSlot
          activity={command}
          participantStatus={{ ...router, state: "stopped" }}
        />
      </CommaI18nProvider>
    );
    expect(shown(view.container, "live-action")).not.toBeInTheDocument();

    view.rerender(slot({ ...command, status: "failed", sequence: 5 }));
    settle();
    expect(line(view.container)).toBe("The command failed");
    expect(shown(view.container, "live-action-elapsed")).not.toBeInTheDocument();
  });

  it("keeps each Task Participant's own action instead of generic thinking", () => {
    const workerActivity = {
      detail: "notes.md",
      phase: "execution" as const,
      responseKey: "rsp_w",
      startedAt: (T0 - 3_000) / 1000,
      status: "running" as const,
      summaryClass: "public" as const,
      summary: "Reading a file",
      toolCallId: "call_w",
      toolName: "fs.read_file",
    };
    const view = render(statusView([{ ...worker, activity: workerActivity }]));
    vi.setSystemTime(T0 - 1_000);
    settle();
    expect(line(view.container)).toBe("Worker · Reading files · notes.md · 3s");

    // A running tool call speaks before another Participant's thinking, by
    // its real owner; a repeated snapshot keeps the same line and time.
    const routerThinking = {
      ...router,
      activity: {
        phase: "thinking" as const,
        responseKey: "rsp_r",
        status: "running" as const,
        summaryClass: "generic" as const,
        summary: "Thinking",
      },
    };
    const both = [routerThinking, { ...worker, activity: workerActivity }];
    view.rerender(statusView(both));
    settle();
    expect(line(view.container)).toBe("Worker · Reading files · notes.md · 4s");
    view.rerender(statusView(both.map((item) => ({ ...item, updatedAt: 9 }))));
    expect(line(view.container)).toBe("Worker · Reading files · notes.md · 4s");
    expect(view.getByTestId("participant-status-slot").title).toContain(
      "Worker · Reading files · notes.md"
    );

    // The Worker's call ends: the remaining true state is the Router's
    // thinking, not a waiting claim invented from it.
    view.rerender(statusView([routerThinking, { ...worker, activity: undefined }]));
    settle();
    expect(line(view.container)).toMatch(/· Thinking$/);
    expect(line(view.container)).not.toMatch(/Waiting|Worker ·/);

    // An idle Participant has no action left to claim.
    view.rerender(statusView([{ ...worker, activity: undefined }]));
    settle();
    expect(shown(view.container, "live-action")).not.toBeInTheDocument();
    expect(line(view.container)).toBe("Worker is thinking");
  });
});

// Lets a text swap finish; the fake clock moves with it.
function settle() {
  act(() => vi.advanceTimersByTime(1_000));
}

function currentSummary(container: HTMLElement) {
  return container.querySelector(
    '.comma-ai-activity-text-layer:not([aria-hidden="true"]) .comma-ai-activity-text-summary'
  );
}
