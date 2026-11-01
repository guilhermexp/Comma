defmodule SalixWeb.Dashboard.SessionTraceController do
  @moduledoc """
  Raw-JSON session reasoning trace, served as its own page so it can be opened
  in a new tab from the session view. LiveView can't return a JSON response, so
  the dashboard links here (mirrors BridgeForTeams' conversation trace proxy).
  """
  use SalixWeb.Dashboard, :controller

  alias SalixAgent.{Control, Runtime}
  alias SalixWeb.Dashboard.Auth

  def show(conn, %{"id" => agent_id, "session_id" => session_id} = params) do
    tenant = Auth.current_tenant(get_session(conn))

    # Includes archived agents: this is a read-only history view linked from
    # the session page, which stays reachable after a soft delete.
    with {:ok, agent} <- Control.get_including_archived(agent_id, tenant),
         {:ok, trace} <-
           Runtime.session_trace(agent, session_id, limit: params["limit"], history: {:tail, 800}) do
      json(conn, trace)
    else
      {:error, :not_found} ->
        conn |> put_status(:not_found) |> json(%{"error" => "not_found"})

      {:error, {:bad_request, message}} ->
        conn |> put_status(400) |> json(%{"error" => message})

      _ ->
        conn |> put_status(400) |> json(%{"error" => "trace_unavailable"})
    end
  end

  def voice_call_trace(conn, %{"id" => agent_id, "call_id" => call_id} = params) do
    tenant = Auth.current_tenant(get_session(conn))
    conn = put_resp_header(conn, "cache-control", "no-store")

    with {:ok, _agent} <- Control.get_including_archived(agent_id, tenant),
         {:ok, trace} <-
           SalixVoice.CallTraceRecords.read_trace(agent_id, call_id,
             limit: params["limit"],
             before: params["before"]
           ),
         true <- trace["tenant_id"] == tenant do
      json(conn, Map.drop(trace, ~w(tenant_id group_id caller)))
    else
      {:error, :invalid_input} -> conn |> put_status(400) |> json(%{"error" => "invalid_input"})
      _ -> conn |> put_status(404) |> json(%{"error" => "call_not_found"})
    end
  end
end
