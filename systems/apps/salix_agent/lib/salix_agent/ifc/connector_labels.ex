defmodule SalixAgent.IFC.ConnectorLabels do
  @moduledoc """
  The audience a connector read returned
  (`docs/verification.md` §3.3, §15).

  Group MCP bindings and legacy Composio connections authorize a Group audience.
  Member-owned Composio Connect records acquire this audience only after the
  owner explicitly grants Agent use and accepts workspace-visible results.
  Its broker checks the current owner membership and exact grant before using
  this helper. Login or an unshared account alone does not establish that audience.
  `{:group, id}` is the same audience used by Group memory; it does not authorize
  another Agent to execute tools or bypass external-egress approval.

  Saying so matters more than it looks. Without a label of its own a connector
  result is not a *read* in `SalixAgent.IFC.Destination`'s sense — the call
  sends arguments out, so it is classified as egress — and
  `SalixAgent.IFC.Check.stamp_results/3` would give it **the round's** label:
  the join of what the model declared this round. A round that honestly
  declared `sources: []` would therefore stamp a private page fetched through
  a connector as `{public}`, and an honest citation of it would flow anywhere.
  The round's label describes records the model produced, and content returned
  from outside is not one of those.

  Fail-closed when there is no Group to name: a connector call with no group in
  context reads as agent-private, which flows nowhere.
  """

  alias SalixIFC.{Codec, Label}

  @doc """
  Attaches the Group's audience to a connector result.

  Silent for a session that is not labelling, exactly as
  `SalixAgent.IFC.FileLabels` is: stamping there would put a label on results
  that predate the decision to have one.
  """
  @spec group_audience(term(), map()) :: term()
  def group_audience(result, ctx) when is_map(ctx) do
    if is_map(Map.get(ctx, :ifc)) do
      attach(result, %{"label" => label(ctx)})
    else
      result
    end
  end

  def group_audience(result, _ctx), do: result

  defp label(ctx) do
    case SalixAgent.IFC.text(Map.get(ctx, :group_id) || Map.get(ctx, "group_id")) do
      "" -> Codec.encode_label(Label.new([:agent_private]))
      group_id -> encode({:group, group_id})
    end
  end

  defp encode(atom) do
    case Codec.encode_atom(atom) do
      {:ok, encoded} -> [encoded]
      :error -> Codec.encode_label(Label.new([:agent_private]))
    end
  end

  defp attach({content, events}, ifc) when is_binary(content) and is_list(events),
    do: {:tool_ifc, content, events, ifc}

  defp attach(content, ifc) when is_binary(content), do: {:tool_ifc, content, [], ifc}

  # A status result, a failure, or anything else that is not plain content
  # keeps its own shape.
  defp attach(result, _ifc), do: result
end
