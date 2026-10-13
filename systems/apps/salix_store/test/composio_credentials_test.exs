defmodule SalixStore.ComposioCredentialsTest do
  use ExUnit.Case, async: false
  alias SalixStore.{ComposioAccess, Keys, OAuth, S3}

  setup do
    previous = Application.get_env(:salix_agent, :subscription_storage_key)
    Application.put_env(:salix_agent, :subscription_storage_key, String.duplicate("k", 32))
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    unless Process.whereis(S3.Fake), do: start_supervised!(S3.Fake)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:salix_agent, :subscription_storage_key, previous),
        else: Application.delete_env(:salix_agent, :subscription_storage_key)
    end)

    :ok
  end

  test "Connect credentials remain encrypted through storage, refresh and disable" do
    id = "connect-credentials-#{System.unique_integer([:positive])}"

    record = %{
      "tenant" => "tenant-a",
      "credential_protection" => "composio_connect",
      "access_token" => "private-access-credential",
      "refresh_token" => "private-refresh-credential",
      "expires_at" => 0,
      "status" => "active"
    }

    assert :ok = OAuth.put(id, record)
    assert {:ok, %{body: body}} = S3.get(Keys.oauth_connection(id))
    refute body =~ "private-access-credential"
    refute body =~ "private-refresh-credential"
    assert {:ok, ^record} = OAuth.get(id)

    assert {:ok, "rotated-credential"} =
             OAuth.valid_token(
               id,
               fn actual ->
                 assert actual["refresh_token"] == "private-refresh-credential"
                 {:ok, %{"access_token" => "rotated-credential", "expires_at" => 999_999}}
               end,
               now: 1
             )

    assert {:ok, updated} = OAuth.update(id, &{:ok, Map.put(&1, "status", "disabled")})
    assert updated["status"] == "disabled"
    assert {:ok, %{body: rotated}} = S3.get(Keys.oauth_connection(id))
    refute rotated =~ "rotated-credential"
    refute rotated =~ "private-refresh-credential"
    assert {:ok, _} = S3.put(Keys.oauth_connection(id <> "-other"), rotated)
    assert {:error, _} = OAuth.get(id <> "-other")
  end

  test "missing encryption key fails closed before persisting a Connect credential" do
    Application.delete_env(:salix_agent, :subscription_storage_key)
    id = "missing-key-#{System.unique_integer([:positive])}"

    assert {:error, :not_configured} =
             OAuth.put(id, %{
               "tenant" => "tenant-a",
               "credential_protection" => "composio_connect",
               "access_token" => "never-persist"
             })

    assert {:error, :not_found} = S3.get(Keys.oauth_connection(id))
  end

  test "unidentified consent seals its authorization URL and exposes it only for its live attempt" do
    {tenant, group, user} = consent_identity()
    toolkit = "gmail"
    authorization_url = "https://provider.example/oauth?state=private-consent-state"
    now = System.system_time(:millisecond)

    assert {:error, :not_found} = ComposioAccess.consent(tenant, group, user, toolkit)

    assert {:ok, starting} =
             ComposioAccess.begin_consent(tenant, group, user, toolkit, "existing-gmail-account")

    assert starting["toolkit"] == toolkit
    assert starting["status"] == "starting"
    assert starting["replaces"] == "existing-gmail-account"
    assert is_binary(starting["id"])
    assert starting["expires_at"] >= now + 600_000
    assert starting["expires_at"] <= System.system_time(:millisecond) + 600_000

    assert {:error, :composio_consent_pending} =
             ComposioAccess.begin_consent(tenant, group, user, toolkit)

    assert {:ok, pending} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               toolkit,
               starting["id"],
               authorization_url
             )

    assert pending["status"] == "pending"
    assert pending["id"] == starting["id"]
    assert pending["replaces"] == "existing-gmail-account"

    assert {:ok, %{body: body}} = S3.get(consent_key(tenant, group, user, toolkit))
    refute body =~ authorization_url
    refute body =~ "private-consent-state"

    assert {:ok, stored} = ComposioAccess.consent(tenant, group, user, toolkit)
    assert stored["status"] == "pending"
    refute Map.has_key?(stored, "authorization_url")

    assert {:ok, %{"authorization_url" => ^authorization_url, "consent_id" => consent_id}} =
             ComposioAccess.consent_authorization(
               tenant,
               group,
               user,
               toolkit,
               starting["id"]
             )

    assert consent_id == starting["id"]

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.consent_authorization(tenant, group, user, toolkit, "other-attempt")
  end

  test "cancellation fences late finishes and stale cancellation cannot affect a replacement attempt" do
    {tenant, group, user} = consent_identity()
    toolkit = "gmail"

    assert {:ok, first} = ComposioAccess.begin_consent(tenant, group, user, toolkit)

    assert {:ok, cancelled} =
             ComposioAccess.cancel_consent(tenant, group, user, toolkit, first["id"])

    assert cancelled["status"] == "cancelled"

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               toolkit,
               first["id"],
               "https://provider.example/late-first"
             )

    assert {:ok, second} = ComposioAccess.begin_consent(tenant, group, user, toolkit)
    refute second["id"] == first["id"]

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.cancel_consent(tenant, group, user, toolkit, first["id"])

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               toolkit,
               first["id"],
               "https://provider.example/late-after-replacement"
             )

    assert {:ok, current} = ComposioAccess.consent(tenant, group, user, toolkit)
    assert current["id"] == second["id"]
    assert current["status"] == "starting"

    assert {:ok, finished} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               toolkit,
               second["id"],
               "https://provider.example/current"
             )

    assert {:ok, cancelled_pending} =
             ComposioAccess.cancel_consent(tenant, group, user, toolkit, second["id"])

    assert cancelled_pending["status"] == "cancelled"

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.consent_authorization(tenant, group, user, toolkit, second["id"])

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.complete_consent(
               tenant,
               group,
               user,
               toolkit,
               second["id"],
               "gmail-account"
             )

    assert finished["status"] == "pending"
  end

  test "completion claims the exact account once and leaves toolkit and account siblings intact" do
    {tenant, group, user} = consent_identity()

    gmail_accounts = [
      {"gmail-pending-one", "INITIALIZING"},
      {"gmail-pending-two", "INITIALIZING"},
      {"gmail-active-selected", "ACTIVE"}
    ]

    for {id, status} <- gmail_accounts do
      assert {:ok, _} =
               ComposioAccess.put_account(tenant, group, user, id, %{
                 "toolkit" => "gmail",
                 "mode" => "connect",
                 "name" => "preserved-#{id}",
                 "status" => status
               })
    end

    assert {:ok, _} =
             ComposioAccess.put_account(tenant, group, user, "todoist-active", %{
               "toolkit" => "todoist",
               "mode" => "connect",
               "name" => "preserved-todoist",
               "status" => "ACTIVE"
             })

    assert {:ok, gmail} = ComposioAccess.begin_consent(tenant, group, user, "gmail")
    assert {:ok, todoist} = ComposioAccess.begin_consent(tenant, group, user, "todoist")

    assert {:ok, _} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "https://provider.example/gmail"
             )

    assert {:ok, _} =
             ComposioAccess.finish_consent(
               tenant,
               group,
               user,
               "todoist",
               todoist["id"],
               "https://provider.example/todoist"
             )

    assert {:ok, preserved_accounts} = ComposioAccess.accounts(tenant, group, user)

    claims =
      [:first, :second]
      |> Task.async_stream(
        fn _ ->
          ComposioAccess.complete_consent(
            tenant,
            group,
            user,
            "gmail",
            gmail["id"],
            "gmail-active-selected"
          )
        end,
        max_concurrency: 2,
        timeout: 5_000
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(claims, &match?({:ok, %{"status" => "selecting"}}, &1)) == 1
    assert Enum.count(claims, &(&1 == {:error, :composio_consent_in_progress})) == 1
    assert {:ok, completed} = Enum.find(claims, &match?({:ok, _}, &1))

    assert completed["status"] == "selecting"
    assert completed["selected_account_id"] == "gmail-active-selected"

    assert {:error, :composio_consent_in_progress} =
             ComposioAccess.complete_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-active-selected"
             )

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.complete_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-pending-one"
             )

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.complete_consent(
               tenant,
               group,
               user,
               "gmail",
               "stale-attempt",
               "gmail-active-selected"
             )

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.cancel_consent(tenant, group, user, "gmail", gmail["id"])

    key = consent_key(tenant, group, user, "gmail")
    assert {:ok, %{body: body, etag: etag}} = S3.get(key)
    expired = body |> Jason.decode!() |> Map.put("expires_at", 1)
    assert {:ok, _} = S3.put(key, Jason.encode!(expired), if_match: etag)

    assert {:error, :composio_consent_pending} =
             ComposioAccess.begin_consent(tenant, group, user, "gmail")

    assert {:ok, completed} =
             ComposioAccess.settle_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-active-selected"
             )

    assert completed["status"] == "completed"
    assert completed["selected_account_id"] == "gmail-active-selected"

    assert {:ok, completed_again} =
             ComposioAccess.settle_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-active-selected"
             )

    assert completed_again == completed

    assert {:ok, completed_read} =
             ComposioAccess.complete_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-active-selected"
             )

    assert completed_read == completed

    assert {:error, :composio_attempt_not_pending} =
             ComposioAccess.settle_consent(
               tenant,
               group,
               user,
               "gmail",
               gmail["id"],
               "gmail-pending-one"
             )

    assert {:ok, todoist_current} = ComposioAccess.consent(tenant, group, user, "todoist")
    assert todoist_current["id"] == todoist["id"]
    assert todoist_current["status"] == "pending"

    assert {:ok, accounts_after} = ComposioAccess.accounts(tenant, group, user)
    assert accounts_after == preserved_accounts
  end

  defp consent_identity do
    suffix = System.unique_integer([:positive])
    {"tenant-consent-#{suffix}", "group-consent-#{suffix}", "user-consent-#{suffix}"}
  end

  defp consent_key(tenant, group, user, toolkit) do
    segment = fn value -> Base.url_encode64(value, padding: false) end

    "ctl/tenants/#{segment.(tenant)}/composio/groups/#{segment.(group)}/members/" <>
      "#{segment.(user)}/consents/#{segment.(toolkit)}.json"
  end
end
