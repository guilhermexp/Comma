defmodule SalixIM.TestSupport.BanditServer do
  @moduledoc false

  @first_port 20_000
  @last_port 39_999
  @port_state_key {__MODULE__, :next_port}

  # Req pools connections by destination. Reusing a port after a per-test
  # Bandit exits can route a later request through that stale local pool.
  # Keep every mock destination unique for the lifetime of the test BEAM.
  def start!(spec_fun) when is_function(spec_fun, 1) do
    port = next_port!()

    {Bandit, opts} = spec_fun.(port)
    # Bind the same address used by test requests. On macOS a wildcard bind can
    # coexist with another listener on loopback and send requests to that daemon.
    opts =
      opts
      |> Keyword.put(:ip, {127, 0, 0, 1})
      |> Keyword.update!(:plug, &{__MODULE__.TestRequestsOnly, &1})

    spec = {Bandit, opts}

    case ExUnit.Callbacks.start_supervised(spec, id: {:bandit, port}) do
      {:ok, _pid} ->
        port

      {:error, {{:shutdown, {:failed_to_start_child, :listener, :eaddrinuse}}, _child}} ->
        # An unrelated local daemon may hold one port inside the range
        # (observed: cloudflared listening on 20307). Skip it and keep
        # allocating; the counter never reuses the skipped port.
        start!(spec_fun)

      {:error, reason} ->
        raise "could not bind test Bandit on port #{port}: #{inspect(reason)}"
    end
  end

  defp next_port! do
    lock_id = {@port_state_key, self()}

    case :global.trans(lock_id, fn ->
           port = :persistent_term.get(@port_state_key, @first_port)

           if port > @last_port do
             raise "test Bandit port range #{@first_port}..#{@last_port} exhausted"
           end

           :persistent_term.put(@port_state_key, port + 1)
           port
         end) do
      :aborted -> raise "test Bandit port allocation lock aborted"
      port -> port
    end
  end

  defmodule TestRequestsOnly do
    @moduledoc false
    # Test clients address mocks as 127.0.0.1. Local tools probe every new
    # loopback listener under another Host (observed: `HEAD /` with
    # `Host: localhost:<port>` every few seconds). Such a request is not from
    # the code under test, so it never reaches the test plug.
    @behaviour Plug

    @impl true
    def init({plug, opts}) when is_atom(plug), do: {plug, plug.init(opts)}
    def init(plug) when is_atom(plug), do: init({plug, []})

    @impl true
    def call(%Plug.Conn{host: "127.0.0.1"} = conn, {plug, opts}), do: plug.call(conn, opts)
    def call(conn, _plug), do: Plug.Conn.send_resp(conn, 421, "")
  end
end
