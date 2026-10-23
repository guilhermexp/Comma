defmodule CommaWeb.VoiceCalls do
  @moduledoc "Workspace authority for Electron calls. Credentials stay inside Salix."
  alias SalixVoice.Carrier.Electron

  # A text a read-aloud call may be sent at once (the voice ends at 120 s).
  @max_say_bytes 20_000

  @doc """
  Starts an Electron call. `"mode" => "read_aloud"` opens a call that only
  reads the text sent with `say/4`.
  """
  def start(workspace, user, %{"sdp" => sdp} = params)
      when is_binary(sdp) and byte_size(sdp) in 1..131_072 do
    with {:ok, mode} <- mode(params["mode"]),
         true <- String.valid?(sdp),
         {:ok, connect} <-
           SalixIM.VoiceConnects.ensure_voice_im_connect(
             workspace["salix_tenant_id"],
             workspace["default_group_id"]
           ) do
      Electron.start(
        %{
          carrier: :electron,
          tenant_id: workspace["salix_tenant_id"],
          group_id: workspace["default_group_id"],
          connect_id: connect["connect_id"],
          caller: %{"kind" => "comma_user", "value" => user["id"]},
          principal: user["id"],
          display_name: user["name"],
          audio_format: :pcm16_24k,
          sdp: sdp
        }
        |> Map.merge(mode)
      )
    else
      false -> {:error, :invalid_input}
      error -> error
    end
  end

  def start(_, _, _), do: {:error, :invalid_input}

  def events(workspace, user, id, cursor) do
    case Integer.parse(cursor) do
      {after_cursor, ""} when after_cursor >= 0 ->
        Electron.events(id, scope(workspace, user), after_cursor)

      _ ->
        {:error, :invalid_input}
    end
  end

  def hang_up(workspace, user, id), do: Electron.hang_up(id, scope(workspace, user))

  @doc "Queues text for a read-aloud call; it is spoken once the session starts."
  def say(workspace, user, id, %{"text" => text})
      when is_binary(text) and byte_size(text) <= @max_say_bytes do
    if String.valid?(text) and String.trim(text) != "",
      do: Electron.say(id, scope(workspace, user), text),
      else: {:error, :invalid_input}
  end

  def say(_, _, _, _), do: {:error, :invalid_input}

  defp mode(nil), do: {:ok, %{}}
  defp mode("read_aloud"), do: {:ok, %{mode: :read_aloud}}
  defp mode(_), do: {:error, :invalid_input}

  defp scope(workspace, user),
    do: {workspace["salix_tenant_id"], workspace["default_group_id"], user["id"]}

  def message(:codex_account_required),
    do: "Add an enabled ChatGPT account in Settings, Models, Profiles to call Comma."

  def message(:plan_limit),
    do: "Your ChatGPT plan voice limit has been reached. Try again after it resets."

  def message(:sign_in_required),
    do: "ChatGPT rejected your sign-in. Reconnect your ChatGPT Profile."

  def message(:disabled), do: "Voice calls are disabled. Enable voice in Salix settings."
  def message(:busy), do: "This workspace already has an active call."
  def message(:call_not_found), do: "This voice call has ended."

  def message(:invalid_input),
    do: "A valid SDP offer, call mode, event cursor or text to read is required."

  def message(_), do: "ChatGPT voice could not connect. Check your ChatGPT Profile and try again."
end
