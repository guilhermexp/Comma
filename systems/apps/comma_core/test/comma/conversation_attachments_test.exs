defmodule Comma.ConversationAttachmentsTest do
  use ExUnit.Case, async: false

  alias Comma.ConversationAttachments

  @max_download_bytes 10_000_000
  @max_file_name_bytes 1_024

  defmodule ClientWithoutMessageLookup do
  end

  test "returns a bounded unavailable result when the Salix client lacks the lookup" do
    previous = Application.get_env(:comma_core, :salix_client)

    on_exit(fn ->
      if previous,
        do: Application.put_env(:comma_core, :salix_client, previous),
        else: Application.delete_env(:comma_core, :salix_client)
    end)

    for client <- [Comma.Salix.Runtime, ClientWithoutMessageLookup] do
      Application.put_env(:comma_core, :salix_client, client)

      assert {:error, :salix_client_not_configured} =
               ConversationAttachments.fetch(
                 %{"default_group_id" => "group"},
                 "conversation",
                 "message",
                 0
               )
    end
  end

  test "advertises the same inclusive byte range the endpoint and native leaf accept" do
    assert ConversationAttachments.downloadable?(block(0))
    assert ConversationAttachments.downloadable?(block(@max_download_bytes))
    refute ConversationAttachments.downloadable?(block(@max_download_bytes + 1))
  end

  test "bounds the UTF-8 file name before publishing a redeemable locator" do
    exact_name = String.duplicate("界", div(@max_file_name_bytes - 1, 3)) <> "a"

    assert byte_size(exact_name) == @max_file_name_bytes
    assert ConversationAttachments.downloadable?(block(1, exact_name))
    refute ConversationAttachments.downloadable?(block(1, exact_name <> "b"))
  end

  test "rejects incomplete immutable blob identities" do
    for blob_ref <- [
          %{"hash" => "sha256:abc", "size" => 1},
          %{"uuid" => "blob-1", "size" => 1},
          %{"hash" => "sha256:abc", "size" => -1, "uuid" => "blob-1"},
          %{"hash" => "sha256:abc", "size" => 1.0, "uuid" => "blob-1"}
        ] do
      refute ConversationAttachments.downloadable?(%{
               "blob_ref" => blob_ref,
               "file_name" => "report.pdf",
               "type" => "file"
             })
    end
  end

  test "uses the workspace basename rather than the human title for download metadata" do
    for {location, expected_name} <- [
          {%{"type" => "file", "path" => "/artifacts/x.csv"}, "x.csv"},
          {%{
             "type" => "image",
             "file_ref" => %{"environment_id" => "vfs", "path" => "/artifacts/image.png"}
           }, "image.png"}
        ] do
      attachment = block(1) |> Map.delete("file_name") |> Map.merge(location)
      attachment = Map.put(attachment, "title", "Comparison of two shifts")
      assert ConversationAttachments.describe(attachment)["file_name"] == expected_name
    end
  end

  defp block(size, file_name \\ "report.pdf") do
    %{
      "blob_ref" => %{"hash" => "sha256:abc", "size" => size, "uuid" => "blob-1"},
      "file_name" => file_name,
      "type" => "file"
    }
  end
end
