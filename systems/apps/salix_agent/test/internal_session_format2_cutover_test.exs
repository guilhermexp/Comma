defmodule SalixAgent.InternalSessionFormat2CutoverTest do
  use ExUnit.Case, async: false
  alias SalixAgent.InternalSessionFormat2Cutover
  alias SalixStore.{Repo, S3}

  test "historical release entrypoint succeeds without rewriting data or creating a marker" do
    Application.put_env(:salix_store, :s3_backend, S3.Fake)
    start_supervised!(S3.Fake)

    Repo.query!("DELETE FROM salix_cutover_markers WHERE name = $1", [
      "internal_session_format2_v1"
    ])

    assert :ok = InternalSessionFormat2Cutover.run()
    assert S3.Fake.put_log() == []
    # The Fake is shared: Agents left by earlier tests may still read their own
    # state. Only reads made by the entrypoint's caller belong to this run.
    assert S3.Fake.read_log(self()) == []
    refute InternalSessionFormat2Cutover.marker_present?()
  end
end
