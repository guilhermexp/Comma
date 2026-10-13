defmodule CommaWeb.RecommendationSources do
  @moduledoc false

  alias CommaWeb.RecommendationSourceCatalog

  def discover(workspace), do: discover(workspace, nil, "generic", [])

  def discover(workspace, user_id, mode), do: discover(workspace, user_id, mode, [])

  def discover(
        %{"salix_tenant_id" => tenant_id, "default_group_id" => group_id} = workspace,
        user_id,
        mode,
        existing_sources
      )
      when mode in ~w(generic member) and is_list(existing_sources) do
    with :ok <- member_scope(workspace, user_id, mode),
         native = discover_oauth(tenant_id, group_id),
         {:ok, composio} <- discover_composio(workspace, user_id, mode, existing_sources, native),
         {:ok, personal} <- discover_personal(workspace, user_id) do
      {:ok,
       (native ++ personal ++ composio)
       |> Enum.uniq_by(& &1["connectionId"])
       |> Enum.sort_by(&{&1["appName"], &1["label"], &1["connectionId"]})
       |> Enum.take(12)}
    end
  end

  defp discover_personal(_workspace, nil), do: {:ok, []}

  defp discover_personal(workspace, user) do
    alias SalixStore.ComposioAccess, as: Access
    alias CommaWeb.RecommendationComposioTransport, as: Transport
    tenant = workspace["salix_tenant_id"]
    group = workspace["default_group_id"]

    with true <- workspace["owner_user_id"] == user,
         {:ok, profile} <- Access.profile(tenant, group, user),
         {:ok, page} <- Access.accounts(tenant, group, user) do
      accounts =
        Enum.filter(page["items"], fn account ->
          profile["status"] == "connected" and account["mode"] == profile["mode"] and
            account["status"] == "ACTIVE" and account["enabled"] == true and
            Transport.supported?(account["toolkit"])
        end)

      {:ok,
       Enum.map(accounts, fn account ->
         # Include the opaque reference even when names match; never choose a
         # duplicate by date, email, or an inferred callback ID.
         source("composio", account["toolkit"], account["id"], personal_label(account), %{
           "toolkit" => account["toolkit"],
           "composioMode" => profile["mode"],
           "composioAuthorization" => Transport.authorization(profile)
         })
       end)}
    else
      false -> {:error, :forbidden}
      {:error, reason} -> {:error, {:composio_source_discovery_failed, reason}}
    end
  end

  defp personal_label(account) do
    name = account["name"] || account["toolkit"]
    suffix = " (" <> account["id"] <> ")"

    identity =
      if String.ends_with?(name, suffix), do: String.replace_suffix(name, suffix, ""), else: name

    identity = if String.trim(identity) == "", do: account["toolkit"], else: identity
    available = 120 - utf16_units(suffix)

    # The client bounds label in JavaScript UTF-16 units. Keep the exact
    # reference intact, or leave it in connectionId for Settings to append.
    # Never slice the composed suffix or split an identity's grapheme.
    if available > utf16_units(String.first(identity) || "") do
      bounded_label(identity, available) <> suffix
    else
      bounded_label(identity, 120)
    end
  end

  defp bounded_label(value, limit) do
    if utf16_units(value) <= limit do
      value
    else
      {parts, _} =
        value
        |> String.graphemes()
        |> Enum.reduce_while({[], 0}, fn part, {parts, used} ->
          size = utf16_units(part)

          if used + size <= limit - 1,
            do: {:cont, {[part | parts], used + size}},
            else: {:halt, {parts, used}}
        end)

      (parts |> Enum.reverse() |> IO.iodata_to_binary()) <> "…"
    end
  end

  defp utf16_units(value),
    do: div(byte_size(:unicode.characters_to_binary(value, :utf8, {:utf16, :big})), 2)

  defp member_scope(_, _, "generic"), do: :ok

  defp member_scope(%{"owner_user_id" => user_id}, user_id, "member")
       when is_binary(user_id),
       do: :ok

  defp member_scope(_, _, "member"), do: {:error, :forbidden}

  defp discover_oauth(_tenant_id, group_id) do
    group_id
    |> Salix.Control.OAuthBindings.list()
    |> Enum.filter(fn binding ->
      binding["provider"] in ~w(github linear notion slack) and
        binding["alias"] == binding["provider"] and binding["status"] == "active" and
        binding["enabled"] != false
    end)
    |> Enum.map(fn binding ->
      source(
        "managed_oauth",
        binding["provider"],
        binding["binding_id"],
        if(present?(binding["provider_account_name"]),
          do: binding["provider_account_name"],
          else: RecommendationSourceCatalog.app_name(binding["provider"])
        ),
        %{"toolkit" => binding["provider"]}
      )
    end)
  end

  defp discover_composio(
         %{"salix_tenant_id" => tenant_id, "default_group_id" => group_id} = workspace,
         user_id,
         mode,
         existing_sources,
         native
       ) do
    case Salix.Composio.list_all_group_connected_accounts(tenant_id, group_id) do
      {:ok, accounts} when is_list(accounts) ->
        bindings =
          if mode == "member",
            do: legacy_bindings(workspace, user_id),
            else: %{}

        bindings =
          if Enum.any?(native, &(&1["appId"] == "slack")),
            do: Map.delete(bindings, "slack"),
            else: bindings

        {:ok,
         accounts
         |> Enum.filter(&(&1["user_id"] == group_id))
         |> Enum.flat_map(&usable_composio_account/1)
         |> Enum.reject(fn account ->
           account.toolkit == "slack" and Enum.any?(native, &(&1["appId"] == "slack"))
         end)
         |> selected_accounts(bindings, mode)
         |> Enum.map(&composio_source/1)}

      {:error, :not_configured} when mode == "member" ->
        if existing_composio_choice?(workspace, user_id, existing_sources, native),
          do: {:error, {:composio_source_discovery_failed, :not_configured}},
          else: {:ok, []}

      {:error, :not_configured} ->
        {:ok, []}

      {:error, reason} ->
        {:error, {:composio_source_discovery_failed, reason}}

      other ->
        {:error, {:composio_source_discovery_failed, other}}
    end
  end

  defp existing_composio_choice?(workspace, user_id, sources, native) do
    slack_managed? = Enum.any?(native, &(&1["appId"] == "slack"))
    bindings = legacy_bindings(workspace, user_id)
    bindings = if slack_managed?, do: Map.delete(bindings, "slack"), else: bindings

    Enum.any?(sources, fn source ->
      source["kind"] == "composio" and is_nil(source["composioMode"]) and
        not (slack_managed? and source["appId"] == "slack")
    end) or map_size(bindings) > 0
  end

  defp legacy_bindings(workspace, user_id) do
    Comma.MemberSourceConsents.bindings(workspace["id"], user_id)
    |> Map.reject(fn {_toolkit, id} ->
      match?(
        {:ok, _},
        SalixStore.ComposioAccess.account(
          workspace["salix_tenant_id"],
          workspace["default_group_id"],
          user_id,
          id
        )
      )
    end)
  end

  defp selected_accounts(accounts, _bindings, "generic"),
    do: newest_account_per_toolkit(accounts)

  defp selected_accounts(accounts, bindings, "member") do
    candidates = Map.new(newest_account_per_toolkit(accounts), &{&1.toolkit, &1})

    bindings
    |> Enum.reduce(candidates, fn {toolkit, id}, selected ->
      case Enum.find(accounts, &(&1.toolkit == toolkit and &1.id == id)) do
        nil -> Map.put(selected, toolkit, %{toolkit: toolkit, id: id})
        account -> Map.put(selected, toolkit, account)
      end
    end)
    |> Map.values()
  end

  defp usable_composio_account(account) when is_map(account) do
    status = clean(account["status"]) |> String.downcase()

    toolkit =
      clean(get_in(account, ["toolkit", "slug"]) || account["toolkit_slug"] || account["toolkit"])
      |> String.downcase()

    id = clean(account["id"] || account["connected_account_id"])

    if status in ["active", "connected", "ready"] and present?(toolkit) and present?(id) and
         RecommendationSourceCatalog.supported_composio_toolkit?(toolkit) and
         toolkit not in ~w(github linear notion),
       do: [%{toolkit: toolkit, id: id, connected_at: connected_at(account)}],
       else: []
  end

  defp usable_composio_account(_account), do: []

  # Composio can retain several active accounts after reauthorization. Select
  # the newest per toolkit to avoid duplicate facts. Without timestamps, the
  # first listed account wins. Native OAuth sources use Group bindings above.
  defp newest_account_per_toolkit(accounts) do
    accounts
    |> Enum.with_index()
    |> Enum.sort_by(fn {account, index} -> {-account.connected_at, index} end)
    |> Enum.map(&elem(&1, 0))
    |> Enum.uniq_by(& &1.toolkit)
  end

  defp connected_at(account) do
    [account["created_at"], account["updated_at"]]
    |> Enum.find_value(0, fn
      value when is_binary(value) ->
        case DateTime.from_iso8601(value) do
          {:ok, datetime, _offset} -> DateTime.to_unix(datetime, :millisecond)
          _ -> nil
        end

      _ ->
        nil
    end)
  end

  defp composio_source(%{toolkit: toolkit, id: id}),
    do: source("composio", toolkit, id, toolkit, %{"toolkit" => toolkit})

  defp source(kind, app, connection_id, label, private) do
    Map.merge(
      %{
        "appId" => app,
        "appName" => RecommendationSourceCatalog.app_name(app),
        "connectionId" => connection_id,
        "kind" => kind,
        "label" => label
      },
      private
    )
  end

  defp clean(nil), do: ""
  defp clean(value) when is_binary(value), do: String.trim(value)
  defp clean(value), do: value |> to_string() |> String.trim()
  defp present?(value), do: is_binary(value) and value != ""
end
