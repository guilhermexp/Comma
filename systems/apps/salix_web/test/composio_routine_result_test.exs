defmodule Salix.Control.ComposioRoutineResultTest do
  use ExUnit.Case, async: true
  alias Salix.Control.ComposioRoutineResult, as: Result

  @slug "GMAIL_FETCH_MESSAGE_BY_THREAD_ID"
  @fixture Path.join(__DIR__, "support/composio_routine_mount_fixture.py")

  setup do
    base = Path.join(System.tmp_dir!(), "routine-mount-#{System.unique_integer([:positive])}")
    mount = Path.join(base, "files")
    cwd = Path.join(base, "notebook")
    File.mkdir_p!(Path.join(mount, "responses"))
    File.mkdir_p!(cwd)
    on_exit(fn -> File.rm_rf!(base) end)
    %{mount: mount, cwd: cwd}
  end

  test "complete result on the documented files mount is readable outside notebook CWD", c do
    path = Path.join(c.mount, "responses/batch.json")
    data = write_result(path)
    assert {:ok, envelope} = read_result(path, c)
    assert get_in(envelope, ["data", "results", Access.at(0), "response", "data"]) == data
  end

  test "a valid-looking result in notebook CWD outside the files mount is refused", c do
    path = Path.join(c.cwd, "batch.json")
    write_result(path)
    assert {:error, :member_source_context_unavailable} = read_result(path, c)
  end

  defp write_result(path) do
    data = %{"messages" => [%{"snippet" => "Complete fixture context"}]}

    File.write!(
      path,
      Jason.encode!(%{
        "results" => [
          %{
            "index" => 0,
            "tool_slug" => @slug,
            "response" => %{"successful" => true, "data" => data}
          }
        ]
      })
    )

    data
  end

  defp read_result(path, c) do
    envelope = %{
      "data" => %{
        "session" => %{"id" => "workflow"},
        "results" => [
          %{
            "index" => 0,
            "tool_slug" => @slug,
            "response" => %{"successful" => true, "data_preview" => %{}}
          }
        ],
        "remote_file_info" => %{
          "file_path" => path,
          "filename" => "batch.json",
          "failed_tools" => 0,
          "successful_tools" => 1,
          "total_tools_executed" => 1
        }
      }
    }

    {:ok, args} = Result.prepare(envelope, "workflow", @slug, 512_000)
    {stdout, 0} = System.cmd("python3", [@fixture, args["code_to_execute"], c.mount], cd: c.cwd)

    Result.complete(
      %{
        "successful" => true,
        "data" => %{
          "stdout" => stdout,
          "stderr" => "",
          "results" => "",
          "session" => %{"id" => "workflow"}
        }
      },
      "workflow",
      @slug,
      512_000
    )
  end
end
