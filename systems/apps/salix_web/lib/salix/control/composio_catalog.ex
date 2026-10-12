defmodule Salix.Control.ComposioCatalog do
  @moduledoc """
  Public provider metadata projection, independent of connection credentials.

  Composio Connect has no complete catalog API. The official public catalog
  publishes structured hydration data; the official Markdown pages publish tool
  names. Neither source grants execution authority. This adapter validates that
  public format and fails explicitly on drift. There is no Elixir SDK for it.

  One node-local owner serializes misses. Fetches have a 15-second deadline and
  an 8 MiB body limit. Cached projections expire after 15 minutes and share a
  16 MiB memory budget. Each UI request returns at most 20 items; opening a
  connector fetches only that connector's metadata, never a catalog-wide fanout.
  """
  use GenServer
  @ttl 900_000
  @body_limit 8 * 1024 * 1024
  @cache_limit 16 * 1024 * 1024

  def start_link(opts) do
    GenServer.start_link(
      __MODULE__,
      opts,
      if(opts[:name] == nil and Keyword.has_key?(opts, :name),
        do: [],
        else: [name: opts[:name] || __MODULE__]
      )
    )
  end

  def page(params, server \\ __MODULE__), do: read(server, :catalog, params)

  def tools(toolkit, params, server \\ __MODULE__) do
    if is_binary(toolkit) and Regex.match?(~r/^[a-z0-9_]{1,100}$/, toolkit),
      do: read(server, {:tools, toolkit}, params),
      else: {:error, :invalid_toolkit}
  end

  defp read(server, key, params) do
    with {:ok, query, offset} <- query(params),
         {:ok, items} <- GenServer.call(server, {:get, key}, 30_000) do
      matches = Enum.filter(items, &String.contains?(String.downcase(&1["name"]), query))
      page = Enum.slice(matches, offset, 20)
      next = offset + length(page)

      {:ok,
       %{
         "items" => page,
         "next_cursor" => if(next < length(matches), do: Integer.to_string(next), else: nil)
       }}
    end
  catch
    :exit, _ -> {:error, :composio_catalog_unavailable}
  end

  defp query(params) do
    query = Map.get(params, "query", "")
    cursor = Map.get(params, "cursor")

    offset =
      if is_nil(cursor),
        do: {0, ""},
        else: if(is_binary(cursor), do: Integer.parse(cursor), else: :error)

    case offset do
      {n, ""} when n >= 0 and is_binary(query) and byte_size(query) <= 200 ->
        {:ok, String.downcase(String.trim(query)), n}

      _ ->
        {:error, :invalid_query}
    end
  end

  @impl true
  def init(opts),
    do:
      {:ok,
       %{
         entries: %{},
         catalog_url: opts[:catalog_url] || "https://composio.dev/toolkits",
         docs_url: opts[:docs_url] || "https://docs.composio.dev"
       }}

  @impl true
  def handle_call({:get, key}, _from, state) do
    now = System.monotonic_time(:millisecond)
    entries = Map.filter(state.entries, fn {_, {expiry, _, _}} -> expiry > now end)

    case entries[key] do
      {_, _, result} ->
        {:reply, result, %{state | entries: entries}}

      nil ->
        result = load(key, state)
        size = :erlang.external_size(result)
        # Cache failures briefly to avoid turning an outage into a request storm.
        ttl = if match?({:ok, _}, result), do: @ttl, else: 10_000
        entries = trim(entries, size)

        entries =
          if size <= @cache_limit,
            do: Map.put(entries, key, {now + ttl, size, result}),
            else: entries

        {:reply, result, %{state | entries: entries}}
    end
  end

  defp trim(entries, incoming) do
    if Enum.reduce(entries, incoming, fn {_, {_, size, _}}, sum -> sum + size end) > @cache_limit and
         map_size(entries) > 0 do
      {key, _} = Enum.min_by(entries, fn {_, {expiry, _, _}} -> expiry end)
      trim(Map.delete(entries, key), incoming)
    else
      entries
    end
  end

  defp load(:catalog, state) do
    with {:ok, body} <- fetch(state.catalog_url),
         {:ok, items} <- parse_catalog(body),
         do: {:ok, items}
  end

  defp load({:tools, toolkit}, state) do
    with {:ok, body} <- fetch(state.docs_url <> "/toolkits/" <> toolkit <> ".md"),
         {:ok, items} <- parse_tools(body, toolkit),
         do: {:ok, items}
  end

  defp fetch(url) do
    task = Task.async(fn -> fetch_body(url) end)

    case Task.yield(task, 15_000) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      _ -> {:error, :composio_catalog_unavailable}
    end
  end

  defp fetch_body(url) do
    case Req.get(url,
           retry: false,
           redirect: false,
           decode_body: false,
           receive_timeout: 15_000,
           connect_options: [timeout: 5_000],
           headers: [{"accept-encoding", "identity"}],
           into: fn {:data, chunk}, {req, resp} ->
             body = resp.body || ""

             if byte_size(body) + byte_size(chunk) <= @body_limit,
               do: {:cont, {req, %{resp | body: body <> chunk}}},
               else: {:halt, {req, %{resp | status: 413, body: ""}}}
           end
         ) do
      {:ok, %{status: 200, body: body}} when is_binary(body) -> {:ok, body}
      _ -> {:error, :composio_catalog_unavailable}
    end
  rescue
    _ -> {:error, :composio_catalog_unavailable}
  end

  defp parse_catalog(body) do
    chunks =
      Regex.scan(~r/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/, body,
        capture: :all_but_first
      )

    with {:ok, decoded} <- decode_chunks(chunks),
         line when is_binary(line) <-
           Enum.find(String.split(decoded, "\n"), &String.contains?(&1, "\"initialToolkits\":")),
         [_, json] <- String.split(line, ":", parts: 2),
         {:ok, [_, _, _, %{"initialToolkits" => items, "initialTotal" => total}]} <-
           Jason.decode(json),
         true <- is_list(items) and length(items) == total and total > 0,
         {:ok, projected} <- project(items),
         true <- length(Enum.uniq_by(projected, & &1["slug"])) == length(projected) do
      {:ok, Enum.sort_by(projected, &String.downcase(&1["name"]))}
    else
      _ -> {:error, :composio_catalog_unavailable}
    end
  end

  defp decode_chunks(chunks) do
    Enum.reduce_while(chunks, {:ok, []}, fn [chunk], {:ok, acc} ->
      case Jason.decode(chunk) do
        {:ok, text} when is_binary(text) -> {:cont, {:ok, [text | acc]}}
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, parts} -> {:ok, parts |> Enum.reverse() |> IO.iodata_to_binary()}
      _ -> :error
    end
  end

  defp project(items) do
    Enum.reduce_while(items, {:ok, []}, fn item, {:ok, acc} ->
      if is_map(item) and item["is_live"] == false do
        {:cont, {:ok, acc}}
      else
        case item do
          %{
            "slug" => slug,
            "name" => name,
            "short_description" => description,
            "logo_url" => logo,
            "is_live" => true
          }
          when is_binary(slug) and is_binary(name) and is_binary(description) and is_binary(logo) ->
            if Regex.match?(~r/^[a-z0-9_]{1,100}$/, slug) and byte_size(name) in 1..200 and
                 URI.parse(logo).scheme == "https" and URI.parse(logo).userinfo == nil do
              {:cont,
               {:ok,
                [
                  %{
                    "slug" => slug,
                    "name" => name,
                    "description" => String.slice(description, 0, 600),
                    "logo" => "https://logos.composio.dev/api/" <> slug
                  }
                  | acc
                ]}}
            else
              {:halt, :error}
            end

          _ ->
            {:halt, :error}
        end
      end
    end)
  end

  defp parse_tools(body, toolkit) do
    with [_, tools_body] <- String.split(body, "\n## Tools\n", parts: 2) do
      items =
        Regex.scan(
          ~r/^### ([^\n]+)\n+\*\*Slug:\*\* `([A-Z0-9_]+)`\n+([^\n]+(?:\n(?!#)[^\n]+)*)/m,
          tools_body,
          capture: :all_but_first
        )
        |> Enum.map(fn [name, slug, description] ->
          %{
            "slug" => slug,
            "name" => name,
            "description" => String.slice(String.trim(description), 0, 600),
            "toolkit" => toolkit
          }
        end)

      if items != [] and
           Enum.all?(items, &String.starts_with?(&1["slug"], String.upcase(toolkit) <> "_")),
         do: {:ok, items},
         else: {:error, :composio_catalog_unavailable}
    else
      _ -> {:error, :composio_catalog_unavailable}
    end
  end
end
