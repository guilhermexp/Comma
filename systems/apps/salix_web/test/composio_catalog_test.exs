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

          "/toolkits/app_1.md" ->
            "# App 1\n\nApp description\n\n## Tools\n\n### List tasks\n\n**Slug:** `APP_1_LIST_TASKS`\n\nRead the task list.\n\n#### Input Parameters\n\n### Complete a task\n\n**Slug:** `APP_1_COMPLETE_TASK`\n\nMark a task complete.\n\n#### Input Parameters\n"

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
      start_supervised!(
        {ComposioCatalog, name: nil, catalog_url: base <> "/toolkits", docs_url: base}
      )

    %{cache: cache, state: state}
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
    assert Agent.get(c.state, & &1) == [{"/toolkits", [], []}]
  end

  test "looks up exact connected toolkits beyond the first page from the same cached catalog", c do
    assert {:ok, %{"items" => first}} = ComposioCatalog.page(%{}, c.cache)
    refute Enum.any?(first, &(&1["slug"] == "app_43"))
    assert {:ok, [%{"slug" => "app_43", "name" => "App 43"}]} =
             ComposioCatalog.lookup(["app_43", "app_43"], c.cache)
    assert Agent.get(c.state, & &1) == [{"/toolkits", [], []}]
    assert {:error, :composio_catalog_unavailable} = ComposioCatalog.lookup(["missing"], c.cache)
    assert {:error, :invalid_toolkits} = ComposioCatalog.lookup(List.duplicate("app_1", 21), c.cache)
    assert {:error, :invalid_toolkits} = ComposioCatalog.lookup(["../private"], c.cache)
  end

  test "lists human-readable permissions within a connector and rejects path injection", c do
    assert {:ok, %{"items" => [tool]}} =
             ComposioCatalog.tools("app_1", %{"query" => "List"}, c.cache)

    assert tool == %{
             "slug" => "APP_1_LIST_TASKS",
             "name" => "List tasks",
             "description" => "Read the task list.",
             "toolkit" => "app_1"
           }

    assert {:error, :invalid_toolkit} = ComposioCatalog.tools("../private", %{}, c.cache)

    assert {:ok, %{"items" => []}} =
             ComposioCatalog.tools("app_1", %{"query" => "unknown"}, c.cache)

    assert Agent.get(c.state, & &1) == [{"/toolkits/app_1.md", [], []}]
  end

  test "an upstream format failure is not an empty catalog", c do
    assert {:error, :composio_catalog_unavailable} = ComposioCatalog.tools("broken", %{}, c.cache)
  end
end
