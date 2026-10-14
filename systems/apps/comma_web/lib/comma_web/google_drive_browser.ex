defmodule CommaWeb.GoogleDriveBrowser do
  @moduledoc false
  alias Comma.Workspaces
  alias SalixStore.ComposioAccess, as: Access
  alias Salix.Control.ComposioConnect, as: Connect
  alias CommaWeb.RecommendationComposioTransport, as: Transport
  alias CommaWeb.RecommendationMemberRead, as: Read

  @slug "GOOGLEDRIVE_FIND_FILE"
  @fields "files(id,name,mimeType,modifiedTime,viewedByMeTime,webViewLink,shortcutDetails,shared),nextPageToken,incompleteSearch"
  @max_bytes 256_000
  @sorts %{
    "recent" => "recency desc",
    "name" => "name_natural",
    "name_desc" => "name_natural desc",
    "modified" => "modifiedTime desc",
    "viewed" => "viewedByMeTime desc"
  }

  # Member-facing closed read: neither Agent consent nor Routine enrollment.
  def browse(user, session, workspace_id, params) do
    with {:ok, arguments} <- arguments(params),
         {:ok, workspace} <- Workspaces.authorize(user, session, workspace_id),
         {:ok, account, binding} <- current(workspace, user["id"], params["account_id"]) do
      authorize = fn ->
        with {:ok, fresh} <- Workspaces.authorize(user, session, workspace_id),
             true <-
               Map.take(fresh, ~w(salix_tenant_id default_group_id)) ==
                 Map.take(workspace, ~w(salix_tenant_id default_group_id)),
             {:ok, ^account, ^binding} <- current(fresh, user["id"], params["account_id"]) do
          :ok
        else
          _ -> {:error, :composio_access_denied}
        end
      end

      Read.within(Read.deadline(30_000), fn ->
        with :ok <- authorize.(),
             {:ok, envelope} <-
               Connect.execute_drive_read(
                 workspace["salix_tenant_id"],
                 workspace["default_group_id"],
                 user["id"],
                 account,
                 arguments,
                 authorize,
                 @max_bytes
               ),
             :ok <- authorize.(),
             {:ok, data} <- action_data(envelope),
             {:ok, page} <- page(data) do
          {:ok, page}
        end
      end)
    end
  end

  defp current(w, user, id) do
    with true <- is_binary(id) and byte_size(id) in 1..256,
         {:ok, %{"status" => "connected", "mode" => mode} = profile} <-
           Access.profile(w["salix_tenant_id"], w["default_group_id"], user),
         true <- mode in ~w(connect project),
         {:ok,
          %{"toolkit" => "googledrive", "enabled" => true, "status" => "ACTIVE", "mode" => ^mode} =
            account} <- Access.account(w["salix_tenant_id"], w["default_group_id"], user, id) do
      {:ok, account, Transport.authorization(profile)}
    else
      _ -> {:error, :composio_access_denied}
    end
  end

  defp arguments(%{"account_id" => id, "tab" => tab} = p)
       when is_binary(id) and tab in ~w(recent my_drive shared) do
    search = Map.get(p, "search", "")
    folder = p["folder_id"]
    cursor = p["cursor"]
    sort = Map.get(p, "sort", if(tab == "recent", do: "recent", else: "name"))

    if Enum.all?(Map.keys(p), &(&1 in ~w(account_id tab search folder_id cursor sort))) and
         byte_size(id) in 1..256 and is_binary(search) and byte_size(search) <= 512 and
         not String.contains?(search, <<0>>) and
         (is_nil(folder) or valid_id?(folder)) and
         (is_nil(cursor) or (is_binary(cursor) and byte_size(cursor) in 1..8192)) and
         Map.has_key?(@sorts, sort) do
      q = "trashed = false"
      q = if tab == "shared" and is_nil(folder), do: q <> " and sharedWithMe = true", else: q
      q = if search == "", do: q, else: q <> " and name contains '" <> escape(search) <> "'"

      args = %{
        "q" => q,
        "fields" => @fields,
        "orderBy" => @sorts[sort],
        "pageSize" => 50,
        "corpora" => "user",
        "supportsAllDrives" => true,
        "includeItemsFromAllDrives" => true
      }

      args =
        if folder || tab == "my_drive",
          do: Map.put(args, "folder_id", folder || "root"),
          else: args

      {:ok, if(cursor, do: Map.put(args, "pageToken", cursor), else: args)}
    else
      {:error, :invalid_composio_request}
    end
  end

  defp arguments(_), do: {:error, :invalid_composio_request}
  defp escape(value), do: value |> String.replace("\\", "\\\\") |> String.replace("'", "\\'")

  defp valid_id?(id),
    do: is_binary(id) and byte_size(id) in 1..256 and Regex.match?(~r/^[A-Za-z0-9_-]+$/, id)

  defp action_data(
         %{"data" => %{"results" => [%{"tool_slug" => @slug, "response" => response}]} = data} =
           envelope
       ) do
    if envelope["successful"] in [nil, true] and data["error_count"] in [nil, 0],
      do: action_data(response),
      else: {:error, :invalid_provider_response}
  end

  defp action_data(%{"successful" => true, "data" => %{"data" => data} = inner})
       when is_map(data) do
    if inner["successful"] in [nil, true],
      do: {:ok, data},
      else: {:error, :invalid_provider_response}
  end

  defp action_data(%{"successful" => true, "data" => data}) when is_map(data), do: {:ok, data}
  defp action_data(_), do: {:error, :invalid_provider_response}

  defp page(%{"files" => files} = data) when is_list(files) do
    cursor = data["nextPageToken"]

    if length(files) <= 50 and byte_size(Jason.encode!(data)) <= @max_bytes and
         data["incompleteSearch"] in [nil, true, false] and
         (is_nil(cursor) or (is_binary(cursor) and byte_size(cursor) in 1..8192)) do
      Enum.reduce_while(files, {:ok, []}, fn file, {:ok, acc} ->
        case project(file) do
          {:ok, row} -> {:cont, {:ok, [row | acc]}}
          error -> {:halt, error}
        end
      end)
      |> case do
        {:ok, rows} ->
          {:ok,
           %{
             "files" => Enum.reverse(rows),
             "next_cursor" => cursor,
             "incomplete" => data["incompleteSearch"] == true
           }}

        error ->
          error
      end
    else
      {:error, :invalid_provider_response}
    end
  end

  defp page(_), do: {:error, :invalid_provider_response}

  defp project(%{"id" => id, "name" => name, "mimeType" => mime} = f) do
    if valid_id?(id) and is_binary(name) and byte_size(name) in 1..4096 and is_binary(mime) and
         byte_size(mime) in 1..256 do
      shortcut =
        case f["shortcutDetails"] do
          %{"targetId" => target, "targetMimeType" => type} ->
            if valid_id?(target) and is_binary(type) and byte_size(type) <= 256,
              do: %{"id" => target, "mime_type" => type},
              else: nil

          _ ->
            nil
        end

      {:ok,
       %{
         "id" => id,
         "name" => name,
         "mime_type" => mime,
         "modified_at" => date(f["modifiedTime"]),
         "viewed_at" => date(f["viewedByMeTime"]),
         "url" => safe_url(f["webViewLink"]),
         "shared" => f["shared"] == true,
         "shortcut" => shortcut
       }}
    else
      {:error, :invalid_provider_response}
    end
  end

  defp project(_), do: {:error, :invalid_provider_response}

  defp date(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, date, _} -> DateTime.to_iso8601(date)
      _ -> nil
    end
  end

  defp date(_), do: nil

  defp safe_url(value) when is_binary(value) and byte_size(value) <= 2083 do
    uri = URI.parse(value)

    if uri.scheme == "https" and uri.host in ~w(drive.google.com docs.google.com) and
         is_nil(uri.userinfo) and uri.port == 443 and
         is_binary(uri.path) and
         Regex.match?(
           ~r{^/(?:file/d/|drive/(?:u/\d+/)?folders/|(?:document|spreadsheets|presentation|drawings|forms)/d/)[A-Za-z0-9_-]+(?:/|$)},
           uri.path
         ), do: value, else: nil
  end

  defp safe_url(_), do: nil
end
