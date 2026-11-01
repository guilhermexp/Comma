# Runs in a separate VM because LocalInstall owns offline database migration.
Logger.configure(level: :warning)
[mode] = System.argv()

for {{app, repo}, index} <-
      Enum.with_index([
        {:comma_core, Comma.Repo},
        {:billing_core, BillingCore.Repo},
        {:salix_store, SalixStore.Repo}
      ]) do
  config =
    Application.fetch_env!(app, repo)
    |> Keyword.merge(
      database: "#{System.fetch_env!("VOICE_TEST_DB_PREFIX")}_#{index}",
      pool: DBConnection.ConnectionPool
    )

  Application.put_env(app, repo, config)
end

Application.put_env(:salix_store, :s3_endpoint, System.fetch_env!("VOICE_TEST_STORAGE_ENDPOINT"))
Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)
{:ok, _} = Application.ensure_all_started(:salix_store)

if mode == "disabled", do: SalixVoice.Settings.update(%{"enabled" => false})
if mode == "non_desktop", do: System.delete_env("COMMA_DESKTOP_LOCAL")

results =
  for _boot <- 1..if(mode == "missing", do: 2, else: 1) do
    # The second boot has initialized SQL stores but no voice settings, as
    # on an installation upgraded from before the desktop voice default.
    if mode == "missing", do: SalixStore.S3.delete(SalixStore.Keys.ctl_system_voice())
    :ok = Comma.LocalInstall.run()
    {:ok, settings} = SalixVoice.Settings.get()
    {:error, readiness} = SalixVoice.readiness()
    {:error, admission} = SalixVoice.admit(%{carrier: :websocket})

    result = %{enabled: settings["enabled"], readiness: readiness, admit: admission}

    if mode == "non_desktop" do
      {:error, :not_found} = SalixStore.S3.get(SalixStore.Keys.ctl_system_voice())
      Map.put(result, :stored, false)
    else
      result
    end
  end

IO.puts("VOICE_BOOT_RESULT=" <> Jason.encode!(results))
