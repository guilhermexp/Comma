defmodule SalixStore.CredentialCipher do
  @moduledoc """
  Authenticated encryption for credentials using the installation's existing
  persistent subscription storage key. The owning domain supplies a stable
  tenant and record identity; ciphertext cannot be moved between those owners.
  """

  def seal(tenant, id, value) do
    with {:ok, key} <- key() do
      nonce = :crypto.strong_rand_bytes(12)

      {body, tag} =
        :crypto.crypto_one_time_aead(
          :aes_256_gcm,
          key,
          nonce,
          Jason.encode!(value),
          tenant <> ":" <> id,
          true
        )

      {:ok, Base.encode64(nonce <> tag <> body)}
    end
  end

  def open(tenant, id, encoded) when is_binary(tenant) and is_binary(encoded) do
    with {:ok, key} <- key(),
         {:ok, <<nonce::binary-size(12), tag::binary-size(16), body::binary>>} <-
           Base.decode64(encoded),
         plain when is_binary(plain) <-
           :crypto.crypto_one_time_aead(
             :aes_256_gcm,
             key,
             nonce,
             body,
             tenant <> ":" <> id,
             tag,
             false
           ),
         {:ok, value} <- Jason.decode(plain) do
      {:ok, value}
    else
      _ -> {:error, :unavailable}
    end
  end

  def open(_, _, _), do: {:error, :unavailable}

  def available?, do: match?({:ok, _}, key())

  defp key do
    case Application.get_env(:salix_agent, :subscription_storage_key) do
      secret when is_binary(secret) and byte_size(secret) == 32 -> {:ok, secret}
      _ -> {:error, :not_configured}
    end
  end
end
