defmodule CommaWeb.TelegramOIDC.HTTPAdapterTest do
  use ExUnit.Case, async: false

  alias CommaWeb.TelegramOIDC.HTTPAdapter

  setup_all do
    {:ok, _} = Application.ensure_all_started(:req)
    :ok
  end

  test "a discovery read survives one closed connection" do
    url = endpoint([:close, :ok])

    assert {:ok, {{_, 200, _}, _, "{}"}} = request(:get, url)
    assert_receive {:request, :close}
    assert_receive {:request, :ok}
  end

  test "persistent transport failure returns a safe reason after one retry" do
    url = endpoint([:close, :close, :ok])

    log =
      ExUnit.CaptureLog.capture_log([metadata: [:event, :phase, :reason_class]], fn ->
        assert {:error, {:telegram_oidc_transport, :closed}} = request(:get, url)
      end)

    assert_receive {:request, :close}
    assert_receive {:request, :close}
    refute_receive {:request, :ok}, 150
    assert log =~ "event=telegram_oidc_transport_failed"
    assert log =~ "phase=read"
    assert log =~ "reason_class=closed"
    refute log =~ "private-code"
    refute log =~ "private-body"
  end

  test "a token exchange is never replayed after the connection closes" do
    url = endpoint([:close, :ok])

    log =
      ExUnit.CaptureLog.capture_log([metadata: [:phase]], fn ->
        assert {:error, {:telegram_oidc_transport, :closed}} = request(:post, url)
      end)

    assert log =~ "phase=exchange"
    refute log =~ "private-body"
    refute log =~ "private-code"
    assert_receive {:request, :close}
    refute_receive {:request, :ok}, 150
  end

  test "an HTTP response and its Retry-After are returned to the SDK without sleeping" do
    url = endpoint([:rate_limited, :ok])

    assert {:ok, {{_, 429, _}, _, "{}"}} = request(:get, url)
    assert_receive {:request, :rate_limited}
    refute_receive {:request, :ok}, 150
  end

  test "a local port probe does not take the adapter's fixture outcome" do
    url = endpoint([:ok])
    %URI{port: port} = URI.parse(url)

    # The exact probe a local port scanner sent during the broad test run.
    {:ok, probe} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])

    :ok =
      :gen_tcp.send(
        probe,
        "HEAD / HTTP/1.1\r\nHost: localhost:#{port}\r\nConnection: close\r\n\r\n"
      )

    assert {:error, :closed} = :gen_tcp.recv(probe, 0, 1_000)
    refute_received {:request, _outcome}

    assert {:ok, {{_, 200, _}, _, "{}"}} = request(:get, url)
    assert_receive {:request, :ok}
  end

  test "invalid request options retain a safe diagnostic without exposing request content" do
    assert {:error, {:telegram_oidc_transport, :invalid_request}} =
             HTTPAdapter.request(
               :get,
               {"http://localhost/private-code", []},
               [],
               [body_format: :binary],
               %{}
             )
  end

  defp request(method, url) do
    wire =
      if method == :post,
        do: {url, [], ~c"application/x-www-form-urlencoded", "private-body"},
        else: {url, []}

    HTTPAdapter.request(method, wire, [timeout: 1_000], [body_format: :binary], %{})
  end

  # A TCP fixture is required here: a Plug error is an HTTP response, not a
  # connection lost after the request was received. No provider is contacted.
  defp endpoint(outcomes) do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true, ip: {127, 0, 0, 1}])

    {:ok, {_ip, port}} = :inet.sockname(listener)
    parent = self()

    pid = spawn_link(fn -> serve(listener, outcomes, parent) end)

    on_exit(fn ->
      Process.unlink(pid)
      Process.exit(pid, :kill)
      :gen_tcp.close(listener)
    end)

    "http://127.0.0.1:#{port}/private-code"
  end

  defp serve(_listener, [], _parent), do: :ok

  defp serve(listener, [outcome | rest], parent) do
    case :gen_tcp.accept(listener) do
      {:ok, socket} ->
        case read_head(socket) do
          {:ok, head} ->
            if Regex.match?(~r/^host: 127\.0\.0\.1(:\d+)?\r?$/im, head) do
              respond(socket, outcome, parent)
              serve(listener, rest, parent)
            else
              # A local tool probing the port (observed: `HEAD /` with
              # `Host: localhost:<port>`), not the adapter: no outcome is used.
              :gen_tcp.close(socket)
              serve(listener, [outcome | rest], parent)
            end

          :error ->
            :gen_tcp.close(socket)
            serve(listener, [outcome | rest], parent)
        end

      {:error, :closed} ->
        :ok
    end
  end

  defp read_head(socket, acc \\ "") do
    case :gen_tcp.recv(socket, 0, 2_000) do
      {:ok, data} ->
        acc = acc <> data
        if String.contains?(acc, "\r\n\r\n"), do: {:ok, acc}, else: read_head(socket, acc)

      {:error, _reason} ->
        :error
    end
  end

  defp respond(socket, outcome, parent) do
    send(parent, {:request, outcome})

    case outcome do
      :close ->
        :ok

      :ok ->
        :gen_tcp.send(
          socket,
          "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
        )

      :rate_limited ->
        :gen_tcp.send(
          socket,
          "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3600\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}"
        )
    end

    :gen_tcp.close(socket)
  end
end
