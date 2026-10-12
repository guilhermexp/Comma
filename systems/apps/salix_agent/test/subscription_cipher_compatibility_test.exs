defmodule SalixAgent.SubscriptionCipherCompatibilityTest do
  use ExUnit.Case, async: false

  # Generated once by the unmodified seal/open functions at b2dd1c6b814c42aa252d7b1f35388a3f620da374.
  # All fixture key/credential values are synthetic. Do not regenerate with the current cipher.
  @fixture "fixtures/subscription_cipher_legacy.json"
           |> Path.expand(__DIR__)
           |> File.read!()
           |> Jason.decode!()

  test "pre-extraction subscription ciphertext still decrypts and remains bound to its owner" do
    old = Application.get_env(:salix_agent, :subscription_storage_key)
    Application.put_env(:salix_agent, :subscription_storage_key, @fixture["key"])

    on_exit(fn ->
      if old,
        do: Application.put_env(:salix_agent, :subscription_storage_key, old),
        else: Application.delete_env(:salix_agent, :subscription_storage_key)
    end)

    assert {:ok, @fixture["plaintext"]} ==
             SalixAgent.SubscriptionStore.open(
               @fixture["tenant"],
               @fixture["id"],
               @fixture["ciphertext"]
             )

    assert {:error, :unavailable} =
             SalixAgent.SubscriptionStore.open(
               "other-tenant",
               @fixture["id"],
               @fixture["ciphertext"]
             )

    assert {:error, :unavailable} =
             SalixAgent.SubscriptionStore.open(
               @fixture["tenant"],
               "other-account",
               @fixture["ciphertext"]
             )
  end
end
