defmodule SalixAgent.CalendarToolsTest do
  use ExUnit.Case, async: false

  alias SalixAgent.CalendarSources.Fake
  alias SalixAgent.Tools.Calendar

  @owner Fake.owner_fixture()
  @owner_ref %{"namespace" => "comma_user", "tenant_id" => "tnt_1", "subject_id" => "usr_owner"}
  @week %{"time_min" => "2026-10-19T00:00:00-03:00", "time_max" => "2026-10-26T00:00:00-03:00"}

  defmodule Scope do
    def agent_oauth_context(_agent_id), do: {:ok, %{tenant: "tnt_1", group_id: "grp_1"}}
  end

  # The internal source behind `SalixAgent.Calendar` (`:calendar_mod`).
  defmodule Internal do
    def put(answers),
      do: Application.put_env(:salix_agent, __MODULE__, Map.put(answers, :test_pid, self()))

    for {name, arity} <- [
          calendars: 2,
          events: 3,
          event: 3,
          create: 4,
          update: 3,
          delete: 3,
          update_context: 2,
          issue_feed_link: 2
        ] do
      args = Macro.generate_arguments(arity, __MODULE__)

      def unquote(name)(unquote_splicing(args)) do
        answers = Application.get_env(:salix_agent, __MODULE__, %{})
        if pid = answers[:test_pid], do: send(pid, {:internal, unquote(name), unquote(args)})

        case Map.fetch(answers, unquote(name)) do
          {:ok, fun} -> apply(fun, unquote(args))
          :error -> SalixAgent.CalendarToolsTest.internal_default(unquote(name))
        end
      end
    end
  end

  def internal_default(:calendars),
    do: {:ok, %{"calendars" => [calendar("comma", nil, "cal_comma", "Comma")]}}

  def internal_default(:events), do: {:ok, %{"events" => [], "truncated" => false}}
  def internal_default(_name), do: {:error, :not_found}

  setup do
    keys = [:oauth_store_mod, :calendar_mod, :calendar_sources_mod, :calendar_source_deadline_ms]
    previous = Map.new(keys, &{&1, Application.fetch_env(:salix_agent, &1)})

    Application.put_env(:salix_agent, :oauth_store_mod, Scope)
    Application.put_env(:salix_agent, :calendar_mod, Internal)
    Application.put_env(:salix_agent, :calendar_source_deadline_ms, 300)
    # The umbrella boots the product port; each test starts from the None default.
    Application.delete_env(:salix_agent, :calendar_sources_mod)
    Internal.put(%{})

    on_exit(fn ->
      Fake.reset()
      Application.delete_env(:salix_agent, Internal)

      Enum.each(previous, fn
        {key, {:ok, value}} -> Application.put_env(:salix_agent, key, value)
        {key, :error} -> Application.delete_env(:salix_agent, key)
      end)
    end)
  end

  # ---------------------------------------------------------------------------
  # Fixtures
  # ---------------------------------------------------------------------------

  def calendar(source, account_id, calendar_id, name, writable \\ true) do
    %{
      "calendar_ref" => %{
        "source" => source,
        "account_id" => account_id,
        "calendar_id" => calendar_id
      },
      "name" => name,
      "writable" => writable,
      "color" => nil
    }
  end

  def event(source, account_id, calendar_id, event_id, start, opts \\ []) do
    %{
      "event_ref" => %{
        "source" => source,
        "account_id" => account_id,
        "calendar_id" => calendar_id,
        "event_id" => event_id,
        "occurrence" => opts[:occurrence],
        "etag" => opts[:etag]
      },
      "calendar_ref" => %{
        "source" => source,
        "account_id" => account_id,
        "calendar_id" => calendar_id
      },
      "title" => Keyword.get(opts, :title, event_id),
      "start" => start,
      "end" => Keyword.get(opts, :end, start),
      "all_day" => false,
      "time_zone" => "America/Sao_Paulo",
      "location" => nil,
      "description" => Keyword.get(opts, :description),
      "recurring" => Keyword.get(opts, :recurring, false),
      "writable" => Keyword.get(opts, :writable, true),
      "ical_uid" => opts[:ical_uid]
    }
  end

  defp google_connected(events_fun) do
    Fake.put(%{
      google_accounts: fn _owner -> {:ok, [%{"account_id" => "acc_1", "name" => "Work"}]} end,
      google: fn
        _owner, "acc_1", :calendars, _args ->
          {:ok, %{"calendars" => [calendar("google", "acc_1", "primary", "Work")]}}

        _owner, "acc_1", :events, args ->
          events_fun.(args)
      end,
      mac: fn
        _owner, "calendars", _input ->
          {:ok, %{"calendars" => [calendar("mac", nil, "mac_home", "Home")]}}

        _owner, "events", _input ->
          {:ok,
           %{
             "events" => [event("mac", nil, "mac_home", "m1", "2026-10-20T08:00:00-03:00")],
             "truncated" => false
           }}
      end
    })
  end

  defp decode(json), do: Jason.decode!(json)

  defp status(result, source),
    do: Enum.find(result["sources"], &(&1["source"] == source))

  defp owner_ctx(overrides \\ %{}) do
    origin =
      Map.merge(
        %{
          "provider" => "internal",
          "source_actor_type" => "user",
          "agent_group_id" => "grp_1",
          "source_message_id" => "msg_1",
          "principal_ref" => @owner_ref
        },
        overrides
      )

    %{
      agent_id: "agent_1",
      source_message_id: "msg_1",
      tool_call_id: "call_1",
      trusted_origin: origin
    }
  end

  # ---------------------------------------------------------------------------
  # Reads
  # ---------------------------------------------------------------------------

  describe "calendar.calendars" do
    test "lists the Comma, Google and Mac calendars, each with its source" do
      google_connected(fn _ -> {:ok, %{"events" => [], "truncated" => false}} end)

      result = decode(Calendar.calendars(%{}, %{agent_id: "agent_1"}))

      assert Enum.map(result["calendars"], &get_in(&1, ["calendar_ref", "source"])) ==
               ["comma", "google", "mac"]

      assert Enum.all?(result["sources"], &(&1["status"] == "ok"))
      assert status(result, "google")["account_id"] == "acc_1"
    end

    test "without Google or the desktop app only Comma is listed and both report not connected" do
      result = decode(Calendar.calendars(%{}, %{agent_id: "agent_1"}))

      assert [%{"name" => "Comma"}] = result["calendars"]
      assert status(result, "comma")["status"] == "ok"
      assert status(result, "google")["status"] == "not_connected"
      assert status(result, "mac")["status"] == "not_connected"
    end
  end

  describe "calendar.events" do
    test "merges the three sources ordered by start" do
      Internal.put(%{
        events: fn "grp_1", params, @owner_ref ->
          send(self(), {:internal_range, params})

          {:ok,
           %{
             "events" => [event("comma", nil, "cal_comma", "c1", "2026-10-21T10:00:00-03:00")],
             "truncated" => false
           }}
        end
      })

      google_connected(fn args ->
        assert args["calendar_ids"] == ["primary"]
        assert args["time_min"] == @week["time_min"]

        {:ok,
         %{
           "events" => [event("google", "acc_1", "primary", "g1", "2026-10-19T12:00:00Z")],
           "truncated" => false
         }}
      end)

      result = decode(Calendar.events(@week, %{agent_id: "agent_1"}))

      assert Enum.map(result["events"], &get_in(&1, ["event_ref", "event_id"])) ==
               ["g1", "m1", "c1"]

      assert Enum.all?(result["sources"], &(&1["status"] == "ok"))
      assert result["truncated"] == false
    end

    test "reads in a scheduled run that carries no human sender" do
      google_connected(fn _ -> {:ok, %{"events" => [], "truncated" => false}} end)
      ctx = %{agent_id: "agent_1", trusted_origin: nil}

      result = decode(Calendar.events(@week, ctx))

      assert ["m1"] == Enum.map(result["events"], &get_in(&1, ["event_ref", "event_id"]))
    end

    test "an unavailable or slow source does not take down the others" do
      Fake.put(%{
        google_accounts: fn _owner ->
          {:ok,
           [
             %{"account_id" => "acc_1", "name" => "Work"},
             %{"account_id" => "acc_2", "name" => "Home"},
             %{"account_id" => "acc_3", "name" => "Old"}
           ]}
        end,
        google: fn
          _owner, "acc_1", :calendars, _args ->
            {:ok, %{"calendars" => [calendar("google", "acc_1", "primary", "Work")]}}

          _owner, "acc_1", :events, _args ->
            Process.sleep(2_000)
            {:ok, %{"events" => [], "truncated" => false}}

          _owner, "acc_2", _operation, _args ->
            {:error, "provider_unavailable"}

          # An error string outside C4 is still one source's error.
          _owner, "acc_3", _operation, _args ->
            {:error, "invalid_request"}
        end,
        # The Mac implementation answers with strings.
        mac: fn _owner, _op, _input -> {:error, "desktop_offline"} end
      })

      Internal.put(%{
        events: fn _group, _params, _owner ->
          {:ok,
           %{
             "events" => [event("comma", nil, "cal_comma", "c1", "2026-10-21T10:00:00-03:00")],
             "truncated" => false
           }}
        end
      })

      result = decode(Calendar.events(@week, %{agent_id: "agent_1"}))

      assert ["c1"] == Enum.map(result["events"], &get_in(&1, ["event_ref", "event_id"]))
      assert status(result, "comma")["status"] == "ok"

      statuses =
        result["sources"]
        |> Enum.filter(&(&1["source"] == "google"))
        |> Map.new(&{&1["account_id"], {&1["status"], &1["reason"]}})

      assert statuses == %{
               "acc_1" => {"error", "timeout"},
               "acc_2" => {"error", "provider_unavailable"},
               "acc_3" => {"error", "invalid_request"}
             }

      assert %{"status" => "unavailable", "reason" => "desktop_offline"} = status(result, "mac")
    end

    test "refuses a period longer than 62 days" do
      args = %{"time_min" => "2026-10-01T00:00:00Z", "time_max" => "2026-12-30T00:00:00Z"}

      assert_raise RuntimeError, ~r/62 days/, fn ->
        Calendar.events(args, %{agent_id: "agent_1"})
      end

      refute_received {:internal, :events, _}
    end

    test "keeps at most 2,500 events per source and says the result was cut" do
      many =
        for minute <- 1..2_600 do
          start = DateTime.add(~U[2026-10-19T12:00:00Z], minute * 60) |> DateTime.to_iso8601()
          event("google", "acc_1", "primary", "g#{minute}", start)
        end

      google_connected(fn _ -> {:ok, %{"events" => many, "truncated" => false}} end)

      result = decode(Calendar.events(@week, %{agent_id: "agent_1"}))

      google = Enum.filter(result["events"], &(get_in(&1, ["event_ref", "source"]) == "google"))
      assert length(google) == 2_500
      assert result["truncated"] == true
      assert status(result, "google")["truncated"] == true
      assert status(result, "mac")["truncated"] == false
    end

    test "cuts long descriptions to 2,000 characters" do
      long = String.duplicate("a", 5_000)

      google_connected(fn _ ->
        {:ok,
         %{
           "events" => [
             event("google", "acc_1", "primary", "g1", "2026-10-19T12:00:00Z", description: long)
           ],
           "truncated" => false
         }}
      end)

      result = decode(Calendar.events(@week, %{agent_id: "agent_1"}))
      [google] = Enum.filter(result["events"], &(get_in(&1, ["event_ref", "event_id"]) == "g1"))

      assert String.length(google["description"]) == 2_000
      assert google["description_truncated"] == true
    end

    test "marks the Mac copy of a Google event as duplicate_of by iCalUID" do
      shared = "uid-123@google.com"

      Fake.put(%{
        google_accounts: fn _owner -> {:ok, [%{"account_id" => "acc_1", "name" => "Work"}]} end,
        google: fn
          _owner, "acc_1", :calendars, _args ->
            {:ok, %{"calendars" => [calendar("google", "acc_1", "primary", "Work")]}}

          _owner, "acc_1", :events, _args ->
            {:ok,
             %{
               "events" => [
                 event("google", "acc_1", "primary", "g1", "2026-10-20T15:00:00Z",
                   ical_uid: shared
                 )
               ],
               "truncated" => false
             }}
        end,
        mac: fn
          _owner, "calendars", _input ->
            {:ok, %{"calendars" => [calendar("mac", nil, "mac_work", "Work")]}}

          _owner, "events", _input ->
            {:ok,
             %{
               "events" => [
                 event("mac", nil, "mac_work", "m1", "2026-10-20T12:00:00-03:00",
                   ical_uid: shared
                 ),
                 event("mac", nil, "mac_work", "m2", "2026-10-21T12:00:00-03:00",
                   ical_uid: shared
                 )
               ],
               "truncated" => false
             }}
        end
      })

      result = decode(Calendar.events(@week, %{agent_id: "agent_1"}))
      by_id = Map.new(result["events"], &{get_in(&1, ["event_ref", "event_id"]), &1})

      assert by_id["m1"]["duplicate_of"]["event_id"] == "g1"
      assert by_id["m1"]["duplicate_of"]["source"] == "google"
      refute Map.has_key?(by_id["g1"], "duplicate_of")
      # Same series, another instance: not the same event.
      refute Map.has_key?(by_id["m2"], "duplicate_of")
    end
  end

  describe "calendar.event" do
    test "reads one event from its own source" do
      google_connected(fn _ -> {:ok, %{"events" => [], "truncated" => false}} end)

      Fake.put(%{
        google: fn _owner, "acc_1", :event, args ->
          assert args == %{"calendar_id" => "primary", "event_id" => "g1"}

          {:ok,
           %{
             "event" =>
               event("google", "acc_1", "primary", "g1", "2026-10-19T12:00:00Z",
                 description: String.duplicate("b", 3_000)
               )
           }}
        end
      })

      ref = %{
        "source" => "google",
        "account_id" => "acc_1",
        "calendar_id" => "primary",
        "event_id" => "g1"
      }

      result = decode(Calendar.event(%{"event_ref" => ref}, %{agent_id: "agent_1"}))
      assert get_in(result, ["event", "event_ref", "event_id"]) == "g1"
      assert String.length(result["event"]["description"]) == 2_000
    end
  end

  # ---------------------------------------------------------------------------
  # Writes
  # ---------------------------------------------------------------------------

  @google_cal %{"source" => "google", "account_id" => "acc_1", "calendar_id" => "primary"}
  @new_event %{
    "title" => "Reunião com a Ana",
    "start" => "2026-10-22T15:00:00-03:00",
    "end" => "2026-10-22T16:00:00-03:00",
    "time_zone" => "America/Sao_Paulo"
  }

  defp google_writes do
    Fake.put(%{
      google: fn _owner, "acc_1", operation, args ->
        case operation do
          :create ->
            {:ok,
             %{"event" => event("google", "acc_1", "primary", "new1", args["event"]["start"])}}

          :update ->
            {:ok, %{"event" => event("google", "acc_1", "primary", args["event_id"], "x")}}

          :delete ->
            {:ok, %{}}
        end
      end
    })
  end

  describe "writes by the owner" do
    test "the owner's own request creates the event in the chosen calendar" do
      google_writes()

      result =
        decode(
          Calendar.create(%{"calendar_ref" => @google_cal, "event" => @new_event}, owner_ctx())
        )

      assert get_in(result, ["event", "event_ref", "event_id"]) == "new1"

      assert_received {:calendar_sources, :google,
                       [@owner, "acc_1", :create, %{"calendar_id" => "primary", "event" => event}]}

      assert event["title"] == "Reunião com a Ana"
      # The model may omit all_day; the sources take it explicitly.
      assert event["all_day"] == false
    end

    test "date-only times are an all-day event, and a time patch carries all_day" do
      google_writes()
      day = %{@new_event | "start" => "2026-10-22", "end" => "2026-10-23"}
      Calendar.create(%{"calendar_ref" => @google_cal, "event" => day}, owner_ctx())

      assert_received {:calendar_sources, :google, [_, "acc_1", :create, %{"event" => event}]}
      assert event["all_day"] == true

      ref = Map.put(@google_cal, "event_id", "g1")
      patch = %{"start" => "2026-10-22T17:00:00-03:00", "end" => "2026-10-22T18:00:00-03:00"}
      Calendar.update(%{"event_ref" => ref, "patch" => patch}, owner_ctx())

      assert_received {:calendar_sources, :google, [_, "acc_1", :update, %{"patch" => patch}]}
      assert patch["all_day"] == false
      refute Map.has_key?(patch, "recurrence")
    end

    test "a Comma create carries the owner and a per-call creation request id" do
      Fake.put(%{})

      Internal.put(%{
        create: fn "grp_1", params, @owner_ref, "msg_1:call_1" ->
          {:ok, %{"event" => event("comma", nil, params["calendar_id"], "cit1", "x")}}
        end
      })

      cal = %{"source" => "comma", "calendar_id" => "cal_comma"}

      assert %{"event" => _} =
               decode(
                 Calendar.create(%{"calendar_ref" => cal, "event" => @new_event}, owner_ctx())
               )

      assert_received {:internal, :create, ["grp_1", %{"calendar_id" => "cal_comma"}, _, _]}
    end

    test "a create without a tool call id fails closed" do
      Fake.put(%{})
      Internal.put(%{create: fn _, _, _, _ -> flunk("must not write") end})
      ctx = Map.delete(owner_ctx(), :tool_call_id)
      cal = %{"source" => "comma", "calendar_id" => "cal_comma"}

      assert_raise RuntimeError, fn ->
        Calendar.create(%{"calendar_ref" => cal, "event" => @new_event}, ctx)
      end
    end

    test "series scope reaches the source with the occurrence" do
      Fake.put(%{
        mac: fn _owner, "update-event", input ->
          {:ok, %{"event" => event("mac", nil, input["calendar_id"], input["event_id"], "x")}}
        end
      })

      ref = %{
        "source" => "mac",
        "calendar_id" => "mac_home",
        "event_id" => "m1",
        "occurrence" => "2026-10-20T08:00:00-03:00"
      }

      Calendar.update(
        %{"event_ref" => ref, "scope" => "series", "patch" => %{"title" => "Novo"}},
        owner_ctx()
      )

      assert_received {:calendar_sources, :mac, [@owner, "update-event", input]}

      assert input == %{
               "calendar_id" => "mac_home",
               "event_id" => "m1",
               "occurrence" => "2026-10-20T08:00:00-03:00",
               "scope" => "series",
               "patch" => %{"title" => "Novo"}
             }
    end

    test "an unknown scope is refused before any source is called" do
      Fake.put(%{})
      ref = Map.put(@google_cal, "event_id", "g1")

      assert_raise RuntimeError, ~r/scope/, fn ->
        Calendar.delete(%{"event_ref" => ref, "scope" => "everything"}, owner_ctx())
      end

      refute_received {:calendar_sources, :google, _}
    end

    test "a read-only calendar is refused with that reason" do
      Fake.put(%{google: fn _owner, "acc_1", :update, _args -> {:error, "read_only"} end})
      ref = %{@google_cal | "calendar_id" => "holidays"} |> Map.put("event_id", "h1")

      assert_raise RuntimeError, ~r/read-only/, fn ->
        Calendar.update(%{"event_ref" => ref, "patch" => %{"title" => "x"}}, owner_ctx())
      end
    end
  end

  describe "writes without the owner's own request" do
    @refused [
      {"a scheduled routine", %{"task_schedule" => %{"schedule_id" => "sch_1"}}},
      {"a Slack sender",
       %{
         "provider" => "slack",
         "principal_ref" => %{
           "namespace" => "slack_user",
           "tenant_id" => "tnt_1",
           "subject_id" => "U1"
         }
       }},
      {"a Feishu sender",
       %{
         "provider" => "feishu",
         "principal_ref" => %{
           "namespace" => "feishu_user",
           "tenant_id" => "tnt_1",
           "subject_id" => "ou_1"
         }
       }},
      {"another Comma member", %{"principal_ref" => %{@owner_ref | "subject_id" => "usr_other"}}},
      {"an agent message", %{"source_actor_type" => "agent"}}
    ]

    for {label, overrides} <- @refused do
      test "#{label} cannot create, update or delete" do
        google_writes()
        ctx = owner_ctx(unquote(Macro.escape(overrides)))
        ref = Map.put(@google_cal, "event_id", "g1")

        for {fun, args} <- [
              {&Calendar.create/2, %{"calendar_ref" => @google_cal, "event" => @new_event}},
              {&Calendar.update/2, %{"event_ref" => ref, "patch" => %{"title" => "x"}}},
              {&Calendar.delete/2, %{"event_ref" => ref}}
            ] do
          assert_raise RuntimeError, ~r/owner's own request/, fn -> fun.(args, ctx) end
        end

        refute_received {:calendar_sources, :google, _}
      end
    end

    test "a scheduled run with no sealed origin cannot write" do
      google_writes()

      ctx = %{
        agent_id: "agent_1",
        source_message_id: "msg_1",
        tool_call_id: "c",
        trusted_origin: nil
      }

      assert_raise RuntimeError, ~r/owner's own request/, fn ->
        Calendar.delete(%{"event_ref" => Map.put(@google_cal, "event_id", "g1")}, ctx)
      end

      refute_received {:calendar_sources, :google, _}
    end

    test "an origin sealed for an earlier message cannot write" do
      google_writes()
      ctx = %{owner_ctx() | source_message_id: "msg_2"}

      assert_raise RuntimeError, ~r/owner's own request/, fn ->
        Calendar.delete(%{"event_ref" => Map.put(@google_cal, "event_id", "g1")}, ctx)
      end
    end
  end

  describe "calendar.update_context" do
    test "accepts the internal event_ref" do
      Internal.put(%{
        update_context: fn "grp_1", params -> {:ok, Map.take(params, ["calendar_id"])} end
      })

      occurrence = %{"calendar_id" => "cal_meet", "recurrence_key" => %{"kind" => "single"}}

      ref = %{
        "source" => "comma",
        "calendar_id" => "cal_meet",
        "event_id" => "cit1",
        "occurrence" => occurrence
      }

      Calendar.update_context(
        %{"event_ref" => ref, "expected_revision" => 0, "objective" => "Prep"},
        %{agent_id: "agent_1"}
      )

      assert_received {:internal, :update_context, ["grp_1", params]}
      assert params["calendar_id"] == "cal_meet"
      assert params["occurrence_ref"] == occurrence
      assert params["objective"] == "Prep"
      refute Map.has_key?(params, "event_ref")
    end

    test "refuses an event from another source" do
      ref = Map.put(@google_cal, "event_id", "g1")

      assert_raise RuntimeError, ~r/Comma/, fn ->
        Calendar.update_context(%{"event_ref" => ref, "expected_revision" => 0}, %{
          agent_id: "agent_1"
        })
      end
    end
  end

  describe "logs" do
    @secret_title "Comma agent secret title 7f3a"
    @secret_location "Secret location 7f3a"
    @secret_description "Secret description 7f3a"

    test "carry no event text from reads, writes or refusals" do
      secret_event =
        event("google", "acc_1", "primary", "s1", "2026-10-20T15:00:00-03:00",
          title: @secret_title,
          description: @secret_description
        )
        |> Map.put("location", @secret_location)

      Fake.put(%{
        google_accounts: fn _owner -> {:ok, [%{"account_id" => "acc_1", "name" => "Work"}]} end,
        google: fn
          _owner, "acc_1", :calendars, _args ->
            {:ok, %{"calendars" => [calendar("google", "acc_1", "primary", "Work")]}}

          _owner, "acc_1", :events, _args ->
            {:ok, %{"events" => [secret_event], "truncated" => false}}

          _owner, "acc_1", :create, _args ->
            {:error, "provider_unavailable"}
        end,
        mac: fn _owner, _op, _input -> {:error, "mac_access_not_granted"} end
      })

      secret = %{
        "title" => @secret_title,
        "location" => @secret_location,
        "description" => @secret_description,
        "start" => "2026-10-22T15:00:00-03:00",
        "end" => "2026-10-22T16:00:00-03:00"
      }

      cal = %{"source" => "google", "account_id" => "acc_1", "calendar_id" => "primary"}

      log =
        ExUnit.CaptureLog.capture_log([level: :debug], fn ->
          assert decode(Calendar.events(@week, %{agent_id: "agent_1"}))["events"] != []

          assert_raise RuntimeError, fn ->
            Calendar.create(%{"calendar_ref" => cal, "event" => secret}, owner_ctx())
          end

          assert_raise RuntimeError, fn ->
            Calendar.create(
              %{"calendar_ref" => cal, "event" => secret},
              %{agent_id: "agent_1", trusted_origin: nil}
            )
          end
        end)

      for text <- [@secret_title, @secret_location, @secret_description],
          do: refute(log =~ text)
    end
  end
end
