defmodule SalixCalendar.LocalItems do
  @moduledoc """
  Sole owner of Comma-local CalendarItem write persistence.

  Analogous to `SalixCalendar.SourceActor` for source items; `SalixCalendar.LocalStore`
  is the matching read-only helper.

  Idempotency is by construction, with no multi-write protocol: the item id is a
  stable, collision-resistant digest of the exact creation request, so a retried
  request always addresses the same item. `create_once` therefore makes a repeat
  a no-op, and the owner marker write is idempotent, so writes are order- and
  crash-independent. The item carries a content fingerprint, so the same request
  with different content is a conflict rather than a silent return of the first item.

  Only the item's owner edits or deletes it, by compare-and-set on the item
  record with an optional expected revision. Deletion keeps a tombstone, so a
  retried creation request cannot bring the Event back. Owner/month markers
  follow the start month after the item write; a marker left behind by a crash is
  a stale marker, which readers already tolerate.
  """

  alias SalixCalendar.LocalItem
  alias SalixStore.{CasRecord, Crypto, JSON, Keys, S3}

  @proposal_keys ~w(title start time_zone duration description location attendees)
  @id_space 10_000_000_000_000_000_000

  @spec create(String.t(), String.t(), map(), map(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def create(group_id, calendar_id, proposal, owner, creation_request_id)
      when is_binary(group_id) and is_binary(calendar_id) and is_map(proposal) and
             is_binary(creation_request_id) and creation_request_id != "" do
    with {:ok, owner} <- LocalItem.owner(owner),
         item_id <- item_id(creation_request_id),
         fingerprint <- fingerprint(owner, proposal),
         {:ok, %{envelope: envelope, start_ms: start_ms, owner: owner}} <-
           LocalItem.build(item_id, calendar_id, proposal, owner, creation_request_id) do
      envelope = Map.put(envelope, "creation_fingerprint", fingerprint)
      key = item_key(group_id, calendar_id, item_id)

      case create_once(key, envelope) do
        {:ok, item} ->
          finish(group_id, calendar_id, owner, start_ms, item_id, item)

        {:error, :exists} ->
          resume(group_id, calendar_id, owner, start_ms, item_id, key, fingerprint)

        {:error, _} = error ->
          error
      end
    end
  end

  def create(_group_id, _calendar_id, _proposal, _owner, _creation_request_id),
    do: {:error, :invalid_local_item_request}

  @doc "Edit an owner's local Event; `expected_revision` is nil or the revision read."
  @spec update(String.t(), String.t(), String.t(), map(), map(), integer() | nil) ::
          {:ok, map()} | {:error, term()}
  def update(group_id, calendar_id, item_id, owner, patch, expected_revision)
      when is_map(patch) do
    with {:ok, owner} <- LocalItem.owner(owner),
         key <- item_key(group_id, calendar_id, item_id),
         {:ok, current} <- owned(key, owner, expected_revision),
         {:ok, previous_ms} <- LocalItem.start_ms(current),
         {:ok, item} <-
           CasRecord.update(
             key,
             fn
               nil ->
                 {:error, :not_found}

               record ->
                 with :ok <- editable(record, owner, current["revision"]),
                      {:ok, %{envelope: next}} <- LocalItem.patch(record, patch),
                      do: next
             end,
             invalid: :invalid_calendar_record,
             create: false
           ),
         {:ok, start_ms} <- LocalItem.start_ms(item),
         :ok <- put_owner_marker(group_id, calendar_id, owner, start_ms, item_id),
         :ok <- move_marker(group_id, calendar_id, owner, previous_ms, start_ms, item_id) do
      {:ok, item}
    end
  end

  def update(_group_id, _calendar_id, _item_id, _owner, _patch, _expected_revision),
    do: {:error, :invalid_local_item_request}

  @doc "Tombstone an owner's local Event; `expected_revision` is nil or the revision read."
  @spec delete(String.t(), String.t(), String.t(), map(), integer() | nil) ::
          :ok | {:error, term()}
  def delete(group_id, calendar_id, item_id, owner, expected_revision) do
    with {:ok, owner} <- LocalItem.owner(owner),
         key <- item_key(group_id, calendar_id, item_id),
         {:ok, current} <- owned(key, owner, expected_revision),
         {:ok, start_ms} <- LocalItem.start_ms(current),
         {:ok, _tombstone} <-
           CasRecord.update(
             key,
             fn
               nil ->
                 {:error, :not_found}

               record ->
                 with :ok <- editable(record, owner, current["revision"]) do
                   now = System.system_time(:millisecond)

                   record
                   |> Map.put("tombstoned_at", now)
                   |> Map.put("updated_at", now)
                   |> Map.update("revision", 1, &(&1 + 1))
                 end
             end,
             invalid: :invalid_calendar_record,
             create: false
           ) do
      delete_marker(group_id, calendar_id, owner, start_ms, item_id)
    end
  end

  defp owned(key, owner, expected_revision) do
    with {:ok, record} <- record(key),
         :ok <- editable(record, owner, expected_revision || record["revision"]),
         do: {:ok, record}
  end

  # Only a live local item of this exact owner, at the revision the caller read.
  defp editable(record, owner, revision) do
    cond do
      get_in(record, ["origin", "kind"]) != "local" -> {:error, :not_found}
      not is_nil(record["tombstoned_at"]) -> {:error, :not_found}
      not owned_by?(record, owner) -> {:error, :not_found}
      record["revision"] != revision -> {:error, :calendar_event_conflict}
      true -> :ok
    end
  end

  defp owned_by?(%{"owner_principal_ref" => %{} = item_owner}, owner) do
    case LocalItem.owner(item_owner) do
      {:ok, ^owner} -> true
      _ -> false
    end
  end

  defp owned_by?(_record, _owner), do: false

  defp move_marker(group_id, calendar_id, owner, previous_ms, start_ms, item_id) do
    if LocalItem.month_bucket(previous_ms) == LocalItem.month_bucket(start_ms),
      do: :ok,
      else: delete_marker(group_id, calendar_id, owner, previous_ms, item_id)
  end

  defp delete_marker(group_id, calendar_id, owner, start_ms, item_id) do
    case S3.delete(marker_key(group_id, calendar_id, owner, start_ms, item_id)) do
      :ok -> :ok
      {:ok, _} -> :ok
      {:error, :not_found} -> :ok
      {:error, _} = error -> error
    end
  end

  # The deterministic item already exists: an exact-content retry is idempotent;
  # the same request id with different content is a conflict, never a silent
  # return of the first item.
  defp resume(group_id, calendar_id, owner, start_ms, item_id, key, fingerprint) do
    case record(key) do
      {:ok, %{"tombstoned_at" => deleted}} when not is_nil(deleted) ->
        {:error, :calendar_local_item_deleted}

      {:ok, %{"creation_fingerprint" => ^fingerprint} = existing} ->
        finish(group_id, calendar_id, owner, start_ms, item_id, existing)

      {:ok, _mismatch} ->
        {:error, :calendar_local_item_conflict}

      {:error, _} = error ->
        error
    end
  end

  defp finish(group_id, calendar_id, owner, start_ms, item_id, item) do
    with :ok <- put_owner_marker(group_id, calendar_id, owner, start_ms, item_id),
         do: {:ok, item}
  end

  # A stable id derived from the exact creation request. Domain-separated SHA-256
  # reduced to the 19-digit body space; a retried request yields the same id.
  defp item_id(creation_request_id) do
    body =
      :crypto.hash(:sha256, "comma-local-item/v1\0" <> creation_request_id)
      |> :binary.decode_unsigned()
      |> rem(@id_space)
      |> Integer.to_string()
      |> String.pad_leading(19, "0")

    "cit1_" <> body
  end

  defp marker_key(group_id, calendar_id, owner, start_ms, item_id),
    do:
      Keys.ctl_calendar_query_owner_month(
        group_id,
        calendar_id,
        LocalItem.owner_digest(owner),
        LocalItem.month_bucket(start_ms),
        item_id
      )

  defp put_owner_marker(group_id, calendar_id, owner, start_ms, item_id) do
    key = marker_key(group_id, calendar_id, owner, start_ms, item_id)

    case CasRecord.ensure(key, fn -> %{} end, invalid: :invalid_calendar_record) do
      {:ok, _} -> :ok
      {:error, _} = error -> error
    end
  end

  defp create_once(key, value) do
    CasRecord.update(
      key,
      fn
        nil -> value
        _current -> {:error, :exists}
      end,
      invalid: :invalid_calendar_record
    )
  end

  defp record(key), do: CasRecord.get(key, :invalid_calendar_record)

  defp item_key(group_id, calendar_id, item_id),
    do: Keys.ctl_calendar_item(group_id, calendar_id, item_id)

  defp fingerprint(owner, proposal) do
    digest(%{
      "owner" => owner,
      "proposal" => proposal |> JSON.stringify() |> Map.take(@proposal_keys)
    })
  end

  defp digest(value),
    do: value |> JSON.stringify() |> :erlang.term_to_binary([:deterministic]) |> Crypto.hex()
end
