defmodule SalixIM.TestSupport.BanditServerTest do
  use ExUnit.Case, async: false

  alias SalixIM.TestSupport.BanditServer

  defmodule Endpoint do
    def init(opts), do: opts
    def call(conn, _opts), do: Plug.Conn.send_resp(conn, 200, "test-owned")
  end

  defmodule Recorder do
    def init(owner), do: owner

    def call(conn, owner) do
      send(owner, {:reached_plug, conn.method, conn.host})
      Plug.Conn.send_resp(conn, 200, "test-owned")
    end
  end

  test "skips a listener bound to the exact request address" do
    {:ok, socket} = :gen_tcp.listen(0, ip: {127, 0, 0, 1}, active: false)
    on_exit(fn -> :gen_tcp.close(socket) end)
    {:ok, occupied} = :inet.port(socket)
    owner = self()

    port =
      BanditServer.start!(fn candidate ->
        send(owner, {:candidate, candidate})

        requested =
          if Process.get({__MODULE__, :attempted}, false), do: candidate, else: occupied

        Process.put({__MODULE__, :attempted}, true)
        {Bandit, plug: Endpoint, port: requested}
      end)

    assert_receive {:candidate, first}
    assert_receive {:candidate, ^port}
    assert port > first
    assert Req.get!("http://127.0.0.1:#{port}").body == "test-owned"
  end

  test "answers a local port probe without reaching the test plug" do
    owner = self()

    port = BanditServer.start!(fn port -> {Bandit, plug: {Recorder, owner}, port: port} end)

    # The exact request a local port scanner sent during the broad test run.
    {:ok, socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false])

    :ok =
      :gen_tcp.send(
        socket,
        "HEAD / HTTP/1.1\r\nHost: localhost:#{port}\r\nConnection: close\r\n\r\n"
      )

    assert {:ok, "HTTP/1.1 421" <> _} = :gen_tcp.recv(socket, 0, 1_000)
    :gen_tcp.close(socket)
    refute_received {:reached_plug, _method, _host}

    assert Req.get!("http://127.0.0.1:#{port}").body == "test-owned"
    assert_received {:reached_plug, "GET", "127.0.0.1"}
  end
end
