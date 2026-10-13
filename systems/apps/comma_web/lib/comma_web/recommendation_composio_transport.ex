defmodule CommaWeb.RecommendationComposioTransport do
  @moduledoc false

  alias SalixStore.ComposioAccess, as: Access
  alias Salix.Control.ComposioConnect, as: Connect
  alias CommaWeb.RecommendationMemberRead, as: Read

  @toolkits ~w(gmail googlecalendar googledrive slack)

  def supported?(toolkit), do: toolkit in @toolkits

  # This is the member's configuration binding, not an MCP transport session.
  # Session recovery must not revoke consent; a new login or project key must.
  def authorization(profile),
    do: Map.take(profile, ~w(mode connection_id authorization_revision))

  def current?(workspace, user, source) do
    match?({:ok, _}, local_account(workspace, user, source))
  end

  defp local_account(w, user, source) do
    with true <- w["owner_user_id"] == user and is_binary(user),
         {:ok, %{"status" => "connected"} = profile} <-
           Access.profile(w["salix_tenant_id"], w["default_group_id"], user),
         true <- authorization(profile) == source["composioAuthorization"],
         {:ok, account} <-
           Access.account(
             w["salix_tenant_id"],
             w["default_group_id"],
             user,
             source["connectionId"]
           ),
         true <-
           account["enabled"] == true and account["status"] == "ACTIVE" and
             account["mode"] == profile["mode"] and account["toolkit"] == source["toolkit"] and
             supported?(account["toolkit"]) do
      {:ok, account}
    else
      _ -> {:error, :member_identity_or_source_unavailable}
    end
  end

  def with_reader(w, user, source, deadline, authorize, read) do
    with {:ok, account} <- local_account(w, user, source) do
      case account["mode"] do
        "connect" ->
          read.(fn method, endpoint, opts ->
            Read.request(deadline, fn ->
              with :ok <- authorize.(),
                   {:ok, _} <- local_account(w, user, source),
                   {:ok, slug, arguments, thread} <-
                     recipe(account["toolkit"], method, URI.parse(endpoint)),
                   {:ok, envelope} <-
                     Connect.execute_routine_read(
                       w["salix_tenant_id"],
                       w["default_group_id"],
                       user,
                       account,
                       %{"tool_slug" => slug, "arguments" => arguments},
                       fn ->
                         with :ok <- authorize.(),
                              {:ok, _} <- local_account(w, user, source),
                              do: :ok
                       end,
                       Keyword.get(opts, :max_bytes, 512_000)
                     ),
                   {:ok, data} <- action_data(envelope, slug),
                   true <-
                     byte_size(Jason.encode!(data)) <= Keyword.get(opts, :max_bytes, 512_000) do
                if thread && data["nextPageToken"] not in [nil, ""],
                  do: {:error, :member_source_context_unavailable},
                  else: normalize_action_data(slug, data, thread)
              else
                false -> {:error, :response_too_large}
                {:error, _} = error -> error
                _ -> {:error, :invalid_provider_response}
              end
            end)
          end)

        "project" ->
          project_reader(w, user, source, account, deadline, authorize, read)
      end
    end
  end

  defp project_reader(w, user, source, account, deadline, authorize, read) do
    client = Application.get_env(:salix_web, :composio_client_mod, SalixStore.Composio)
    tenant = w["salix_tenant_id"]
    group = w["default_group_id"]
    remote_user = "comma:" <> group <> ":" <> user

    with {:ok, settings} <- Access.project_settings(tenant, group, user),
         {:ok, remote} <-
           Read.request(deadline, fn -> client.get_connected_account(settings, account["id"]) end),
         true <-
           remote["id"] == account["id"] and remote["user_id"] == remote_user and
             remote["status"] == "ACTIVE" and
             get_in(remote, ["toolkit", "slug"]) == account["toolkit"],
         {:ok, session} <-
           Read.request(deadline, fn ->
             client.create_proxy_session(settings, remote_user, account["id"], account["toolkit"],
               error_mode: :structured
             )
           end) do
      try do
        read.(fn method, endpoint, opts ->
          Read.request(deadline, fn ->
            with :ok <- authorize.(),
                 {:ok, _} <- local_account(w, user, source),
                 {:ok, _, _, _} <- recipe(account["toolkit"], method, URI.parse(endpoint)),
                 {:ok, %{"status" => 200, "data" => data}} when is_map(data) <-
                   client.proxy_execute(
                     settings,
                     session,
                     %{
                       "toolkit_slug" => account["toolkit"],
                       "method" => method,
                       "endpoint" => endpoint
                     },
                     error_mode: :structured,
                     max_response_bytes: Keyword.get(opts, :max_bytes, 512_000)
                   ) do
              {:ok, data}
            else
              {:ok, %{"status" => status}} -> {:error, {:member_provider_http, status}}
              {:error, _} = error -> error
              _ -> {:error, :invalid_provider_response}
            end
          end)
        end)
      after
        Task.start(fn -> client.delete_proxy_session(settings, session) end)
      end
    else
      {:error, _} = error -> error
      _ -> {:error, :member_identity_or_source_unavailable}
    end
  end

  # Only these official read actions can cross Connect. The inputs come from
  # the incumbent readers, never from an Agent, renderer, or provider guidance.
  # Schemas: https://docs.composio.dev/toolkits/{gmail,googledrive,googlecalendar,slack}
  defp recipe("gmail", "GET", %URI{host: "gmail.googleapis.com", path: path} = uri) do
    q = URI.decode_query(uri.query || "")

    case path do
      "/gmail/v1/users/me/profile" ->
        {:ok, "GMAIL_GET_PROFILE", %{"user_id" => "me"}, nil}

      "/gmail/v1/users/me/threads" ->
        {:ok, "GMAIL_LIST_THREADS",
         %{"user_id" => "me", "query" => q["q"], "max_results" => 15, "verbose" => false}, nil}

      "/gmail/v1/users/me/threads/" <> id ->
        if Regex.match?(~r/^[A-Za-z0-9_-]+$/, id),
          do:
            {:ok, "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", %{"user_id" => "me", "thread_id" => id}, id},
          else: {:error, :member_source_unsupported}

      _ ->
        {:error, :member_source_unsupported}
    end
  end

  defp recipe("googlecalendar", "GET", %URI{host: "www.googleapis.com", path: path} = uri) do
    q = typed_query(uri)

    case path do
      "/calendar/v3/calendars/primary" ->
        {:ok, "GOOGLECALENDAR_GET_CALENDAR", %{"calendar_id" => "primary"}, nil}

      "/calendar/v3/calendars/primary/events" ->
        {:ok, "GOOGLECALENDAR_EVENTS_LIST", Map.put(q, "calendarId", "primary"), nil}

      _ ->
        {:error, :member_source_unsupported}
    end
  end

  defp recipe("googledrive", "GET", %URI{host: "www.googleapis.com", path: path} = uri) do
    q = typed_query(uri)

    case path do
      "/drive/v3/about" ->
        {:ok, "GOOGLEDRIVE_GET_ABOUT", %{"fields" => "user"}, nil}

      "/drive/v3/files" ->
        {:ok, "GOOGLEDRIVE_FIND_FILE", Map.put(q, "corpora", "user"), nil}

      "/drive/v3/files/" <> rest ->
        case String.split(rest, "/") do
          [id, "comments"] when id != "" ->
            {:ok, "GOOGLEDRIVE_LIST_COMMENTS", Map.put(q, "fileId", URI.decode(id)), nil}

          _ ->
            {:error, :member_source_unsupported}
        end

      _ ->
        {:error, :member_source_unsupported}
    end
  end

  defp recipe("slack", "GET", %URI{host: "slack.com", path: path} = uri) do
    case path do
      "/api/auth.test" ->
        {:ok, "SLACK_TEST_AUTH", %{}, nil}

      "/api/search.messages" ->
        {:ok, "SLACK_SEARCH_MESSAGES", Map.put(typed_query(uri), "auto_paginate", false), nil}

      _ ->
        {:error, :member_source_unsupported}
    end
  end

  defp recipe(_, _, _), do: {:error, :member_source_unsupported}

  defp typed_query(uri) do
    Map.new(URI.decode_query(uri.query || ""), fn {key, value} ->
      {key,
       cond do
         key in ~w(maxResults pageSize count page) -> String.to_integer(value)
         key in ~w(singleEvents showDeleted highlight) -> value == "true"
         true -> value
       end}
    end)
  end

  defp action_data(
         %{"data" => %{"results" => [%{"tool_slug" => slug, "response" => response}]}},
         slug
       ),
       do: action_data(response, slug)

  defp action_data(%{"successful" => true, "data" => %{"data" => data}}, _slug) when is_map(data),
    do: {:ok, data}

  defp action_data(%{"successful" => true, "data" => data}, _slug) when is_map(data),
    do: {:ok, data}

  defp action_data(_, _), do: {:error, :member_provider_failed}

  # Connect's Gmail action returns Composio message fields, not native Gmail
  # messages. Project/native readers keep their existing provider contract.
  defp normalize_action_data("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", data, thread) do
    with true <- data["threadId"] in [nil, thread],
         messages when is_list(messages) <- data["messages"] do
      Enum.reduce_while(messages, {:ok, []}, fn message, {:ok, acc} ->
        case gmail_message(message, thread) do
          {:ok, normalized} -> {:cont, {:ok, [normalized | acc]}}
          error -> {:halt, error}
        end
      end)
      |> case do
        {:ok, messages} ->
          {:ok, data |> Map.put("id", thread) |> Map.put("messages", Enum.reverse(messages))}

        error ->
          error
      end
    else
      _ -> {:error, :member_source_context_unavailable}
    end
  end

  defp normalize_action_data(_slug, data, _thread), do: {:ok, data}

  defp gmail_message(%{"messageId" => id} = message, thread) do
    # Composio's Gmail example uses timezone-qualified ISO-8601 in
    # https://composio.dev/content/ship-gmail-integration-in-minutes.
    # Do not infer epoch units or a timezone from an ambiguous string.
    with true <- message["threadId"] == thread,
         timestamp when is_binary(timestamp) <- message["messageTimestamp"],
         {:ok, at, _offset} <- DateTime.from_iso8601(timestamp),
         text when is_binary(text) <- message["messageText"],
         true <- String.trim(text) != "" do
      {:ok,
       %{
         "id" => id,
         "threadId" => thread,
         "internalDate" => at |> DateTime.to_unix(:millisecond) |> Integer.to_string(),
         "labelIds" => message["labelIds"],
         "payload" => %{
           "mimeType" => "text/plain",
           "headers" =>
             for(
               {name, key} <- [{"Subject", "subject"}, {"From", "sender"}, {"To", "to"}],
               do: %{"name" => name, "value" => message[key]}
             ),
           "body" => %{"data" => Base.url_encode64(text, padding: false)}
         }
       }}
    else
      _ -> {:error, :member_source_context_unavailable}
    end
  end

  defp gmail_message(%{"id" => _, "internalDate" => _} = message, _thread), do: {:ok, message}
  defp gmail_message(_message, _thread), do: {:error, :member_source_context_unavailable}
end
