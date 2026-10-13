defmodule CommaWeb.RecommendationSourceContractTest do
  use Comma.DataCase, async: false
  alias SalixStore.ComposioAccess, as: Access

  setup do
    unless Process.whereis(BillingCore.Repo), do: start_supervised!(BillingCore.Repo)
    billing = Ecto.Adapters.SQL.Sandbox.start_owner!(BillingCore.Repo, shared: true)
    previous = Application.get_env(:salix_store, :s3_backend)
    Application.put_env(:salix_store, :s3_backend, SalixStore.S3.Fake)

    if Process.whereis(SalixStore.S3.Fake),
      do: SalixStore.S3.Fake.reset(),
      else: start_supervised!(SalixStore.S3.Fake)

    on_exit(fn ->
      Ecto.Adapters.SQL.Sandbox.stop_owner(billing)

      if previous,
        do: Application.put_env(:salix_store, :s3_backend, previous),
        else: Application.delete_env(:salix_store, :s3_backend)
    end)

    {:ok, user} =
      Comma.Accounts.create_user(%{
        "email" => "contract-#{System.unique_integer([:positive])}@comma.test"
      })

    workspace = create_ready_workspace!(user)
    {:ok, _} = Comma.Recommendations.get(user, %{}, workspace["id"])
    %{user: user, w: workspace}
  end

  test "persisted Routine identities including long non-ASCII names and references pass the actual client parser",
       c do
    t = c.w["salix_tenant_id"]
    g = c.w["default_group_id"]
    u = c.user["id"]

    {:ok, _} =
      Access.update_profile(
        t,
        g,
        u,
        &{:ok,
         Map.merge(&1, %{
           "mode" => "connect",
           "status" => "connected",
           "connection_id" => "fixture"
         })}
      )

    identities = [
      {"googledrive_frisky-devout",
       "Casey Example <casey@example.test> (googledrive_frisky-devout)"},
      {"long-name", String.duplicate("Alexandra ", 14) <> "<member@example.test>"},
      {"unicode-name", String.duplicate("👩🏽‍💻", 14) <> " Joana <joana@example.test>"},
      {String.duplicate("opaque", 25), "Joana <joana@example.test>"}
    ]

    for {id, name} <- identities do
      assert byte_size(name) <= 512

      {:ok, _} =
        Access.put_account(t, g, u, id, %{
          "toolkit" => "googledrive",
          "mode" => "connect",
          "status" => "ACTIVE",
          "name" => name
        })
    end

    {:ok, discovered} = CommaWeb.RecommendationSources.discover(c.w, u, "member")
    {:ok, profile} = Comma.Recommendations.get_runtime_profile(c.w["id"], u)
    {:ok, _} = Comma.Recommendations.reconcile_discovered_sources(profile.id, discovered)
    {:ok, envelope} = Comma.Recommendations.get(c.user, %{}, c.w["id"])
    sources = envelope["settings"]["sources"]

    root = Path.expand("../../../..", __DIR__)

    path =
      Path.join(System.tmp_dir!(), "routine-contract-#{System.unique_integer([:positive])}.json")

    File.write!(path, Jason.encode!(sources))
    on_exit(fn -> File.rm(path) end)

    parser =
      Path.join(root, "clients/packages/app/src/test/recommendationSourceContractProbe.mjs")

    {output, exit} =
      System.cmd("node", ["--experimental-strip-types", parser, path], stderr_to_stdout: true)

    assert exit == 0, "Actual client rejected persisted Routine source DTOs: #{output}"

    assert Enum.all?(
             Jason.decode!(output),
             &(&1["accepted"] and &1["referenceRetained"] and &1["labelUnits"] <= 120)
           )

    for {id, _name} <- identities do
      source = Enum.find(sources, &(&1["connectionId"] == id))
      refute source["enabled"]
      suffix = " (#{id})"

      if byte_size(id) < 120 do
        assert String.ends_with?(source["label"], suffix)
        assert length(String.split(source["label"], suffix)) == 2
      else
        refute source["label"] =~ id
        assert source["label"] == "Joana <joana@example.test>"
      end
    end

    short = Enum.find(sources, &(&1["connectionId"] == "googledrive_frisky-devout"))
    assert short["label"] == elem(hd(identities), 1)
    unicode = Enum.find(sources, &(&1["connectionId"] == "unicode-name"))
    assert String.starts_with?(unicode["label"], "👩🏽‍💻")
    assert String.valid?(unicode["label"])
  end
end
