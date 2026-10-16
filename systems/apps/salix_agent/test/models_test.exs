defmodule SalixAgent.ModelsTest do
  use ExUnit.Case, async: true

  alias SalixAgent.Models

  test "one catalog model carries each source's own request id" do
    assert {:ok, %{"model" => "gpt-6-astra", "protocol" => "responses"}} =
             Models.route("gpt-6-astra", "openai")

    assert {:ok, %{"model" => "openai/gpt-6-astra"}} = Models.route("gpt-6-astra", "openrouter")
    assert {:ok, %{"model" => "gpt-6-astra"}} = Models.route("gpt-6-astra", "codex")
    assert {:ok, %{"kind" => "subscription"}} = Models.source("codex")
  end

  test "versions of one line share a family across sources" do
    {:ok, opus} = Models.get("claude-opus-5")
    {:ok, older} = Models.get("claude-opus-4-8")
    {:ok, sonnet} = Models.get("claude-sonnet-4-5")

    assert opus["name"] == "Opus 5"
    assert opus["family"] == "Opus" and older["family"] == "Opus"
    assert sonnet["family"] == "Sonnet"
  end

  test "a source that does not serve a model has no route to it" do
    assert :error = Models.route("gpt-5.5", "deepseek")
    assert :error = Models.route("no-such-model", "openai")
    assert :error = Models.get(nil)
  end

  test "served_by lists only models some given source can reach" do
    served = Models.served_by(["deepseek"])

    assert Enum.any?(served, &(&1["id"] == "deepseek-v4-pro"))
    refute Enum.any?(served, &(&1["vendor"] == "openai"))
    assert Models.served_by([]) == []
  end

  test "the Claude and ChatGPT plans offer only their current models" do
    offered = fn plan -> plan |> List.wrap() |> Models.served_by() |> Enum.map(& &1["id"]) end

    assert Enum.sort(offered.("claude")) ==
             ~w(claude-fable-5-1 claude-haiku-5-5 claude-opus-5-5 claude-sonnet-5-5)

    assert Enum.sort(offered.("codex")) == ~w(gpt-6-astra gpt-6-luna gpt-6-sol gpt-6.1-sol)

    # Older models keep their other sources.
    assert {:ok, _} = Models.route("claude-opus-5", "anthropic")
  end

  test "every route names a source and a protocol Salix speaks" do
    for model <- Models.list(), {source, route} <- model["routes"] do
      assert {:ok, _} = Models.source(source), "#{model["id"]} routes to unknown #{source}"
      assert route["protocol"] in ~w(anthropic chat_completions responses)
      assert is_binary(route["model"]) and route["model"] != ""
    end
  end
end
