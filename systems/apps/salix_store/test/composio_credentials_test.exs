defmodule SalixStore.ComposioCredentialsTest do
  use ExUnit.Case, async: false
  alias SalixStore.{Keys, OAuth, S3}

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
    record = %{"tenant" => "tenant-a", "credential_protection" => "composio_connect",
      "access_token" => "private-access-credential", "refresh_token" => "private-refresh-credential",
      "expires_at" => 0, "status" => "active"}
    assert :ok = OAuth.put(id, record)
    assert {:ok, %{body: body}} = S3.get(Keys.oauth_connection(id))
    refute body =~ "private-access-credential"
    refute body =~ "private-refresh-credential"
    assert {:ok, ^record} = OAuth.get(id)
    assert {:ok, "rotated-credential"} = OAuth.valid_token(id, fn actual ->
      assert actual["refresh_token"] == "private-refresh-credential"
      {:ok, %{"access_token" => "rotated-credential", "expires_at" => 999_999}}
    end, now: 1)
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
    assert {:error, :not_configured} = OAuth.put(id, %{"tenant" => "tenant-a",
      "credential_protection" => "composio_connect", "access_token" => "never-persist"})
    assert {:error, :not_found} = S3.get(Keys.oauth_connection(id))
  end
end
