defmodule SalixLlm.AnthropicRequestSeamTest do
  use ExUnit.Case, async: false

  alias SalixLlm.Provider

  defmodule MockServer do
    @behaviour Plug
    import Plug.Conn
    use Agent

    def start_link(_opts),
      do: Agent.start_link(fn -> %{requests: [], responses: [], redirect?: false} end)

    def enable_redirect(server), do: Agent.update(server, &%{&1 | redirect?: true})

    @impl true
    def init(server), do: server

    @impl true
    def call(conn, server) do
      {:ok, raw_body, conn} = read_body(conn)

      {status, response, headers} =
        Agent.get_and_update(server, fn %{requests: requests, responses: responses} = state ->
          {{status, response, headers}, rest} =
            if state.redirect? and conn.request_path == "/v1/messages" do
              {{307, "", [{"location", "/redirected"}]}, responses}
            else
              {{status, response}, rest} = pop_response(responses)
              {{status, response, []}, rest}
            end

          request = %{raw_body: raw_body, headers: Map.new(conn.req_headers)}

          {{status, response, headers},
           %{
             state
             | requests: [Map.put(request, :path, conn.request_path) | requests],
               responses: rest
           }}
        end)

      conn =
        Enum.reduce(headers, conn, fn {name, value}, acc -> put_resp_header(acc, name, value) end)

      if response == "" do
        send_resp(conn, status, "")
      else
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(status, Jason.encode!(response))
      end
    end

    defp pop_response([response | rest]), do: {response, rest}

    defp pop_response([]) do
      {{200, %{"content" => [%{"type" => "text", "text" => "ok"}], "stop_reason" => "end_turn"}},
       []}
    end
  end

  setup do
    server = start_supervised!({MockServer, []})

    bandit =
      start_supervised!(
        {Bandit, plug: {MockServer, server}, port: 0, startup_log: false},
        id: :anthropic_request_seam_server
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(bandit)
    {:ok, server: server, base_url: "http://127.0.0.1:#{port}"}
  end

  test "before_send observes the exact Anthropic JSON bytes sent", %{
    server: server,
    base_url: base_url
  } do
    owner = self()

    opts =
      base_opts(base_url)
      |> Map.put(:transport_retry, false)
      |> Map.put(:before_send, fn body ->
        send(owner, {:observed_body, body})
        :ok
      end)

    assert {:final, "ok"} = Provider.complete([%{role: "user", content: "hello"}], [], opts)
    assert_receive {:observed_body, observed_body}

    assert [%{raw_body: sent_body, headers: headers}] = requests(server)
    assert observed_body == sent_body
    assert headers["content-type"] == "application/json"
    assert %{"model" => "claude-test", "messages" => [_]} = Jason.decode!(observed_body)
  end

  test "transport_retry false sends a transient Anthropic failure exactly once", %{
    server: server,
    base_url: base_url
  } do
    Agent.update(server, &%{&1 | responses: [{500, %{"error" => "temporary"}}, {200, success()}]})

    assert {:error, %{"provider" => "anthropic", "status" => 500}} =
             Provider.complete(
               [%{role: "user", content: "hello"}],
               [],
               Map.put(base_opts(base_url), :transport_retry, false)
             )

    assert [_request] = requests(server)
  end

  test "Anthropic never follows a redirect with the observed POST body", %{
    server: server,
    base_url: base_url
  } do
    MockServer.enable_redirect(server)

    assert {:error, %{"provider" => "anthropic", "status" => 307}} =
             Provider.complete(
               [%{role: "user", content: "hello"}],
               [],
               Map.put(base_opts(base_url), :transport_retry, false)
             )

    assert [%{path: "/v1/messages"}] = requests(server)
  end

  test "invalid UTF-8 in transcript text is scrubbed instead of killing the request", %{
    server: server,
    base_url: base_url
  } do
    # Byte-truncated CJK: the corruption shape that used to raise
    # Jason.EncodeError before transport, wedging the session forever.
    truncated = binary_part("接入", 0, 4)

    messages = [
      %{role: "summary", content: "You are an agent. 通过 Slack " <> truncated},
      %{role: "user", content: "把我的电脑 " <> truncated}
    ]

    assert {:final, "ok"} =
             Provider.complete(
               messages,
               [],
               Map.put(base_opts(base_url), :transport_retry, false)
             )

    assert [%{raw_body: sent_body}] = requests(server)
    assert String.valid?(sent_body)
    decoded = Jason.decode!(sent_body)
    assert Jason.encode!(decoded["system"]) =~ "通过 Slack 接�"
    assert Jason.encode!(decoded["messages"]) =~ "接�"
  end

  # Synthetic stand-ins for persisted runtime IDs. The Messages API rejects a
  # tool_use.id outside ^[a-zA-Z0-9_-]+$ with HTTP 400, and the stored
  # transcript is resent on every round, so one such ID blocks the Session.
  test "persisted tool IDs reach Anthropic in its ID alphabet, paired and distinct", %{
    server: server,
    base_url: base_url
  } do
    ids = [
      "runtime-failure-reply:ses1_42:3",
      "runtime-failure-reply.ses1_42.3",
      "runtime-failure-reply/ses1_42/3",
      # Already-valid IDs that a lossy replacement of the IDs above would produce.
      "runtime-failure-reply_ses1_42_3",
      "runtime-failure-reply-ses1_42-3",
      "runtime-failure-replyses1_423",
      "toolu_01AbC-xyz"
    ]

    history = [%{role: "user", content: "hello"} | Enum.flat_map(ids, &tool_round/1)]
    opts = Map.put(base_opts(base_url), :transport_retry, false)

    assert {:final, "ok"} = Provider.complete(history, [], opts)

    assert {:final, "ok"} =
             Provider.complete(history ++ [%{role: "user", content: "next"}], [], opts)

    assert [first, next] = Enum.map(requests(server), &sent_tool_ids(&1.raw_body))

    assert length(first) == length(ids)
    assert Enum.all?(first, fn {use_id, result_id} -> use_id == result_id end)
    wire = Enum.map(first, &elem(&1, 0))
    assert Enum.all?(wire, &anthropic_id?/1)
    assert length(Enum.uniq(wire)) == length(ids)

    for {id, wire_id} <- Enum.zip(ids, wire), anthropic_id?(id) do
      assert wire_id == id
    end

    # A later round resends the same wire IDs, keeping the cached prefix.
    assert next == first
  end

  test "an already-valid tool ID keeps its value when another ID's wire form equals it", %{
    server: server,
    base_url: base_url
  } do
    opts = Map.put(base_opts(base_url), :transport_retry, false)
    user = %{role: "user", content: "hello"}
    persisted = "runtime-failure-reply:ses1_42:3"

    assert {:final, "ok"} = Provider.complete([user | tool_round(persisted)], [], opts)
    assert [%{raw_body: body}] = requests(server)
    assert [{wire, wire}] = sent_tool_ids(body)

    history = [user | tool_round(persisted) ++ tool_round(wire)]
    assert {:final, "ok"} = Provider.complete(history, [], opts)
    assert [_, %{raw_body: body}] = requests(server)
    assert [{moved, moved}, {^wire, ^wire}] = sent_tool_ids(body)
    assert moved != wire
    assert anthropic_id?(moved)
  end

  defp requests(server), do: Agent.get(server, &Enum.reverse(&1.requests))

  defp tool_round(id) do
    [
      %{
        role: "assistant",
        content: "",
        tool_calls: [%{"id" => id, "name" => "call", "args" => %{"text" => "notice"}}]
      },
      %{role: "tool", tool_call_id: id, content: "sent"}
    ]
  end

  # Each tool_use paired with the tool_result in the message that follows it.
  defp sent_tool_ids(raw_body) do
    raw_body
    |> Jason.decode!()
    |> Map.fetch!("messages")
    |> Enum.chunk_every(2, 1, :discard)
    |> Enum.flat_map(fn
      [
        %{"role" => "assistant", "content" => [%{"type" => "tool_use", "id" => use_id}]},
        %{"role" => "user", "content" => [%{"type" => "tool_result", "tool_use_id" => result_id}]}
      ] ->
        [{use_id, result_id}]

      _ ->
        []
    end)
  end

  defp anthropic_id?(id), do: id =~ ~r/\A[a-zA-Z0-9_-]+\z/

  defp success do
    %{"content" => [%{"type" => "text", "text" => "retried"}], "stop_reason" => "end_turn"}
  end

  defp base_opts(base_url) do
    %{
      "protocol" => "anthropic",
      "model" => "claude-test",
      "base_url" => base_url,
      "api_key" => "test-key"
    }
  end
end
