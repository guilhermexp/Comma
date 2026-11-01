defmodule SalixVoice.SettingsTest do
  use ExUnit.Case, async: false

  alias SalixStore.{Keys, S3}
  alias SalixVoice.Settings

  setup do
    S3.delete(Keys.ctl_system_voice())
    on_exit(fn -> S3.delete(Keys.ctl_system_voice()) end)
    :ok
  end

  test "missing settings read as disabled defaults" do
    assert {:ok, settings} = Settings.redacted()
    assert settings["enabled"] == false
    assert settings["gpt_live_url"] == "wss://api.openai.com/v1/live/sessions"
    assert settings["max_call_seconds"] == 1800
    assert settings["openai_api_key_configured"] == false
    refute Map.has_key?(settings, "openai_api_key")
  end

  test "secrets are write-only: redacted on read, kept when blank, removed on request" do
    assert {:ok, view} =
             Settings.update(%{
               "enabled" => true,
               "openai_api_key" => "sk-live-secret",
               "twilio_auth_token" => "twilio-secret",
               "twilio_numbers" => ["+15550001111"]
             })

    assert view["openai_api_key_configured"] == true
    assert view["twilio_auth_token_configured"] == true
    refute inspect(view) =~ "secret"

    {:ok, redacted} = Settings.redacted()
    refute inspect(redacted) =~ "secret"

    # A dashboard save echoes blanks for write-only fields: the secret stays.
    assert {:ok, _} =
             Settings.update(%{
               "openai_api_key" => "",
               "twilio_auth_token" => nil,
               "max_call_seconds" => 600
             })

    assert {:ok, %{"openai_api_key" => "sk-live-secret", "max_call_seconds" => 600}} =
             Settings.get()

    assert {:ok, view} = Settings.update(%{"clear_secrets" => ["twilio_auth_token"]})
    assert view["twilio_auth_token_configured"] == false

    assert {:ok, %{"twilio_auth_token" => nil, "openai_api_key" => "sk-live-secret"}} =
             Settings.get()
  end

  test "invalid values are refused without writing" do
    for attrs <- [
          %{"enabled" => "yes"},
          %{"twilio_numbers" => ["5551234"]},
          %{"gpt_live_url" => "https://api.openai.com/v1/live/sessions"},
          %{"gpt_live_url" => "ws://api.openai.com/v1/live/sessions"},
          %{"gpt_live_url" => "ws://127.example.com/v1/live/sessions"},
          %{"public_base_url" => "not a url"},
          %{"max_calls_per_node" => 0},
          %{"clear_secrets" => ["gpt_live_model"]}
        ] do
      assert {:error, {:bad_request, _}} = Settings.update(attrs), inspect(attrs)
    end

    assert {:error, :not_found} = S3.get(Keys.ctl_system_voice())
  end

  test "the model URL needs TLS except for a loopback host" do
    for url <- [
          "wss://gpt-live.internal.example/v1/live/sessions",
          "ws://127.0.0.1:4010/v1/live/sessions",
          "ws://localhost:4010/v1/live/sessions",
          "ws://[::1]:4010/v1/live/sessions"
        ] do
      assert {:ok, %{"gpt_live_url" => ^url}} = Settings.update(%{"gpt_live_url" => url})
    end
  end

  test "concurrent updates merge through compare-and-swap" do
    assert {:ok, _} = Settings.update(%{"max_call_seconds" => 900})

    # Park the first writer's read, let a second writer land, then release:
    # the first writer's stale etag fails and it retries on the new object.
    :ok = SalixStore.S3.Fake.set_fault({:pause, :get, Keys.ctl_system_voice()})
    first = Task.async(fn -> Settings.update(%{"enabled" => true}) end)
    wait_until(&SalixStore.S3.Fake.paused?/0)

    assert {:ok, _} = Settings.update(%{"max_calls_per_node" => 7})
    :ok = SalixStore.S3.Fake.release_pause()
    assert {:ok, _} = Task.await(first)

    assert {:ok, %{"enabled" => true, "max_calls_per_node" => 7, "max_call_seconds" => 900}} =
             Settings.get()
  end

  test "desktop default fills only an absent enabled field and preserves stored settings" do
    assert {:ok, _} =
             Settings.update(%{"max_call_seconds" => 600, "openai_api_key" => "test-secret"})

    assert {:ok, %{"enabled" => true, "openai_api_key_configured" => true} = view} =
             Settings.enable_by_default()

    refute Map.has_key?(view, "openai_api_key")

    assert {:ok,
            %{"enabled" => true, "max_call_seconds" => 600, "openai_api_key" => "test-secret"}} =
             Settings.get()

    assert {:ok, before} = S3.get(Keys.ctl_system_voice())
    assert {:ok, _} = Settings.enable_by_default()
    assert {:ok, ^before} = S3.get(Keys.ctl_system_voice())
  end

  test "an explicit disable wins a race with desktop default initialization" do
    :ok = SalixStore.S3.Fake.set_fault({:pause, :get, Keys.ctl_system_voice()})
    first = Task.async(fn -> Settings.enable_by_default() end)
    wait_until(&SalixStore.S3.Fake.paused?/0)
    assert {:ok, _} = Settings.update(%{"enabled" => false})
    :ok = SalixStore.S3.Fake.release_pause()
    assert {:ok, %{"enabled" => false}} = Task.await(first)
    assert {:ok, %{"enabled" => false}} = Settings.get()
  end

  test "desktop initialization preserves an unreadable settings object" do
    assert {:ok, _} = S3.put(Keys.ctl_system_voice(), "invalid json")
    assert {:error, :voice_settings_invalid} = Settings.enable_by_default()
    assert {:ok, %{body: "invalid json"}} = S3.get(Keys.ctl_system_voice())
  end

  test "desktop initialization settles a lost write response by reading the stored value" do
    :ok = SalixStore.S3.Fake.set_fault({:ambiguous_after, :put, Keys.ctl_system_voice()})
    assert {:ok, %{"enabled" => true}} = Settings.enable_by_default()
    assert {:ok, %{"enabled" => true}} = Settings.get()
  end

  test "desktop initialization returns a bounded error when writes remain ambiguous" do
    :ok = SalixStore.S3.Fake.blackhole({:ambiguous_before, :put, Keys.ctl_system_voice()})
    on_exit(fn -> SalixStore.S3.Fake.clear_blackhole() end)
    initializer = Task.async(fn -> Settings.enable_by_default() end)
    assert {:error, {:ambiguous, :injected}} = Task.await(initializer, 1_000)
    assert {:error, :not_found} = S3.get(Keys.ctl_system_voice())
  end

  defp wait_until(fun, attempts \\ 100) do
    cond do
      fun.() -> :ok
      attempts == 0 -> flunk("condition not reached")
      true -> Process.sleep(10) && wait_until(fun, attempts - 1)
    end
  end
end
