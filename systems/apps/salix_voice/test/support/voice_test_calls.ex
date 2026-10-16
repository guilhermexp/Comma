defmodule SalixVoice.TestCalls do
  @moduledoc false
  # `:pg` drops a dead member only after its scope process handles the DOWN
  # message. A test that kills calls and returns at once can leave them in
  # `SalixVoice.local_call_count/0`, so a later admission sees a full node.

  @pg SalixVoice.PG

  @doc "Kill every call on this node and return once `:pg` has dropped them all."
  def stop_all(timeout \\ 5_000) do
    {ref, members} = :pg.monitor(@pg, :calls)

    try do
      local = Enum.filter(members, &(node(&1) == node()))
      Enum.each(local, &Process.exit(&1, :kill))
      await_left(ref, MapSet.new(local), timeout)
    after
      :pg.demonitor(@pg, ref)
    end
  end

  defp await_left(ref, pending, timeout) do
    if MapSet.size(pending) == 0 do
      :ok
    else
      receive do
        {^ref, :leave, :calls, pids} ->
          await_left(ref, MapSet.difference(pending, MapSet.new(pids)), timeout)

        {^ref, :join, :calls, _pids} ->
          await_left(ref, pending, timeout)
      after
        timeout -> raise "voice calls still registered: #{inspect(MapSet.to_list(pending))}"
      end
    end
  end
end
