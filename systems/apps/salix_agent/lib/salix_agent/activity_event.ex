defmodule SalixAgent.ActivityEvent do
  @moduledoc """
  Emits fine-grained agent activity signals (thinking / tool execution /
  messaging / idle) over `SalixAgent.Notifier` as `{:activity, map}` while a
  round runs, so an authorized status surface can show live "thinking" and
  "calling tool X" states between the user's Message and any later explicit
  provider send.

  The map shape mirrors Willow's `StreamActivity` (the commaboard frontend's
  `WebAgentAssistantActivity` contract): `phase` / `status` / `action` /
  `summary` / `summary_class` / `goal` / `detail`, `tool_name` / `tool_call_id` /
  `started_at`, `display_strength` /
  `display_priority` / `display_hold_ms`, `producer_epoch`, `sequence`,
  `updated_at`. Aggregate frames emit `agent_id` / `session_id` only. A fully
  authorized source activation additionally emits its exact
  `agent_group_id`, `conversation_id`, `participant_id`, `response_key`,
  and ordered `source_message_ids`; partial owner scopes are never projected.

  Execution `action` / `summary` text is an English fallback for consumers
  that cannot localize. Comma clients word tool activity in the reader's
  language from `tool_name`, and show `goal` (the model's own label for an
  `env.exec` call) or else `detail` (a file name, program name or host) when
  present. A tool identifier is never wording; for a tool without wording the
  client shows its public identifier as technical detail.

  Emission is best-effort: `Notifier.notify/2` rescues consumer failures, so a
  bad subscriber never breaks a round.

  The source-bound Activity v2 identity and producer cursor are modeled in
  `tla/salix/ActivityPresentation.tla`. Summary authority, public-history
  admission, and non-public egress sanitization are modeled in
  `tla/salix/ActivitySummaryAuthority.tla`.
  """

  alias SalixAgent.Notifier

  @strength_strong "strong"
  @strength_weak "weak"

  @priority_transition "transition"
  @priority_work "work"
  @priority_high "high"

  @default_work_hold_ms 5_000

  # Conversation replies are posted via this tool, so execution surfaces as a
  # "messaging" activity rather than an opaque tool execution. The IM adapter
  # emits it only after the exact-call permit and target validation. Raw tool
  # JSON is never public; Round may separately project only the decoded plain
  # text of an exact source-bound internal send into Participant draft status.
  @reply_tool "im_api.internal.send_message"

  # A reasoning tail longer than this is cut mid-thought anyway; keep the
  # status line to roughly one sentence.
  @reasoning_summary_max_chars 140
  @public_activity_prose_max_codepoints 512

  @summary_class_none "none"
  @summary_class_generic "generic"
  @summary_class_public "public"

  @doc """
  Agent is reasoning before producing a reply or tool call. `public_summary`
  is optional provider-designated public summary text. Raw provider reasoning
  must never be passed here; without a public summary the event stays generic.
  """
  @spec thinking(String.t(), String.t(), String.t() | nil, map() | nil) :: :ok
  def thinking(agent_id, session_id, public_summary \\ nil, activation_scope \\ nil) do
    summary = reasoning_summary(public_summary)

    emit(
      agent_id,
      session_id,
      %{
        phase: "thinking",
        action: "Thinking",
        summary: summary || "Thinking",
        summary_class: if(summary, do: @summary_class_public, else: @summary_class_generic),
        status: "running",
        display_strength: @strength_weak
      },
      activation_scope
    )
  end

  # The tail of the reasoning stream, as one displayable line: last non-empty
  # line, markdown-ish heading/bullet markers stripped, capped in length
  # (keeping the END — the freshest thought — when the line runs long).
  defp reasoning_summary(reasoning) when is_binary(reasoning) do
    line =
      reasoning
      |> String.split(~r/\r?\n/)
      |> Enum.map(&String.trim/1)
      |> Enum.reject(&(&1 == ""))
      |> List.last()

    case line && String.replace(line, ~r/^[#>*-]+\s*/, "") do
      nil ->
        nil

      trimmed ->
        summary =
          cond do
            trimmed == "" ->
              nil

            String.length(trimmed) <= @reasoning_summary_max_chars ->
              trimmed

            true ->
              "…" <>
                String.slice(trimmed, -@reasoning_summary_max_chars, @reasoning_summary_max_chars)
          end

        bound_public_activity_prose(summary)
    end
  end

  defp reasoning_summary(_reasoning), do: nil

  # Comma and every client enforce the public wire budget in Unicode code
  # points. Preserve the existing human-facing grapheme truncation above, then
  # close the producer boundary for pathological combining-mark clusters too.
  defp bound_public_activity_prose(nil), do: nil

  defp bound_public_activity_prose(value) do
    codepoints = String.codepoints(value)

    if length(codepoints) <= @public_activity_prose_max_codepoints do
      value
    else
      "…" <> grapheme_suffix_within_codepoints(value, @public_activity_prose_max_codepoints - 1)
    end
  end

  defp grapheme_suffix_within_codepoints(value, budget) do
    value
    |> String.graphemes()
    |> Enum.reverse()
    |> Enum.reduce_while({[], 0}, fn grapheme, {suffix, size} ->
      next_size = size + length(String.codepoints(grapheme))

      if next_size <= budget,
        do: {:cont, {[grapheme | suffix], next_size}},
        else: {:halt, {suffix, size}}
    end)
    |> elem(0)
    |> Enum.join()
  end

  @doc "Agent is composing a visible reply."
  @spec typing(String.t(), String.t(), map() | nil) :: :ok
  def typing(agent_id, session_id, activation_scope \\ nil) do
    emit(
      agent_id,
      session_id,
      %{
        phase: "messaging",
        action: "Typing",
        summary: "Typing",
        summary_class: @summary_class_generic,
        status: "running",
        display_strength: @strength_strong
      },
      activation_scope
    )
  end

  @doc """
  Emit an "execution" running activity for each non-reply tool about to run.
  The reply tool is skipped here because the validated IM adapter boundary
  emits its messaging activity; raw tool arguments are never an activity
  payload.

  `started_at` (epoch seconds) is the action's start evidence. Every frame
  for the same `tool_call_id` carries the same value, so a client times the
  current action from it rather than from frame receipt. A frame without it
  has no known start. `detail` is the bounded technical detail admitted by
  `call_detail/2`, never the raw argument.
  """
  @spec tool_calls_started(String.t(), String.t(), [map()], map() | nil, number() | nil) :: :ok
  def tool_calls_started(
        agent_id,
        session_id,
        tool_calls,
        activation_scope \\ nil,
        started_at \\ nil
      ) do
    for call <- tool_calls, name = activity_tool_name(call), name != nil, not reply_call?(call) do
      goal = call_goal(name, call)
      action = goal || describe_tool(name)

      emit(
        agent_id,
        session_id,
        %{
          phase: "execution",
          action: action,
          summary: action,
          summary_class: @summary_class_public,
          goal: goal,
          detail: call_detail(name, call),
          status: "running",
          tool_name: name,
          tool_call_id: call_id(call),
          started_at: started_at,
          display_strength: @strength_strong
        },
        activation_scope
      )
    end

    :ok
  end

  @doc """
  The surface after tool work ended or a batch settled. `running` lists the
  calls of one response that are still executing, each as
  `%{call: call, started_at: seconds, call_index: index}`. The most recently
  started one owns the surface with its own start (call order breaks a tie),
  so the surface stays on the call it already shows while that call runs.
  With none, the Agent is back at the model. Calls that only wait for
  admission are never in `running`.
  """
  @spec settle_tool_calls(String.t(), String.t(), [map()], map() | nil) :: :ok
  def settle_tool_calls(agent_id, session_id, running, activation_scope) do
    case Enum.max_by(running, &{&1[:started_at] || 0, &1[:call_index] || 0}, fn -> nil end) do
      %{call: call} = latest ->
        tool_calls_started(agent_id, session_id, [call], activation_scope, latest[:started_at])

      nil ->
        thinking(agent_id, session_id, nil, activation_scope)
    end
  end

  @doc """
  One call's dependency ended. Only when the surface still names a running
  call of `activation_scope`'s response, and that call is no longer running,
  does the surface move: to another running call of that response, or back
  to thinking. A surface that already moved on (a later frame, another
  response, idle) is left alone, so an ended call cannot revive a turn.
  """
  @spec tool_call_ended(String.t(), String.t(), [map()], map() | nil) :: :ok
  def tool_call_ended(agent_id, session_id, running, activation_scope)
      when is_map(activation_scope) do
    response_key = activation_scope["response_identity"] || activation_scope[:response_identity]

    case SalixAgent.ActivitySurface.get_session(agent_id, session_id) do
      %{
        "phase" => "execution",
        "status" => "running",
        "response_key" => ^response_key,
        "tool_call_id" => shown
      }
      when is_binary(response_key) ->
        unless Enum.any?(running, &(tool_call_identity(&1[:call]) == shown)),
          do: settle_tool_calls(agent_id, session_id, running, activation_scope)

        :ok

      _moved_on ->
        :ok
    end
  end

  def tool_call_ended(_agent_id, _session_id, _running, _activation_scope), do: :ok

  @doc "The producer clock used for `started_at` and `updated_at`."
  @spec now() :: float()
  def now, do: System.system_time(:millisecond) / 1000

  @doc "Emit a failed execution activity for each errored non-reply result."
  @spec tool_calls_finished(String.t(), String.t(), [map()], map() | nil) :: :ok
  def tool_calls_finished(agent_id, session_id, results, activation_scope \\ nil) do
    for result <- results,
        errored?(result),
        name = result_name(result),
        name != nil,
        name != @reply_tool do
      emit(
        agent_id,
        session_id,
        %{
          phase: "execution",
          action: "Hit a wall",
          summary: describe_tool(name),
          summary_class: @summary_class_public,
          status: "failed",
          tool_name: name,
          tool_call_id: result_id(result),
          display_strength: @strength_strong
        },
        activation_scope
      )
    end

    :ok
  end

  @doc "The model request failed before the agent could commit a reply."
  @spec llm_failed(String.t(), String.t(), map() | nil) :: :ok
  def llm_failed(agent_id, session_id, activation_scope \\ nil) do
    emit(
      agent_id,
      session_id,
      %{
        phase: "thinking",
        summary_class: @summary_class_generic,
        status: "failed",
        display_strength: @strength_strong
      },
      activation_scope
    )
  end

  @doc "Turn settled — clear the activity surface for this session."
  @spec idle(String.t(), String.t(), map() | nil) :: :ok
  def idle(agent_id, session_id, activation_scope \\ nil) do
    emit(
      agent_id,
      session_id,
      %{
        phase: "idle",
        status: "idle",
        summary_class: @summary_class_none,
        display_strength: @strength_weak
      },
      activation_scope
    )
  end

  defp emit(agent_id, session_id, attrs, activation_scope)
       when is_binary(agent_id) and is_binary(session_id) do
    attrs = bound_public_activity_attrs(attrs)
    phase = attrs[:phase]
    status = attrs[:status]
    tool_name = present(attrs[:tool_name])
    priority = display_priority(phase, status, tool_name)
    producer_epoch = SalixAgent.ActivitySurface.producer_epoch()

    activity =
      %{
        "agent_id" => agent_id,
        "session_id" => session_id,
        "conversation_id" => nil,
        "phase" => phase,
        "status" => status,
        "action" => attrs[:action],
        "summary" => attrs[:summary],
        "summary_class" => normalize_summary_class(attrs[:summary_class]),
        "goal" => attrs[:goal],
        "detail" => attrs[:detail],
        "tool_name" => tool_name,
        "tool_call_id" => present(attrs[:tool_call_id]),
        "started_at" => started_at(attrs[:started_at]),
        "display_strength" => normalize_strength(attrs[:display_strength]),
        "display_priority" => priority,
        "display_hold_ms" => hold_ms(priority),
        "producer_epoch" => producer_epoch,
        "sequence" => System.unique_integer([:monotonic, :positive]),
        "updated_at" => now()
      }
      |> Map.merge(activity_v2_scope(activation_scope, producer_epoch))
      |> Enum.reject(fn {_key, value} -> is_nil(value) end)
      |> Map.new()

    # The surface cache lets late subscribers (page refresh, SSE reconnect)
    # seed from the current state instead of waiting for the next signal.
    SalixAgent.ActivitySurface.put(activity)
    SalixAgent.SessionActivity.notify(agent_id, session_id)
    Notifier.notify(agent_id, {:activity, activity})
  end

  defp emit(_agent_id, _session_id, _attrs, _activation_scope), do: :ok

  defp bound_public_activity_attrs(%{summary_class: @summary_class_public} = attrs) do
    Enum.reduce([:action, :summary, :goal, :detail, :tool_name], attrs, fn field, bounded ->
      case Map.fetch(bounded, field) do
        {:ok, value} when is_binary(value) ->
          Map.put(bounded, field, bound_public_activity_prose(value))

        _missing_or_nonbinary ->
          bounded
      end
    end)
  end

  defp bound_public_activity_attrs(attrs), do: attrs

  # Activity v2 is an all-or-nothing source-activation projection. Never copy a
  # partial scope: Comma's conversation SSE accepts only this complete composite.
  defp activity_v2_scope(scope, producer_epoch) when is_map(scope) do
    if SalixAgent.VisibleReplyScope.valid_activation_scope?(scope) and
         is_binary(producer_epoch) and producer_epoch != "" and byte_size(producer_epoch) <= 128 do
      %{
        "agent_group_id" => scope["agent_group_id"] || scope[:agent_group_id],
        "conversation_id" => scope["conversation_id"] || scope[:conversation_id],
        "participant_id" => scope["participant_id"] || scope[:participant_id],
        "response_key" => scope["response_identity"] || scope[:response_identity],
        "source_message_ids" => scope["source_message_ids"] || scope[:source_message_ids]
      }
    else
      %{}
    end
  end

  defp activity_v2_scope(_scope, _producer_epoch), do: %{}

  # Display priority drives client ordering/iconography; mirrors Willow's
  # displayPriorityForActivity.
  defp display_priority(phase, status, tool_name) do
    cond do
      normalize(status) in ["failed", "error", "waiting"] -> @priority_high
      normalize(phase) == "messaging" -> @priority_high
      normalize(phase) == "execution" and tool_name != nil -> @priority_work
      true -> @priority_transition
    end
  end

  defp hold_ms(@priority_work), do: @default_work_hold_ms
  defp hold_ms(_priority), do: 0

  defp normalize_strength(value) do
    case normalize(value) do
      @strength_weak -> @strength_weak
      _ -> @strength_strong
    end
  end

  # `private` is intentionally not a wire value. Unknown producer input loses
  # summary authority instead of being inferred from the text payload.
  defp normalize_summary_class(value)
       when value in [@summary_class_generic, @summary_class_public],
       do: value

  defp normalize_summary_class(_value), do: @summary_class_none

  # `env.exec` calls carry a short `description` the model writes for the
  # user, already phrased as an ongoing action ("Checking logs"). It becomes
  # the call's `goal` and English text verbatim. The call is inspected before
  # dispatcher validation, so the label's length is capped here rather than
  # trusted.
  @exec_description_max_chars 40

  defp call_goal("env.exec", call) do
    case present(call_args(call)["description"]) do
      nil -> nil
      description -> String.slice(description, 0, @exec_description_max_chars)
    end
  end

  defp call_goal(_name, _call), do: nil

  defp started_at(value) when is_number(value) and value > 0, do: value
  defp started_at(_value), do: nil

  # Technical detail is admitted per tool, from one known argument, reduced to
  # a part that names the target without its contents: a file's base name, a
  # command's program name, or a URL's host. Anything else, or any value
  # outside the narrow shapes below, yields no detail. This is not a secret
  # scanner: whole commands, paths, queries, URLs and payloads are never
  # admitted, because no pattern can prove such free text is safe to show.
  @file_detail_tools ~w(fs.read_file fs.write_file fs.edit_file fs.delete_file fs.stat_file
                        compute.workspace.read compute.workspace.write compute.workspace.stat)
  @web_detail_tools ~w(web.read_pages web.http_request)
  # Native tools of external runtimes, as the Connector's canonical operation
  # events name them, with the same admitted argument shapes.
  @external_file_tools ~w(Read Write Edit MultiEdit NotebookEdit)
  @external_command_tools ~w(Bash commandExecution)
  @detail_max_codepoints 64

  defp call_detail(name, call) when name in @file_detail_tools,
    do: file_name_detail(call_args(call)["path"])

  defp call_detail("env.exec", call), do: program_detail(call_args(call)["command"])

  defp call_detail(name, call) when name in @external_file_tools do
    args = call_args(call)
    file_name_detail(args["file_path"] || args["notebook_path"] || args["path"])
  end

  defp call_detail(name, call) when name in @external_command_tools,
    do: program_detail(call_args(call)["command"])

  defp call_detail("WebFetch", call), do: host_detail_of(call_args(call)["url"])

  defp call_detail(name, call) when name in @web_detail_tools do
    args = call_args(call)

    case args["url"] || List.wrap(args["urls"]) |> List.first() do
      url when is_binary(url) -> host_detail(url)
      _absent -> nil
    end
  end

  defp call_detail(_name, _call), do: nil

  defp host_detail_of(url) when is_binary(url), do: host_detail(url)
  defp host_detail_of(_url), do: nil

  defp file_name_detail(path) when is_binary(path) do
    name = path |> String.trim() |> String.trim_trailing("/") |> Path.basename()

    if String.length(name) <= @detail_max_codepoints and
         Regex.match?(~r/\A[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*\z/u, name) and
         not Regex.match?(~r/\A\.+\z/, name),
       do: name
  end

  defp file_name_detail(_path), do: nil

  # The first word only, when it is a plain lowercase program name. An
  # environment assignment, quoting, substitution or anything else that is not
  # a program name fails closed, and nothing after the first word is read.
  defp program_detail(command) when is_binary(command) do
    with [word | _rest] <- String.split(String.trim(command), ~r/\s+/, parts: 2),
         program = Path.basename(word),
         true <- Regex.match?(~r/\A[a-z][a-z0-9._+-]{0,23}\z/, program) do
      program
    else
      _not_a_program_name -> nil
    end
  end

  defp program_detail(_command), do: nil

  # Host only: user info, port, path, query and fragment are dropped.
  defp host_detail(url) do
    case URI.parse(String.trim(url)) do
      %URI{scheme: scheme, host: host} when scheme in ["http", "https"] and is_binary(host) ->
        host = String.downcase(host)

        if byte_size(host) <= @detail_max_codepoints and
             Regex.match?(~r/\A[a-z0-9-]+(?:\.[a-z0-9-]+)+\z/, host),
           do: host

      _other ->
        nil
    end
  end

  # A "call" envelope nests the target tool's arguments under "params".
  defp call_args(call) do
    args = call[:args] || call["args"]
    args = if is_map(args), do: args, else: %{}

    case call_name(call) do
      "call" ->
        case args[:params] || args["params"] do
          params when is_map(params) -> params
          _not_a_map -> %{}
        end

      _direct ->
        args
    end
  end

  # English fallback text for a tool. Kept intentionally small: anything not
  # mapped reads "Working", because a tool identifier means nothing to a user.
  defp describe_tool(name) do
    case name do
      "env.exec" -> "Running a command"
      "env.copy" -> "Copying files"
      "fs.read_file" -> "Reading a file"
      "fs.write_file" -> "Writing a file"
      "fs.edit_file" -> "Editing a file"
      "web.search" -> "Searching the web"
      "oauth.request_authorization" -> "Requesting access"
      _ -> "Working"
    end
  end

  @doc false
  def reply_call?(call) when is_map(call) do
    case call_name(call) do
      @reply_tool ->
        true

      "call" ->
        args = call[:args] || call["args"] || %{}
        to_string(args[:tool] || args["tool"] || "") == @reply_tool

      _ ->
        false
    end
  end

  def reply_call?(_call), do: false

  defp call_name(call) when is_map(call), do: present(call[:name] || call["name"])

  defp activity_tool_name(call) when is_map(call) do
    case call_name(call) do
      "call" ->
        args = call[:args] || call["args"] || %{}
        present(args[:tool] || args["tool"]) || "call"

      other ->
        other
    end
  end

  defp activity_tool_name(_), do: nil

  defp call_id(call) when is_map(call),
    do: present(call[:id] || call["id"] || call[:tool_call_id] || call["tool_call_id"])

  defp call_id(_), do: nil

  defp result_name(result) when is_map(result),
    do: present(result[:name] || result["name"] || result[:tool_name] || result["tool_name"])

  defp result_name(_), do: nil

  defp result_id(result) when is_map(result),
    do: present(result[:id] || result["id"] || result[:tool_call_id] || result["tool_call_id"])

  defp result_id(_), do: nil

  defp errored?(result) when is_map(result) do
    result[:error] == true or result["error"] == true or
      normalize(result[:status] || result["status"]) in ["error", "failed"]
  end

  defp errored?(_), do: false

  defp normalize(value) when is_binary(value), do: value |> String.trim() |> String.downcase()
  defp normalize(_), do: nil

  defp present(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp present(_), do: nil

  @doc false
  def reply_tool, do: @reply_tool

  @doc false
  # The identity a frame carries in `tool_call_id` for this call.
  def tool_call_identity(call), do: call_id(call)

  @doc false
  # Whether `tool_calls_started/5` emits a frame for this call.
  def activity_call?(call), do: activity_tool_name(call) != nil and not reply_call?(call)

  @doc false
  # Whether `tool_calls_finished/4` emits a failure frame for this result.
  def errored_result?(result),
    do: errored?(result) and result_name(result) not in [nil, @reply_tool]
end
