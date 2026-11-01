defmodule SalixVoice.Model.Codex do
  @moduledoc """
  Subscription signaling and sideband adapter. Electron owns WebRTC media.
  There is no Elixir SDK for the Codex Desktop voice protocol. Req and
  WebSockex own HTTP and WebSocket transport. AccountPool owns token renewal.
  Provider bodies and transport exceptions never enter client errors or logs.
  """
  use GenServer
  @behaviour SalixVoice.Model

  @impl SalixVoice.Model
  def start_link(opts), do: GenServer.start_link(__MODULE__, opts)
  @impl SalixVoice.Model
  def send_audio(_pid, _audio), do: :ok
  @impl SalixVoice.Model
  def append(pid, kind, id, text), do: GenServer.cast(pid, {:append, kind, id, text})
  @impl SalixVoice.Model
  def close(pid), do: GenServer.cast(pid, :close)

  @impl true
  def init(opts), do: {:ok, %{opts: opts, socket: nil}, {:continue, :signal}}

  @impl true
  def handle_continue(:signal, state) do
    case connect(state.opts) do
      {:ok, socket, sdp} ->
        Process.monitor(socket)
        notify(state.opts, {:signaled, sdp})
        {:noreply, %{opts: Map.take(state.opts, [:owner, :ref]), socket: socket}}

      {:error, code} ->
        notify(state.opts, {:fatal_error, code})
        {:stop, :normal, %{state | opts: Map.take(state.opts, [:owner, :ref])}}
    end
  end

  @impl true
  def handle_cast({:append, kind, id, text}, state) do
    text =
      if kind == :thinking or match?({:context, _}, kind),
        do: "Quiet context, do not speak: " <> text,
        else: text

    Enum.each(chunks(text), &WebSockex.cast(state.socket, {:append, kind, id, &1}))
    {:noreply, state}
  end

  def handle_cast(:close, state) do
    WebSockex.cast(state.socket, :close)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, _, :process, socket, _}, %{socket: socket} = state),
    do: {:stop, :normal, state}

  @impl true
  def format_status(status), do: Map.update(status, :state, nil, &Map.drop(&1, [:opts]))

  defp connect(opts) do
    config = Application.get_env(:salix_voice, :codex, [])
    accounts = SalixVoice.CodexAccounts.impl()
    session = Ecto.UUID.generate()
    realtime = Ecto.UUID.generate()

    with {:ok, auth} <- accounts.access(opts.input.tenant_id, opts.input.account_id, nil),
         {:ok, response, auth} <- signal(opts, config, accounts, auth, session, realtime),
         {:ok, rtc, sdp} <- answer(response),
         {:ok, socket} <-
           SalixVoice.Model.Codex.Sideband.start_link(
             String.trim_trailing(config[:sideband_url] || "wss://api.openai.com/v1/live", "/") <>
               "/" <> rtc,
             headers(auth, session, realtime, config),
             Map.take(opts, [:owner, :ref])
           ) do
      {:ok, socket, sdp}
    else
      {:error, code} when code in [:plan_limit, :sign_in_required, :invalid_answer] ->
        {:error, code}

      _ ->
        {:error, :subscription_access_unavailable}
    end
  rescue
    _ -> {:error, :subscription_access_unavailable}
  catch
    _, _ -> {:error, :subscription_access_unavailable}
  end

  defp signal(opts, config, accounts, auth, session, realtime) do
    with {:ok, response} <- post(opts, config, auth, session, realtime) do
      if response.status == 401 do
        with {:ok, renewed} <-
               accounts.access(
                 opts.input.tenant_id,
                 opts.input.account_id,
                 auth["credential_revision"]
               ),
             {:ok, retried} <- post(opts, config, renewed, session, realtime) do
          signal_result(retried, renewed)
        end
      else
        signal_result(response, auth)
      end
    end
  end

  defp signal_result(%{status: status} = response, auth) when status in 200..299,
    do: {:ok, response, auth}

  defp signal_result(%{status: 401}, _auth), do: {:error, :sign_in_required}
  defp signal_result(response, _auth), do: {:error, failure(response.status, response.body)}

  defp post(opts, config, auth, session, realtime) do
    Req.post(config[:signaling_url] || "https://chatgpt.com/backend-api/codex/realtime/calls",
      params: [intent: "quicksilver", architecture: "avas"],
      headers: headers(auth, session, realtime, config),
      json: %{
        "sdp" => opts.input.sdp,
        "session" => %{
          "model" => "gpt-live-1-codex",
          "instructions" => opts.instructions,
          "audio" => %{"output" => %{"voice" => opts.settings["gpt_live_voice"] || "cove"}},
          "delegation" => %{"type" => "client"}
        }
      },
      decode_body: false,
      redirect: false,
      retry: false,
      receive_timeout: 30_000,
      connect_options: [timeout: 10_000]
    )
  end

  defp headers(auth, session, realtime, config) do
    version = config[:version] || "0.161.0"

    [
      {"authorization", "Bearer " <> auth["access_token"]},
      {"chatgpt-account-id", auth["chatgpt_account_id"]},
      {"OpenAI-Alpha", "quicksilver=v2"},
      {"User-Agent", "Codex Desktop/" <> version},
      {"originator", "Codex Desktop"},
      {"version", version},
      {"x-session-id", realtime},
      {"session-id", session},
      {"thread-id", session}
    ]
  end

  defp answer(response) do
    location = response |> Req.Response.get_header("location") |> List.first()

    with true <- is_binary(location),
         [rtc] <- Regex.run(~r/rtc_[\w-]+(?=[\/?]|$)/, location),
         sdp when is_binary(sdp) and byte_size(sdp) in 1..131_072 <- response.body do
      {:ok, rtc, sdp}
    else
      _ -> {:error, :invalid_answer}
    end
  end

  def failure(status, body) do
    problem =
      case body do
        text when is_binary(text) ->
          case Jason.decode(text) do
            {:ok, %{"error" => error}} when is_map(error) -> error
            _ -> %{}
          end

        %{} = error ->
          error

        _ ->
          %{}
      end

    if status == 429 or
         Enum.any?(
           [problem["code"], problem["type"]],
           &(&1 in ["usage_limit_reached", "rate_limit_exceeded"])
         ), do: :plan_limit, else: :subscription_access_unavailable
  end

  def chunks(text) do
    {chunks, current, _size} =
      for <<character::utf8 <- text>>, reduce: {[], "", 0} do
        {chunks, current, size} ->
          char = <<character::utf8>>

          if size + byte_size(char) > 500,
            do: {[current | chunks], char, byte_size(char)},
            else: {chunks, current <> char, size + byte_size(char)}
      end

    Enum.reverse([current | chunks]) |> Enum.reject(&(&1 == ""))
  end

  defp notify(opts, event), do: send(opts.owner, {:voice_model, opts.ref, event})
