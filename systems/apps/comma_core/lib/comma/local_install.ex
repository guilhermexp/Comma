defmodule Comma.LocalInstall do
  @moduledoc """
  Preparation step of the macOS desktop app's local backend.

  The app runs `bin/comma eval "Comma.LocalInstall.run()"` with
  `COMMA_ENVIRONMENT=local` before it starts the backend, on every launch. The
  step creates the installation's storage bucket when it is missing and then
  runs `Comma.FreshInstall.run/0`, which initializes an empty database once
  and afterwards applies only pending migrations. When `meetings.local_asr`
  is configured, it then points the global `local-meeting-asr` template at
  the app's loopback ASR server, whose port can change between launches.
  """

  alias SalixAgent.Templates

  @meeting_asr_template "local-meeting-asr"
  @meeting_asr_model "parakeet-tdt-0.6b-v3"

  def run do
    unless System.get_env("COMMA_ENVIRONMENT") == "local" do
      raise "Comma.LocalInstall is restricted to COMMA_ENVIRONMENT=local (the desktop app's local backend)."
    end

    case ensure_bucket() do
      :ok -> Comma.FreshInstall.run()
      {:error, reason} -> raise "local storage bucket is unavailable: #{inspect(reason)}"
    end

    case Application.get_env(:comma_core, :local_meeting_asr) do
      nil ->
        :ok

      local_asr ->
        {:ok, _} = Application.ensure_all_started(:salix_store)

        case ensure_meeting_asr_template(local_asr) do
          {:ok, _template} -> :ok
          error -> raise "local meeting ASR template is unavailable: #{inspect(error)}"
        end
    end
  end

  @doc "Upserts the global `local-meeting-asr` template from `meetings.local_asr`."
  def ensure_meeting_asr_template(
        local_asr \\ Application.get_env(:comma_core, :local_meeting_asr)
      )

  def ensure_meeting_asr_template(%{"base_url" => base_url, "api_key" => api_key})
      when is_binary(base_url) and is_binary(api_key) do
    attrs = %{
      "name" => @meeting_asr_template,
      "model" => @meeting_asr_model,
      "provider_config" => %{
        "protocol" => "audio_transcriptions",
        "base_url" => base_url,
        "api_key" => api_key
      }
    }

    case Templates.get(@meeting_asr_template) do
      {:ok, _template} -> Templates.update(@meeting_asr_template, attrs)
      {:error, :not_found} -> create_meeting_asr_template(attrs)
      error -> error
    end
  end

  def ensure_meeting_asr_template(_local_asr), do: :skip

  defp create_meeting_asr_template(attrs) do
    case Templates.create(Map.put(attrs, "template_id", @meeting_asr_template)) do
      {:error, :exists} -> Templates.update(@meeting_asr_template, attrs)
      result -> result
    end
  end

  @doc "Creates the configured bucket; a bucket this installation already owns is success."
  def ensure_bucket(cfg \\ SalixStore.Config.get()) do
    {:ok, _} = Application.ensure_all_started(:inets)
    url = "#{String.trim_trailing(cfg.endpoint, "/")}/#{cfg.bucket}"

    headers =
      "PUT"
      |> SalixStore.SigV4.sign(url, [], "", cfg)
      |> Enum.reject(fn {name, _value} -> String.downcase(name) == "host" end)
      |> Enum.map(fn {name, value} -> {String.to_charlist(name), String.to_charlist(value)} end)

    request = {String.to_charlist(url), headers, ~c"application/octet-stream", ""}

    case :httpc.request(:put, request, [timeout: 10_000, connect_timeout: 5_000],
           body_format: :binary
         ) do
      {:ok, {{_version, status, _reason}, _headers, _body}} when status in 200..299 ->
        :ok

      {:ok, {{_version, 409, _reason}, _headers, body}} ->
        if error_code(body) in ["BucketAlreadyOwnedByYou", "BucketAlreadyExists"],
          do: :ok,
          else: {:error, {:bucket_create_failed, 409, error_code(body)}}

      {:ok, {{_version, status, _reason}, _headers, body}} ->
        {:error, {:bucket_create_failed, status, error_code(body)}}

      {:error, reason} ->
        {:error, {:storage_unreachable, reason}}
    end
  end

  defp error_code(body) do
    case Regex.run(~r/<Code>([^<]+)<\/Code>/, to_string(body)) do
      [_, code] -> code
      _ -> nil
    end
  end
end
