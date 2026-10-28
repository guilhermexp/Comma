defmodule CommaWeb.VoiceCalls do
  @moduledoc "Workspace authority for Electron calls. Credentials stay inside Salix."
  alias SalixVoice.Carrier.Electron

  @max_context_bytes 20_000
  @max_context_attachments 2
  @safe_max_context_id 9_007_199_254_740_991
  @upload_path ~r|\A/uploads/[A-Za-z0-9_-]{22}-[A-Za-z0-9._-]+\z|

  @doc "Starts an Electron conversation or a push-to-talk call."
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

  @doc "Dispatches scoped push-to-talk context transitions to the live call."
  def context(workspace, user, id, params) when is_map(params) do
    context_id = Map.get(params, "context_id", Map.get(params, :context_id))
    status = Map.get(params, "status", Map.get(params, :status))

    if is_integer(context_id) and context_id in 1..@safe_max_context_id do
      with {:ok, payload} <- validate_context_payload(status, context_id, params) do
        Electron.context(id, scope(workspace, user), payload)
      end
    else
      {:error, :invalid_input}
    end
  end

  def context(_, _, _, _), do: {:error, :invalid_input}

  defp validate_context_payload(status, context_id, _params)
       when status in ["pending", :pending],
       do: {:ok, %{context_id: context_id, status: :pending}}

  defp validate_context_payload(status, context_id, params)
       when status in ["complete", :complete] do
    text = Map.get(params, "text", Map.get(params, :text))
    attachments = Map.get(params, "attachments", Map.get(params, :attachments, []))

    if valid_string?(text, @max_context_bytes) and valid_attachments?(attachments) do
      {:ok, %{context_id: context_id, status: :complete, text: text, attachments: attachments}}
    else
      {:error, :invalid_input}
    end
  end

  defp validate_context_payload(status, context_id, _params)
       when status in ["failed", :failed],
       do: {:ok, %{context_id: context_id, status: :failed}}

  defp validate_context_payload(status, context_id, _params)
       when status in ["cancelled", :cancelled],
       do: {:ok, %{context_id: context_id, status: :cancelled}}

  defp validate_context_payload(_, _, _), do: {:error, :invalid_input}

  defp valid_attachments?(attachments) when is_list(attachments) do
    length(attachments) <= @max_context_attachments and
      Enum.all?(attachments, &valid_attachment?/1)
  end

  defp valid_attachments?(_), do: false

  defp valid_attachment?(%{} = att) do
    path = Map.get(att, "path", Map.get(att, :path))
    name = Map.get(att, "name", Map.get(att, :name))
    mime = Map.get(att, "mime", Map.get(att, :mime))
    has_file_id? = Map.has_key?(att, "file_id") or Map.has_key?(att, :file_id)

    not has_file_id? and
      valid_string?(name, 255) and mime in ["image/png", "image/jpeg"] and
      valid_string?(path, 4_096) and Regex.match?(@upload_path, path)
  end

  defp valid_attachment?(_), do: false

  defp valid_string?(value, max_bytes) when is_binary(value),
    do: byte_size(value) in 1..max_bytes and String.valid?(value) and String.trim(value) != ""

  defp valid_string?(_, _), do: false

  defp mode(nil), do: {:ok, %{}}
  defp mode("push_to_talk"), do: {:ok, %{mode: :push_to_talk}}
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
    do: "A valid SDP offer, call mode, event cursor or call context is required."

  def message(_), do: "ChatGPT voice could not connect. Check your ChatGPT Profile and try again."
end