end

defmodule SalixVoice.Model.Codex.Sideband do
  @moduledoc false
  use WebSockex

  def start_link(url, headers, opts) do
    tls =
      if String.starts_with?(url, "wss:"),
        do: [
          insecure: false,
          ssl_options: [
            cacerts: :public_key.cacerts_get(),
            verify: :verify_peer,
            customize_hostname_check: [
              match_fun: :public_key.pkix_verify_hostname_match_fun(:https)
            ]
          ]
        ],
        else: []

    WebSockex.start_link(
      url,
      __MODULE__,
      %{
        owner: opts.owner,
        ref: opts.ref,
        captions: %{},
        last_role: nil,
        closed: false,
        context_appends: 0,
        context_acks: 0,
        pending_context: nil
      },
      [extra_headers: headers, socket_connect_timeout: 15_000, socket_recv_timeout: 30_000] ++ tls
    )
  end

  @impl true
  def handle_cast({:append, kind, id, text}, state) do
    event = %{
      "type" => if(id, do: "delegation.context.append", else: "session.context.append"),
      "channel" => "commentary",
      "content" => [%{"type" => "input_text", "text" => text}]
    }

    # Quiet notes remain context. They explicitly tell GPT-Live not to speak.
    event = if id, do: Map.put(event, "delegation_item_id", id), else: event
    event = if kind == :final, do: Map.delete(event, "channel"), else: event
    # Native context ACKs are ordered on this socket. Track the ordinal of
    # only the newest pending gesture, not a queue of discarded contexts.
    state =
      if is_nil(id) do
        state = %{state | context_appends: state.context_appends + 1}

        case kind do
          {:context, context_id} ->
            %{state | pending_context: {state.context_appends, context_id}}

          _ ->
            state
        end
      else
        state
      end

    {:reply, {:text, Jason.encode!(event)}, state}
  end

  def handle_cast(:close, state) do
    Process.send_after(self(), :close_timeout, 2_000)
    {:reply, {:text, Jason.encode!(%{"type" => "session.close"})}, state}
  end

  @impl true
  def handle_info(:close_timeout, state), do: {:close, state}

  @impl true
  def handle_frame({:text, raw}, state) do
    case Jason.decode(raw) do
      {:ok, event} -> receive_event(event, state)
      _ -> {:ok, state}
    end
  end

  def handle_frame(_, state), do: {:ok, state}

  defp receive_event(%{"type" => "session.started"} = event, state) do
    notify(state, {:started, get_in(event, ["session", "id"])})
    {:ok, state}
  end

  defp receive_event(%{"type" => "session.closed"}, state) do
    notify(state, {:closed, "closed", %{}})
    {:close, %{state | closed: true}}
  end

  defp receive_event(%{"type" => type, "item" => %{"text" => text}}, state)
       when type in ["input_transcript.added", "output_transcript.added"] and is_binary(text),
       do:
         caption(
           state,
           if(type == "input_transcript.added", do: :caller, else: :agent),
           text,
           false
         )

  defp receive_event(%{"type" => "session.context.appended"} = event, state) do
    acknowledged = state.context_acks + 1
    state = %{state | context_acks: acknowledged}

    case state.pending_context do
      {^acknowledged, context_id} ->
        boundary =
          case event do
            %{"start_ms" => start_ms, "end_ms" => end_ms}
            when is_integer(start_ms) and is_integer(end_ms) and start_ms >= 0 and
                   end_ms >= start_ms ->
              end_ms

            _ ->
              nil
          end

        notify(state, {:context_started, context_id, boundary})
        {:ok, %{state | pending_context: nil}}

      _ ->
        {:ok, state}
    end
  end

  defp receive_event(
         %{
           "type" => "turn.created",
           "turn" => %{"role" => "user", "id" => id, "start_ms" => start_ms}
         },
         state
       )
       when is_binary(id) and byte_size(id) > 0 and is_integer(start_ms) and start_ms >= 0 do
    notify(state, {:user_turn_started, id, start_ms})
    {:ok, state}
  end

  defp receive_event(
         %{"type" => "turn.done", "turn" => %{"role" => role, "transcript" => text}},
         state
       )
       when role in ["user", "assistant"] and is_binary(text),
       do: caption(state, if(role == "user", do: :caller, else: :agent), text, true)

  defp receive_event(
         %{"type" => "delegation.created", "item" => %{"target" => "client", "id" => id} = item} =
           event,
         state
       )
       when is_binary(id) do
    request =
      case item["content"] do
        content when is_list(content) ->
          content
          |> Enum.flat_map(fn
            %{"type" => "input_text", "text" => text} when is_binary(text) -> [text]
            _ -> []
          end)
          |> Enum.join("\n")
          |> String.slice(0, 16_000)

        _ ->
          nil
      end

    request =
      if is_binary(request) and String.trim(request) == "", do: nil, else: request

    notify(state, {:delegation, id, event["offset_ms"], request, item["user_bidi_turn_id"]})
    {:ok, state}
  end

  defp receive_event(%{"type" => "error"} = event, state) do
    notify(state, {:fatal_error, SalixVoice.Model.Codex.failure(0, event["error"])})
    {:close, %{state | closed: true}}
  end

  defp receive_event(_, state), do: {:ok, state}

  defp caption(state, role, text, final?) do
    previous = Map.get(state.captions, role, %{text: "", final: false, turn: 0})

    duplicate =
      previous.final and state.last_role == role and
        (text == previous.text or (not final? and String.ends_with?(previous.text, text)))

    if text == "" or duplicate do
      {:ok, state}
    else
      new_turn = previous.text == "" or previous.final

      next =
        cond do
          new_turn -> text
          final? -> if(String.starts_with?(previous.text, text), do: previous.text, else: text)
          String.starts_with?(text, previous.text) -> text
          String.ends_with?(previous.text, text) -> previous.text
          true -> previous.text <> text
        end
        |> String.slice(0, 16_000)

      turn = previous.turn + if(new_turn, do: 1, else: 0)

      if new_turn or next != previous.text or final? != previous.final,
        do: notify(state, {:caption, role, turn, next, final?})

      {:ok,
       %{
         state
         | last_role: role,
           captions: Map.put(state.captions, role, %{text: next, turn: turn, final: final?})
       }}
    end
  end

  @impl true
  def handle_disconnect(_status, state) do
    unless state.closed, do: notify(state, {:closed, "connection_lost", %{}})
    {:ok, %{state | closed: true}}
  end

  @impl true
  def terminate(_, _), do: :ok
  @impl true
  def format_status(_opt, [_pdict, state]), do: [data: [{"State", Map.take(state, [:closed])}]]
  defp notify(state, event), do: send(state.owner, {:voice_model, state.ref, event})
end
