defmodule Salix.Control.ComposioRoutineResult do
  @moduledoc false
  # Only the Routine transport supplies this closed recipe. Provider instructions
  # are never executed. The sandbox CWD is the file authority, not a returned path.
  @external_resource Path.expand("../../../priv/composio_routine_result.py", __DIR__)
  @extractor File.read!(@external_resource)
  @max_bytes 512_000

  def prepare(%{"data" => data} = envelope, session, slug, limit)
      when is_map(data) and is_integer(limit) and limit > 0 do
    case data["remote_file_info"] do
      nil -> {:ok, :inline}
      descriptor -> offload(envelope, descriptor, session, slug, min(limit, @max_bytes))
    end
  end

  def prepare(_, _, _, _), do: {:error, :invalid_provider_response}

  defp offload(envelope, descriptor, session, slug, limit) do
    with %{"data" => %{"session" => %{"id" => ^session}, "results" => [result]}} <- envelope,
         %{
           "index" => 0,
           "tool_slug" => ^slug,
           "response" => %{"successful" => true, "data_preview" => _} = response
         } <- result,
         false <- Map.has_key?(response, "data"),
         %{
           "file_path" => path,
           "filename" => filename,
           "failed_tools" => 0,
           "successful_tools" => 1,
           "total_tools_executed" => 1
         } <- descriptor,
         true <- valid_path?(path, filename) do
      request =
        Jason.encode!(%{
          path: path,
          filename: filename,
          session: session,
          slug: slug,
          limit: limit
        })
        |> Base.encode64()

      {:ok,
       %{
         "code_to_execute" => String.replace(@extractor, "__COMMA_REQUEST_BASE64__", request),
         "session_id" => session,
         "current_step" => "READING_APPROVED_ROUTINE_RESULT"
       }}
    else
      _ -> {:error, :invalid_provider_response}
    end
  end

  defp valid_path?(path, filename) when is_binary(path) and is_binary(filename) do
    byte_size(path) <= 4096 and byte_size(filename) <= 255 and
      Path.type(path) == :absolute and Path.basename(path) == filename and
      Path.basename(filename) == filename and String.ends_with?(filename, ".json") and
      not String.contains?(path, [<<0>>, "\\", "://"]) and
      ".." not in String.split(path, "/")
  end

  defp valid_path?(_, _), do: false

  def complete(
        %{"successful" => true, "data" => %{"session" => %{"id" => session}} = data},
        session,
        slug,
        limit
      )
      when is_map(data) do
    limit = min(limit, @max_bytes)

    with true <-
           Enum.all?(
             ~w(error stderr stdout_file_path stderr_file_path results_file_path),
             &(data[&1] in [nil, ""])
           ),
         true <- data["truncated"] in [nil, false],
         stdout when is_binary(stdout) and byte_size(stdout) <= limit * 2 <- data["stdout"],
         {:ok,
          %{
            "complete" => true,
            "tool_slug" => ^slug,
            "encoding" => "zlib-base64",
            "raw_bytes" => size,
            "payload" => payload
          }} <- Jason.decode(stdout),
         true <- is_integer(size) and size > 0 and size <= limit and is_binary(payload),
         {:ok, compressed} <- Base.decode64(payload),
         {:ok, raw} <- inflate(compressed, limit),
         true <- byte_size(raw) == size,
         {:ok, result} when is_map(result) <- Jason.decode(raw) do
      {:ok,
       %{
         "data" => %{
           "results" => [
             %{
               "index" => 0,
               "tool_slug" => slug,
               "response" => %{"successful" => true, "data" => result}
             }
           ]
         }
       }}
    else
      _ -> {:error, :member_source_context_unavailable}
    end
  end

  def complete(_, _, _, _), do: {:error, :member_source_context_unavailable}

  defp inflate(compressed, limit) do
    z = :zlib.open()

    try do
      :ok = :zlib.inflateInit(z)
      result = inflate_chunks(z, compressed, limit, [])
      :ok = :zlib.inflateEnd(z)
      result
    catch
      _, _ -> {:error, :invalid_provider_response}
    after
      :zlib.close(z)
    end
  end

  defp inflate_chunks(z, input, remaining, chunks) do
    {status, output} = :zlib.safeInflate(z, input)
    size = IO.iodata_length(output)

    cond do
      size > remaining -> {:error, :response_too_large}
      status == :finished -> {:ok, IO.iodata_to_binary(Enum.reverse([output | chunks]))}
      true -> inflate_chunks(z, [], remaining - size, [output | chunks])
    end
  end
end
