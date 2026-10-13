defmodule SalixStore.ComposioAccess do
  @moduledoc """
  Personal Composio settings and exact-account access relationships. Credentials
  stay in OAuth's encrypted connection record. These records do not register a
  group MCP server or imply that a connected account grants Agent access.
  """
  alias SalixStore.{S3, CredentialCipher}

  def profile(tenant, group, user) do
    case read(profile_key(tenant, group, user)) do
      {:ok, value, _} ->
        {:ok, value}

      {:error, :not_found} ->
        {:ok,
         %{
           "tenant_id" => tenant,
           "group_id" => group,
           "user_id" => user,
           "mode" => "connect",
           "status" => "signed_out",
           "revision" => 0
         }}

      error ->
        error
    end
  end

  def update_profile(tenant, group, user, fun) do
    update(profile_key(tenant, group, user), fn current ->
      with {:ok, value} <-
             fun.(
               current ||
                 %{
                   "tenant_id" => tenant,
                   "group_id" => group,
                   "user_id" => user,
                   "mode" => "connect",
                   "status" => "signed_out",
                   "revision" => 0
                 }
             ) do
        {:ok, Map.put(value, "revision", ((current || %{})["revision"] || 0) + 1)}
      end
    end)
  end

  def begin_authorization(tenant, group, user, state, expires_at) do
    update_profile(tenant, group, user, fn profile ->
      {:ok,
       profile
       |> Map.put("mode", "connect")
       |> Map.put("status", "pending")
       |> Map.put("attempt", %{"state" => state, "expires_at" => expires_at})}
    end)
  end

  def current_attempt(auth) do
    with {:ok, profile} <- profile(auth["tenant"], auth["group_id"], auth["composio_user_id"]),
         %{"state" => state, "expires_at" => expiry} <- profile["attempt"],
         true <- state == auth["state"] and expiry > System.system_time(:millisecond) do
      :ok
    else
      _ -> {:error, {auth, "Composio authorization expired or cancelled"}}
    end
  end

  def complete(auth, connection_id) do
    update_profile(auth["tenant"], auth["group_id"], auth["composio_user_id"], fn profile ->
      case profile["attempt"] do
        %{"state" => state, "expires_at" => expiry} ->
          if state == auth["state"] and expiry > System.system_time(:millisecond) do
            {:ok,
             profile
             |> Map.delete("attempt")
             |> Map.put("status", "connected")
             |> Map.put("connection_id", connection_id)
             |> Map.delete("mcp_session_headers")}
          else
            {:error, :expired}
          end

        _ ->
          {:error, :cancelled}
      end
    end)
  end

  def fail_authorization(auth) do
    update_profile(auth["tenant"], auth["group_id"], auth["composio_user_id"], fn profile ->
      if get_in(profile, ["attempt", "state"]) == auth["state"],
        do:
          {:ok, profile |> Map.delete("attempt") |> Map.put("status", "reauthorization_required")},
        else: {:error, :stale_attempt}
    end)
  end

  def cancel(tenant, group, user) do
    update_profile(tenant, group, user, fn profile ->
      {:ok,
       profile
       |> Map.delete("attempt")
       |> Map.put("status", if(profile["connection_id"], do: "connected", else: "signed_out"))}
    end)
  end

  def put_project_settings(tenant, group, user, settings) do
    with {:ok, sealed} <-
           CredentialCipher.seal(tenant, profile_key(tenant, group, user), settings) do
      update_profile(tenant, group, user, fn profile ->
        {:ok,
         profile
         |> Map.put("project_configuration", sealed)
         |> Map.put("mode", "project")
         |> Map.put("status", "connected")
         |> Map.delete("attempt")}
      end)
    end
  end

  def project_settings(tenant, group, user) do
    with {:ok, %{"mode" => "project", "project_configuration" => sealed}} <-
           profile(tenant, group, user),
         {:ok, settings} <-
           CredentialCipher.open(tenant, profile_key(tenant, group, user), sealed) do
      {:ok, settings}
    else
      _ -> {:error, :composio_project_not_configured}
    end
  end

  def registration(tenant, provider_key) do
    key = registration_key(tenant, provider_key)

    with {:ok, %{"sealed" => sealed}, _} <- read(key),
         do: CredentialCipher.open(tenant, key, sealed)
  end

  def put_registration(tenant, provider_key, record) do
    key = registration_key(tenant, provider_key)

    with {:ok, sealed} <- CredentialCipher.seal(tenant, key, record),
         {:ok, _} <- update(key, fn _ -> {:ok, %{"sealed" => sealed}} end),
         do: {:ok, record}
  end

  def account(tenant, group, user, id) do
    case read(account_key(tenant, group, user, id)) do
      {:ok, record, _} -> {:ok, record}
      error -> error
    end
  end

  def put_account(tenant, group, user, id, account) do
    update(account_key(tenant, group, user, id), fn current ->
      {:ok,
       Map.merge(
         current || %{"enabled" => true},
         Map.take(account, ~w(id toolkit name status mode))
       )
       |> Map.put("id", id)
       |> Map.put("user_id", user)}
    end)
  end

  def begin_account(tenant, group, user, id, url, replaces \\ nil) do
    with {:ok, sealed} <-
           CredentialCipher.seal(tenant, account_key(tenant, group, user, id), %{"url" => url}) do
      update(account_key(tenant, group, user, id), fn
        nil ->
          {:error, :not_found}

        account ->
          {:ok,
           account
           |> Map.put("authorization", sealed)
           |> Map.put("replaces", replaces)
           |> Map.put("authorization_expires_at", System.system_time(:millisecond) + 600_000)}
      end)
    end
  end

  def begin_consent(tenant, group, user, toolkit, replaces \\ nil) do
    key = consent_key(tenant, group, user, toolkit)
    id = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)

    new_record = fn ->
      %{
        "id" => id,
        "toolkit" => toolkit,
        "status" => "starting",
        "expires_at" => System.system_time(:millisecond) + 600_000,
        "replaces" => replaces
      }
    end

    update(key, fn
      nil ->
        {:ok, new_record.()}

      %{"status" => status, "expires_at" => expiry}
      when status in ["starting", "pending"] and is_integer(expiry) ->
        if expiry > System.system_time(:millisecond),
          do: {:error, :composio_consent_pending},
          else: {:ok, new_record.()}

      %{"status" => status} when status in ["starting", "pending"] ->
        {:error, :invalid_composio_consent}

      %{"status" => "selecting"} ->
        {:error, :composio_consent_pending}

      %{"status" => status} when status in ["cancelled", "completed"] ->
        {:ok, new_record.()}

      _ ->
        {:error, :invalid_composio_consent}
    end)
  end

  def consent(tenant, group, user, toolkit) do
    case read(consent_key(tenant, group, user, toolkit)) do
      {:ok, record, _} -> {:ok, record}
      error -> error
    end
  end

  def finish_consent(tenant, group, user, toolkit, attempt_id, authorization_url)
      when is_binary(attempt_id) and is_binary(authorization_url) do
    key = consent_key(tenant, group, user, toolkit)
    cipher_context = consent_cipher_context(key, attempt_id)

    with {:ok, sealed} <-
           CredentialCipher.seal(tenant, cipher_context, %{
             "authorization_url" => authorization_url
           }) do
      update(key, fn
        %{"id" => ^attempt_id, "status" => "starting", "expires_at" => expiry} = record
        when is_integer(expiry) ->
          if expiry > System.system_time(:millisecond) do
            {:ok, record |> Map.put("status", "pending") |> Map.put("authorization", sealed)}
          else
            {:error, :composio_attempt_not_pending}
          end

        _ ->
          {:error, :composio_attempt_not_pending}
      end)
    end
  end

  def finish_consent(_, _, _, _, _, _), do: {:error, :composio_attempt_not_pending}

  def consent_authorization(tenant, group, user, toolkit, attempt_id)
      when is_binary(attempt_id) do
    key = consent_key(tenant, group, user, toolkit)

    with {:ok,
          %{
            "id" => ^attempt_id,
            "status" => "pending",
            "expires_at" => expiry,
            "authorization" => sealed
          }} <- consent(tenant, group, user, toolkit),
         true <- is_integer(expiry) and expiry > System.system_time(:millisecond),
         {:ok, %{"authorization_url" => url}} <-
           CredentialCipher.open(tenant, consent_cipher_context(key, attempt_id), sealed) do
      {:ok, %{"authorization_url" => url, "consent_id" => attempt_id}}
    else
      {:error, :not_found} -> {:error, :composio_attempt_not_pending}
      {:error, _} = error -> error
      _ -> {:error, :composio_attempt_not_pending}
    end
  end

  def consent_authorization(_, _, _, _, _), do: {:error, :composio_attempt_not_pending}

  def cancel_consent(tenant, group, user, toolkit, attempt_id) when is_binary(attempt_id) do
    update(consent_key(tenant, group, user, toolkit), fn
      %{"id" => ^attempt_id, "status" => status} = record
      when status in ["starting", "pending"] ->
        {:ok, record |> Map.delete("authorization") |> Map.put("status", "cancelled")}

      _ ->
        {:error, :composio_attempt_not_pending}
    end)
  end

  def cancel_consent(_, _, _, _, _), do: {:error, :composio_attempt_not_pending}

  def complete_consent(tenant, group, user, toolkit, attempt_id, account_id)
      when is_binary(attempt_id) and is_binary(account_id) and byte_size(account_id) > 0 do
    update(consent_key(tenant, group, user, toolkit), fn
      %{
        "id" => ^attempt_id,
        "status" => "pending",
        "expires_at" => expiry
      } = record
      when is_integer(expiry) ->
        if expiry > System.system_time(:millisecond) do
          {:ok,
           record |> Map.put("status", "selecting") |> Map.put("selected_account_id", account_id)}
        else
          {:error, :composio_attempt_not_pending}
        end

      %{
        "id" => ^attempt_id,
        "status" => "selecting",
        "selected_account_id" => ^account_id
      } ->
        {:error, :composio_consent_in_progress}

      %{
        "id" => ^attempt_id,
        "status" => status,
        "selected_account_id" => ^account_id
      } = record
      when status == "completed" ->
        {:ok, record}

      _ ->
        {:error, :composio_attempt_not_pending}
    end)
  end

  def complete_consent(_, _, _, _, _, _), do: {:error, :composio_attempt_not_pending}

  def settle_consent(tenant, group, user, toolkit, attempt_id, account_id)
      when is_binary(attempt_id) and is_binary(account_id) and byte_size(account_id) > 0 do
    update(consent_key(tenant, group, user, toolkit), fn
      %{
        "id" => ^attempt_id,
        "status" => "selecting",
        "selected_account_id" => ^account_id
      } = record ->
        {:ok, Map.put(record, "status", "completed")}

      %{
        "id" => ^attempt_id,
        "status" => "completed",
        "selected_account_id" => ^account_id
      } = record ->
        {:ok, record}

      _ ->
        {:error, :composio_attempt_not_pending}
    end)
  end

  def settle_consent(_, _, _, _, _, _), do: {:error, :composio_attempt_not_pending}

  def account_authorization(tenant, group, user, id) do
    with {:ok, account} <- account(tenant, group, user, id),
         true <-
           account["status"] == "INITIATED" and
             account["authorization_expires_at"] > System.system_time(:millisecond),
         {:ok, %{"url" => url}} <-
           CredentialCipher.open(
             tenant,
             account_key(tenant, group, user, id),
             account["authorization"]
           ) do
      {:ok, %{"authorization_url" => url, "account_id" => id}}
    else
      _ -> {:error, :composio_authorization_expired}
    end
  end

  def update_account_name(tenant, group, user, id, %{
        "toolkit" => toolkit,
        "mode" => mode,
        "name" => name
      })
      when is_binary(name) do
    update(account_key(tenant, group, user, id), fn
      nil ->
        {:error, :not_found}

      %{"toolkit" => ^toolkit, "mode" => ^mode} = account ->
        {:ok, Map.put(account, "name", name)}

      _ ->
        {:error, :composio_account_not_owned}
    end)
  end

  def enable_account(tenant, group, user, id, enabled) when is_boolean(enabled) do
    update(account_key(tenant, group, user, id), fn
      nil -> {:error, :not_found}
      account -> {:ok, Map.put(account, "enabled", enabled)}
    end)
  end

  def cancel_account(tenant, group, user, id) do
    update(account_key(tenant, group, user, id), fn
      %{"status" => "INITIATED"} = account -> {:ok, Map.put(account, "status", "CANCELLED")}
      _ -> {:error, :composio_attempt_not_pending}
    end)
  end

  def confirm_account(tenant, group, user, id, remote) do
    update(account_key(tenant, group, user, id), fn
      nil ->
        {:error, :not_found}

      account ->
        cond do
          account["status"] in ["CANCELLED", "DISCONNECTED"] ->
            {:error, :composio_authorization_cancelled}

          account["status"] == "INITIATED" and
              (not is_integer(account["authorization_expires_at"]) or
                 account["authorization_expires_at"] <= System.system_time(:millisecond)) ->
            {:error, :composio_authorization_expired}

          account["toolkit"] != remote["toolkit"] or account["mode"] != remote["mode"] ->
            {:error, :composio_account_not_owned}

          true ->
            {:ok, Map.merge(account, Map.take(remote, ~w(name status)))}
        end
    end)
  end

  def accounts(tenant, group, user, cursor \\ nil) do
    page(account_prefix(tenant, group, user), cursor)
  end

  def grant(tenant, group, user, account, agent, tools)
      when is_list(tools) and length(tools) <= 50 do
    if Enum.all?(
         tools,
         &(is_binary(&1) and String.match?(&1, ~r/^[A-Z0-9_]{1,180}$/) and
             not String.starts_with?(&1, "COMPOSIO_"))
       ) do
      update(grant_key(tenant, group, agent, user, account), fn _ ->
        {:ok,
         %{
           "user_id" => user,
           "account_id" => account,
           "agent_id" => agent,
           "tools" => Enum.uniq(tools),
           "audience" => "group",
           "enabled" => tools != []
         }}
      end)
    else
      {:error, :invalid_tools}
    end
  end

  def grant(_, _, _, _, _, _), do: {:error, :invalid_tools}

  def grants(tenant, group, agent, cursor \\ nil),
    do: page(grant_prefix(tenant, group, agent), cursor)

  def agent_account_grant(tenant, group, agent, id) do
    case read(grant_key(tenant, group, agent, nil, id)) do
      {:ok, grant, _} -> {:ok, grant}
      error -> error
    end
  end

  def authorize(tenant, group, agent, user, id, tool) do
    with {:ok, account} <- account(tenant, group, user, id),
         true <- account["enabled"] == true and account["status"] == "ACTIVE",
         {:ok, grant, _} <- read(grant_key(tenant, group, agent, user, id)),
         true <-
           grant["user_id"] == user and grant["enabled"] == true and grant["audience"] == "group" and
             tool in grant["tools"] do
      {:ok, account}
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  defp profile_key(t, g, u), do: prefix(t, g) <> "members/" <> segment(u) <> "/settings.json"
  defp account_prefix(t, g, u), do: prefix(t, g) <> "members/" <> segment(u) <> "/accounts/"
  defp account_key(t, g, u, id), do: account_prefix(t, g, u) <> segment(id) <> ".json"

  defp consent_key(t, g, u, toolkit),
    do: prefix(t, g) <> "members/" <> segment(u) <> "/consents/" <> segment(toolkit) <> ".json"

  defp consent_cipher_context(key, attempt_id), do: key <> ":" <> attempt_id

  defp registration_key(t, p),
    do: "ctl/tenants/" <> segment(t) <> "/composio/registrations/" <> segment(p) <> ".json"

  defp grant_prefix(t, g, a), do: prefix(t, g) <> "agents/" <> segment(a) <> "/grants/"
  defp grant_key(t, g, a, _u, id), do: grant_prefix(t, g, a) <> segment(id) <> ".json"
  defp prefix(t, g), do: "ctl/tenants/" <> segment(t) <> "/composio/groups/" <> segment(g) <> "/"
  defp segment(value), do: Base.url_encode64(value, padding: false)

  defp page(prefix, cursor)
       when is_nil(cursor) or (is_binary(cursor) and byte_size(cursor) <= 4096) do
    with {:ok, %{objects: objects, next: next}} <-
           S3.list(prefix, max_keys: 50, continuation_token: cursor) do
      Enum.reduce_while(objects, {:ok, []}, fn object, {:ok, records} ->
        case read(object.key) do
          {:ok, value, _} -> {:cont, {:ok, [value | records]}}
          error -> {:halt, error}
        end
      end)
      |> case do
        {:ok, records} -> {:ok, %{"items" => Enum.reverse(records), "next_cursor" => next}}
        error -> error
      end
    end
  end

  defp page(_, _), do: {:error, :invalid_cursor}

  defp read(key) do
    with {:ok, %{body: body, etag: etag}} <- S3.get(key),
         {:ok, value} when is_map(value) <- Jason.decode(body) do
      {:ok, value, etag}
    else
      {:error, _} = error -> error
      _ -> {:error, :invalid_composio_record}
    end
  end

  defp update(key, fun, attempts \\ 5)
  defp update(_, _, 0), do: {:error, :conflict}

  defp update(key, fun, attempts) do
    current =
      case read(key) do
        {:ok, value, etag} -> {:ok, value, [if_match: etag]}
        {:error, :not_found} -> {:ok, nil, [if_none_match: "*"]}
        error -> error
      end

    with {:ok, value, opts} <- current,
         {:ok, updated} <- fun.(value) do
      case S3.put(key, Jason.encode!(updated), opts) do
        {:ok, _} -> {:ok, updated}
        {:error, :precondition_failed} -> update(key, fun, attempts - 1)
        error -> error
      end
    end
  end
end
