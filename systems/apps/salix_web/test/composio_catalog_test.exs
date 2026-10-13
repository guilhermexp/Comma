defmodule Salix.Control.ComposioCatalogTest do
  use ExUnit.Case, async: true
  alias Salix.Control.ComposioCatalog

  defmodule Provider do
    import Plug.Conn
    def init(state), do: state

    def call(conn, state) do
      Agent.update(
        state,
        &[
          {conn.request_path, get_req_header(conn, "authorization"),
           get_req_header(conn, "x-api-key")}
          | &1
        ]
      )

      body =
        case conn.request_path do
          "/toolkits" ->
            entries =
              for n <- 1..43,
                  do: %{
                    "slug" => "app_#{n}",
                    "name" => "App #{n}",
                    "short_description" => "App description #{n}",
                    "logo_url" => "https://logos.composio.dev/api/app_#{n}",
                    "is_live" => true
                  }

            flight =
              "2f:" <>
                Jason.encode!([
                  "$",
                  "$L34",
                  nil,
                  %{"initialToolkits" => entries, "initialTotal" => 43}
                ]) <> "\n"

            "<script>self.__next_f.push([1," <> Jason.encode!(flight) <> "])</script>"

          _ ->
            "upstream format changed"
        end

      send_resp(conn, 200, body)
    end
  end

  setup do
    state = start_supervised!({Agent, fn -> [] end})

    server =
      start_supervised!(
        {Bandit, plug: {Provider, state}, port: 0, ip: {127, 0, 0, 1}, startup_log: false}
      )

    {:ok, {_, port}} = ThousandIsland.listener_info(server)
    base = "http://127.0.0.1:#{port}"

    cache =
      start_supervised!({ComposioCatalog, name: nil, catalog_url: base <> "/toolkits"})

    %{cache: cache, state: state, base: base}
  end

  test "browses every catalog page and searches names from one public cached fetch", c do
    assert {:ok, first} = ComposioCatalog.page(%{}, c.cache)
    assert length(first["items"]) == 20
    assert {:ok, second} = ComposioCatalog.page(%{"cursor" => first["next_cursor"]}, c.cache)
    assert {:ok, third} = ComposioCatalog.page(%{"cursor" => second["next_cursor"]}, c.cache)
    assert third["next_cursor"] == nil

    assert length(Enum.uniq_by(first["items"] ++ second["items"] ++ third["items"], & &1["slug"])) ==
             43

    assert {:ok, %{"items" => [%{"slug" => "app_43", "logo" => logo}]}} =
             ComposioCatalog.page(%{"query" => "App 43"}, c.cache)

    assert logo == "https://logos.composio.dev/api/app_43"
    # Other local callers may probe the fixture's root. Cache and credential
    # assertions concern the public catalog fetches made by this adapter.
    assert Agent.get(c.state, &Enum.filter(&1, fn {path, _, _} -> path == "/toolkits" end)) == [
             {"/toolkits", [], []}
           ]
  end

  test "looks up exact connected toolkits beyond the first page from the same cached catalog",
       c do
    assert {:ok, %{"items" => first}} = ComposioCatalog.page(%{}, c.cache)
    refute Enum.any?(first, &(&1["slug"] == "app_43"))

    assert {:ok, [%{"slug" => "app_43", "name" => "App 43"}]} =
             ComposioCatalog.lookup(["app_43", "app_43"], c.cache)

    # Other local callers may probe the fixture's root. Cache and credential
    # assertions concern the public catalog fetches made by this adapter.
    assert Agent.get(c.state, &Enum.filter(&1, fn {path, _, _} -> path == "/toolkits" end)) == [
             {"/toolkits", [], []}
           ]

    assert {:error, :composio_catalog_unavailable} = ComposioCatalog.lookup(["missing"], c.cache)

    assert {:error, :invalid_toolkits} =
             ComposioCatalog.lookup(List.duplicate("app_1", 21), c.cache)

    assert {:error, :invalid_toolkits} = ComposioCatalog.lookup(["../private"], c.cache)
  end

  test "an upstream format failure is not an empty catalog", c do
    broken =
      start_supervised!({ComposioCatalog, name: nil, catalog_url: c.base <> "/broken"},
        id: :broken_catalog
      )

    assert {:error, :composio_catalog_unavailable} = ComposioCatalog.page(%{}, broken)
  end
end
