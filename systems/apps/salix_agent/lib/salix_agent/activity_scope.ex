defmodule SalixAgent.ActivityScope do
  @moduledoc """
  The source-bound scope of an activation's Activity presentation when it has
  no visible-reply scope: a Task activation, or an external runtime dispatch.

  It is presentation only. It never authorizes a draft, a send, or any other
  egress; `SalixAgent.VisibleReplyScope` keeps that authority. Its frames reach
  only the exact Participant's status in the exact Conversation, whose readers
  already see that Participant (`SalixIM.ConversationParticipantActivity`).

  The scope comes from admitted durable facts only: the activation's ordered
  source identities and the trusted origins stored with that input. Every
  source must name one Conversation and Participant, every origin must be an
  internal origin of that same Group, Conversation and Participant, and every
  source message must have its origin. Anything else yields `nil`, so the
  activation keeps generic Participant status. Connector payloads and model
  output never contribute.

  The response identity is derived from the owner (Agent and Session) and the
  activation key (source identities for an internal round, the admitted
  dispatch id for an external one). It is stable across rounds, restarts and
  replays of one activation and differs for the next.
  """

  @kinds ~w(user_chat agent_task)

  @spec derive(String.t(), String.t(), term(), [String.t()], [map()], [String.t()]) ::
          map() | nil
  def derive(agent_id, session_id, activation_key, source_ids, origins, kinds \\ @kinds)

  def derive(agent_id, session_id, activation_key, [_ | _] = source_ids, [_ | _] = origins, kinds)
      when is_binary(agent_id) and is_binary(session_id) do
    with true <- Enum.uniq(source_ids) == source_ids,
         {:ok, conversation_id, participant_id, message_ids} <- decode_sources(source_ids),
         {:ok, group_id} <- common_group(origins, conversation_id, participant_id, kinds),
         true <-
           Enum.all?(message_ids, fn id -> Enum.any?(origins, &(&1["message_id"] == id)) end) do
      %{
        "agent_group_id" => group_id,
        "conversation_id" => conversation_id,
        "participant_id" => participant_id,
        "response_identity" => response_identity(agent_id, session_id, activation_key),
        "source_message_ids" => source_ids,
        "source_messages" =>
          Enum.zip_with(source_ids, message_ids, fn source, message ->
            %{"source_message_id" => source, "message_id" => message}
          end)
      }
    else
      _unproven -> nil
    end
  end

  def derive(_agent_id, _session_id, _key, _source_ids, _origins, _kinds), do: nil

  defp decode_sources(source_ids) do
    decoded =
      Enum.map(source_ids, fn
        "groupconv:" <> rest when is_binary(rest) ->
          case String.split(rest, ":") do
            [conversation, message, participant | _suffix]
            when conversation != "" and message != "" and participant != "" ->
              {conversation, message, participant}

            _other ->
              :error
          end

        _other ->
          :error
      end)

    case Enum.uniq_by(decoded, fn
           {conversation, _message, participant} -> {conversation, participant}
           :error -> :error
         end) do
      [{conversation, _message, participant}] ->
        {:ok, conversation, participant, Enum.map(decoded, &elem(&1, 1))}

      _mixed_or_invalid ->
        :error
    end
  end

  defp common_group(origins, conversation_id, participant_id, kinds) do
    groups =
      Enum.map(origins, fn
        %{
          "provider" => "internal",
          "conversation_kind" => kind,
          "conversation_id" => ^conversation_id,
          "participant_id" => ^participant_id,
          "agent_group_id" => group
        }
        when is_binary(group) and group != "" ->
          if kind in kinds, do: group, else: :error

        _other ->
          :error
      end)

    case Enum.uniq(groups) do
      [group] when is_binary(group) -> {:ok, group}
      _mixed_or_invalid -> :error
    end
  end

  # The wire shape of every response identity: "rsp_" and 18 bytes, base64url.
  defp response_identity(agent_id, session_id, activation_key) do
    digest =
      :crypto.hash(
        :sha256,
        :erlang.term_to_binary({:activity_scope_v1, agent_id, session_id, activation_key}, [
          :deterministic
        ])
      )

    "rsp_" <> Base.url_encode64(binary_part(digest, 0, 18), padding: false)
  end
end
