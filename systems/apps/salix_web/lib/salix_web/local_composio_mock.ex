if Application.compile_env(:salix_web, :local_recommendation_mock_compiled, false) do
  defmodule SalixWeb.LocalComposioMock do
    @moduledoc """
    Build-gated Composio adapter used by Comma's local recommendation flow.

    It replaces the external Composio settings/client boundary for connected
    accounts, auth configuration, and read-only tool execution. Comma Web keeps
    production source discovery, fixed-recipe selection, bounded server-side
    collection, recommendation orchestration, renderer delivery, validation,
    persistence, and client rendering. The hidden recommendation renderer sees
    only the collected facts; it is not disclosed Composio, MCP, IM, discovery,
    web, or other source tools. Accounts remain group-scoped, exactly like
    production.

    The tool catalog lists the real Composio tool slugs that production code
    calls (the recommendation recipes and the link-preview reads), and every
    execution answers with the provider-faithful response shape from
    `SalixWeb.LocalProviderFixtures` — record links included, timestamps
    derived from now. Chat agents therefore discover and execute the same tool
    surface locally as in production instead of a fictional one, and a slug
    this mock does not implement fails as a structured provider error rather
    than returning made-up data.
    """

    alias SalixWeb.LocalProviderFixtures, as: Fixtures

    @state_key {__MODULE__, :accounts}
    @toolkits ~w(github gmail googlecalendar googledrive linear notion slack)

    # Real Composio tool slugs, per toolkit, with the recommendation recipe's
    # collection slug listed first (local renderer flows execute the first
    # listed tool of a toolkit).
    @toolkit_tools %{
      "github" => [
        {"GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER",
         "List notifications for the authenticated user."},
        {"GITHUB_GET_A_PULL_REQUEST", "Get a pull request by owner, repo, and number."}
      ],
      "gmail" => [
        {"GMAIL_FETCH_EMAILS", "Fetch emails matching a Gmail search query."}
      ],
      "googlecalendar" => [
        {"GOOGLECALENDAR_EVENTS_LIST", "List events from a Google Calendar."}
      ],
      "googledrive" => [
        {"GOOGLEDRIVE_LIST_FILES", "List files from Google Drive."}
      ],
      "linear" => [
        {"LINEAR_RUN_QUERY_OR_MUTATION", "Run a Linear GraphQL query or mutation."}
      ],
      "notion" => [
        {"NOTION_FETCH_DATA", "Fetch Notion pages and databases."},
        {"NOTION_FETCH_ROW", "Fetch one Notion database row or page."}
      ],
      "slack" => [
        {"SLACK_SEARCH_FOR_MESSAGES_WITH_QUERY", "Search Slack messages with a query."}
      ]
    }

    def get(_tenant_id), do: {:ok, settings()}
    def settings(_tenant_id), do: {:ok, settings()}

    def reset! do
      reset_calendar!()
      :persistent_term.put(@state_key, %{})
    end

    def list_connected_accounts(_settings, group_id), do: accounts(group_id)
    def list_connected_accounts_all(_settings, group_id, _opts \\ []), do: accounts(group_id)

    def ensure_auth_config(_settings, toolkit),
      do: {:ok, "local-auth-config-#{normalize_toolkit(toolkit)}"}

    def create_connect_link(_settings, auth_config_id, group_id, _opts \\ []) do
      toolkit = String.replace_prefix(to_string(auth_config_id), "local-auth-config-", "")
      account = put_account(group_id, toolkit)

      {:ok,
       %{
         "redirect_url" => "http://127.0.0.1/local-composio/connected/#{account["id"]}",
         "connected_account_id" => account["id"]
       }}
    end

    def get_connected_account(_settings, id, _opts \\ []) do
      case all_accounts() |> Enum.find(&(&1["id"] == to_string(id))) do
        nil -> {:error, :not_found}
        account -> {:ok, account}
      end
    end

    def delete_connected_account(_settings, id) do
      update(fn by_group ->
        Map.new(by_group, fn {group_id, accounts} ->
          {group_id, Enum.reject(accounts, &(&1["id"] == to_string(id)))}
        end)
      end)

      :ok
    end

    def list_toolkits(_settings, _opts) do
      {:ok,
       Enum.map(@toolkits, fn toolkit ->
         %{
           "slug" => toolkit,
           "name" => humanize(toolkit),
           "meta" => %{
             "description" => "Local #{humanize(toolkit)} data",
             "tools_count" => length(Map.fetch!(@toolkit_tools, toolkit))
           }
         }
       end)}
    end

    def list_tools(_settings, opts) do
      toolkit = Keyword.get(opts, :toolkit)
      slugs = Keyword.get(opts, :tool_slugs)

      tools =
        @toolkits
        |> Enum.flat_map(&tools_for_toolkit/1)
        |> maybe_filter_toolkit(toolkit)
        |> maybe_filter_slugs(slugs)
        |> Enum.take(Keyword.get(opts, :limit, 20))

      {:ok, tools}
    end

    def execute_tool(_settings, tool_slug, group_id, arguments, opts \\ []) do
      toolkit = toolkit_for_slug(tool_slug)
      account_id = Keyword.get(opts, :connected_account_id)

      with true <- toolkit in @toolkits,
           {:ok, accounts} <- accounts(group_id),
           %{} <- matching_account(accounts, toolkit, account_id) do
        case validated_tool_data(tool_slug, toolkit, arguments) do
          {:ok, data} ->
            {:ok,
             %{
               "successful" => true,
               "data" => data,
               "log_id" => "local-composio-#{toolkit}"
             }}

          {:error, message} ->
            {:ok,
             %{
               "successful" => false,
               "error" => message,
               "log_id" => "local-composio-#{toolkit}"
             }}
        end
      else
        _ -> {:error, :not_found}
      end
    end

    # Tool Router proxy reads through the provider's own HTTP API. Each link
    # preview fetches one exact record: Slack's Web API (`auth.test`,
    # `conversations.history`, `conversations.replies`, `conversations.info`,
    # `users.info`), Google Drive's `files.get`, and Google Calendar's
    # `events.get`. The member Routine reads Slack `search.messages`, Gmail
    # profile and threads, the primary calendar and its events, and Drive
    # `about`, `files.list` and comments.
    def create_proxy_session(
          _settings,
          _user_id,
          _account_id,
          _toolkit \\ "googlecalendar",
          _opts \\ []
        ),
        do: {:ok, "local-proxy-session"}

    def proxy_execute(_settings, _session_id, %{"endpoint" => endpoint}, _opts \\ []) do
      uri = URI.parse(to_string(endpoint))
      {:ok, proxy_data(uri.host, uri.path || "", URI.decode_query(uri.query || ""))}
    end

    def delete_proxy_session(_settings, _session_id), do: :ok

    # Slack's Web API answers HTTP 200 with `"ok" => false` for unknown
    # records; only transport failures change the status code.
    defp proxy_data("slack.com", "/api/auth.test", _query),
      do: %{"status" => 200, "data" => Fixtures.slack_auth_test_data()}

    defp proxy_data("slack.com", "/api/conversations.history", query),
      do: %{
        "status" => 200,
        "data" => Fixtures.slack_history_data(query["channel"], query["latest"])
      }

    defp proxy_data("slack.com", "/api/conversations.replies", query),
      do: %{
        "status" => 200,
        "data" => Fixtures.slack_replies_data(query["channel"], query["latest"])
      }

    defp proxy_data("slack.com", "/api/conversations.info", query),
      do: %{"status" => 200, "data" => Fixtures.slack_channel_info_data(query["channel"])}

    defp proxy_data("slack.com", "/api/users.info", query),
      do: %{"status" => 200, "data" => Fixtures.slack_user_info_data(query["user"])}

    defp proxy_data("slack.com", "/api/search.messages", query),
      do: %{"status" => 200, "data" => Fixtures.slack_search_messages_data(query["query"])}

    defp proxy_data("gmail.googleapis.com", "/gmail/v1/users/me/profile", _query),
      do: %{"status" => 200, "data" => Fixtures.gmail_profile_data()}

    defp proxy_data("gmail.googleapis.com", "/gmail/v1/users/me/threads", _query),
      do: %{"status" => 200, "data" => Fixtures.gmail_threads_data()}

    defp proxy_data("gmail.googleapis.com", "/gmail/v1/users/me/threads/" <> thread_id, _query),
      do: %{"status" => 200, "data" => Fixtures.gmail_thread_data(URI.decode(thread_id))}

    defp proxy_data("www.googleapis.com", "/calendar/v3/calendars/primary", _query),
      do: %{"status" => 200, "data" => Fixtures.calendar_primary_data()}

    defp proxy_data("www.googleapis.com", "/calendar/v3/calendars/primary/events", _query),
      do: %{"status" => 200, "data" => Fixtures.calendar_events_data()}

    defp proxy_data("www.googleapis.com", "/drive/v3/about", _query),
      do: %{"status" => 200, "data" => Fixtures.drive_about_data()}

    defp proxy_data("www.googleapis.com", "/drive/v3/files", query),
      do: %{"status" => 200, "data" => Fixtures.drive_files_list_data(query["q"])}

    defp proxy_data(_host, path, _query) do
      cond do
        file_id = path_capture(~r"^/drive/v3/files/([^/]+)/comments$", path) ->
          %{"status" => 200, "data" => Fixtures.drive_comments_data(URI.decode(file_id))}

        file_id = path_capture(~r"^/drive/v3/files/([^/]+)$", path) ->
          %{"status" => 200, "data" => Fixtures.drive_file_data(URI.decode(file_id))}

        event_id = path_capture(~r"/events/([^/?#]+)$", path) ->
          %{"status" => 200, "data" => calendar_event(URI.decode(event_id))}

        true ->
          %{"status" => 404, "data" => %{}}
      end
    end

    defp path_capture(regex, path) do
      case Regex.run(regex, path) do
        [_, capture] -> capture
        _no_match -> nil
      end
    end

    # Reject arguments that omit a tool's required inputs, exactly like the
    # hosted provider would: a call that only works because the mock ignores
    # its arguments is a false green for the production recipes.
    defp validated_tool_data(tool_slug, toolkit, arguments) do
      arguments = if is_map(arguments), do: arguments, else: %{}
      {_properties, required} = tool_input(tool_slug)

      case Enum.reject(required, &(is_map_key(arguments, &1) and arguments[&1] not in [nil, ""])) do
        [] ->
          tool_data(tool_slug, toolkit, arguments)

        missing ->
          {:error, "required inputs missing for #{tool_slug}: #{Enum.join(missing, ", ")}"}
      end
    end

    # Every implemented slug answers with the provider-faithful shape from the
    # shared local fixtures; anything else fails as a structured provider
    # error so callers see an honest "tool unavailable" instead of fake data.
    defp tool_data("SLACK_SEARCH_FOR_MESSAGES_WITH_QUERY", _toolkit, arguments),
      do: {:ok, Fixtures.slack_search_data(arguments["query"])}

    defp tool_data("GMAIL_FETCH_EMAILS", _toolkit, _arguments),
      do: {:ok, Fixtures.gmail_fetch_data()}

    defp tool_data("GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER", _toolkit, _arguments),
      do: {:ok, Fixtures.github_notifications_data()}

    # The recommendation link preview reads one pull request on hover.
    defp tool_data("GITHUB_GET_A_PULL_REQUEST", _toolkit, arguments),
      do: {:ok, Fixtures.github_pull_request_data(arguments)}

    # Linear: the catalog's collection query has no `id` variable; the link
    # preview asks for one issue by identifier.
    defp tool_data("LINEAR_RUN_QUERY_OR_MUTATION", _toolkit, %{"variables" => %{"id" => id}})
         when is_binary(id),
         do: {:ok, Fixtures.linear_issue_data(id)}

    defp tool_data("LINEAR_RUN_QUERY_OR_MUTATION", _toolkit, _arguments),
      do: {:ok, Fixtures.linear_issues_data()}

    defp tool_data("NOTION_FETCH_DATA", _toolkit, _arguments),
      do: {:ok, Fixtures.notion_pages_data()}

    defp tool_data("NOTION_FETCH_ROW", _toolkit, arguments),
      do: {:ok, Fixtures.notion_row_data(arguments)}

    defp tool_data("GOOGLECALENDAR_EVENTS_LIST", _toolkit, _arguments),
      do: {:ok, Fixtures.calendar_events_data()}

    defp tool_data("GOOGLEDRIVE_LIST_FILES", _toolkit, _arguments),
      do: {:ok, Fixtures.drive_files_data()}

    defp tool_data(tool_slug, toolkit, _arguments) do
      available = @toolkit_tools |> Map.get(toolkit, []) |> Enum.map(&elem(&1, 0))

      {:error,
       "the local provider mock does not implement #{tool_slug}; " <>
         "available #{toolkit} tools: #{Enum.join(available, ", ")}"}
    end

    defp calendar_event(event_id), do: Fixtures.calendar_event(event_id)

    # Agenda: the closed `google_calendar` action dispatches its fixed slugs
    # here while the local provider is enabled. Each group holds two calendars
    # (a writable primary and a read-only holiday calendar) and events of the
    # current week, with writes kept in memory like the provider's own store.
    @calendar_key {__MODULE__, :calendar}
    @calendar_offset "-03:00"
    @calendar_zone "America/Sao_Paulo"
    @primary_calendar "local-member@comma.test"
    @holiday_calendar "pt.brazilian#holiday@group.v.calendar.google.com"

    def execute_calendar(group_id, account_id, %{"tool_slug" => slug, "arguments" => args}) do
      group_id = to_string(group_id)

      with {:ok, accounts} <- accounts(group_id),
           %{} <- matching_account(accounts, "googlecalendar", account_id) do
        result =
          :global.trans({__MODULE__, :calendar}, fn ->
            store = calendar_store(group_id)

            case calendar_tool(slug, args, store) do
              {:ok, data, store} ->
                put_calendar_store(group_id, store)
                {:ok, data}

              {:ok, data} ->
                {:ok, data}

              {:error, _} = error ->
                error
            end
          end)

        case result do
          {:ok, data} -> {:ok, %{"successful" => true, "data" => data}}
          {:error, text} -> {:ok, %{"successful" => false, "error" => text}}
        end
      else
        _ -> {:error, :composio_access_denied}
      end
    end

    def reset_calendar!, do: :persistent_term.put(@calendar_key, %{})

    defp calendar_store(group_id),
      do: Map.get(:persistent_term.get(@calendar_key, %{}), group_id) || seed_calendar()

    defp put_calendar_store(group_id, store),
      do:
        :persistent_term.put(
          @calendar_key,
          Map.put(:persistent_term.get(@calendar_key, %{}), group_id, store)
        )

    defp seed_calendar do
      today = DateTime.utc_now() |> DateTime.add(-3 * 3600) |> DateTime.to_date()
      monday = Date.add(today, 1 - Date.day_of_week(today))
      at = fn days, time -> "#{Date.add(monday, days)}T#{time}#{@calendar_offset}" end
      day = fn days -> Date.to_iso8601(Date.add(monday, days)) end

      primary = [
        %{
          "id" => "localweekly",
          "summary" => "Planejamento semanal",
          "recurrence" => ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
          "start" => timed(at.(0, "09:00:00")),
          "end" => timed(at.(0, "09:30:00"))
        },
        %{
          "id" => "localreview",
          "summary" => "Revisão de design",
          "description" => "Rever a Agenda.",
          "start" => timed(at.(2, "14:00:00")),
          "end" => timed(at.(2, "15:30:00"))
        },
        %{
          "id" => "locallunch",
          "summary" => "Almoço com a equipe",
          "location" => "Cantina",
          "colorId" => "2",
          "start" => timed(at.(3, "12:00:00")),
          "end" => timed(at.(3, "13:00:00"))
        },
        %{
          "id" => "localtrip",
          "summary" => "Viagem",
          "start" => %{"date" => day.(4)},
          "end" => %{"date" => day.(6)}
        }
      ]

      holidays = [
        %{
          "id" => "localholiday",
          "summary" => "Feriado (exemplo)",
          "start" => %{"date" => day.(3)},
          "end" => %{"date" => day.(4)}
        }
      ]

      %{
        seq: 1,
        exceptions: %{},
        events: %{
          @primary_calendar => Map.new(primary, &{&1["id"], stamp(&1, @primary_calendar, 1)}),
          @holiday_calendar => Map.new(holidays, &{&1["id"], stamp(&1, @holiday_calendar, 1)})
        }
      }
    end

    defp calendars,
      do: [
        %{
          "id" => @primary_calendar,
          "summary" => "Pessoal",
          "primary" => true,
          "selected" => true,
          "accessRole" => "owner",
          "backgroundColor" => "#9fe1e7",
          "timeZone" => @calendar_zone
        },
        %{
          "id" => @holiday_calendar,
          "summary" => "Feriados no Brasil",
          "selected" => true,
          "accessRole" => "reader",
          "backgroundColor" => "#16a765",
          "timeZone" => @calendar_zone
        }
      ]

    defp timed(value), do: %{"dateTime" => value, "timeZone" => @calendar_zone}

    defp stamp(event, calendar_id, seq) do
      Map.merge(event, %{
        "etag" => "\"local-#{seq}\"",
        "status" => "confirmed",
        "htmlLink" => "https://www.google.com/calendar/event?eid=#{event["id"]}",
        "organizer" => %{"email" => calendar_id, "self" => calendar_id == @primary_calendar}
      })
    end

    defp calendar_tool("GOOGLECALENDAR_LIST_CALENDARS", _args, _store),
      do: {:ok, %{"calendars" => calendars(), "next_page_token" => nil}}

    defp calendar_tool("GOOGLECALENDAR_EVENTS_LIST", %{"calendarId" => id} = args, store) do
      with {:ok, events} <- calendar_events(store, id),
           {:ok, min, _} <- DateTime.from_iso8601(to_string(args["timeMin"])),
           {:ok, max, _} <- DateTime.from_iso8601(to_string(args["timeMax"])) do
        items =
          events
          |> Map.values()
          |> Enum.flat_map(&occurrences(&1, store, min, max))
          |> Enum.sort_by(&instant(&1["start"]), DateTime)

        {:ok, %{"kind" => "calendar#events", "items" => items}}
      else
        _ -> {:error, "404 Not Found: calendar #{id}"}
      end
    end

    defp calendar_tool("GOOGLECALENDAR_EVENTS_GET", %{"event_id" => id} = args, store) do
      case find_event(store, args["calendar_id"] || @primary_calendar, id) do
        {:ok, event} -> {:ok, event}
        :error -> {:error, "404 Not Found: event"}
      end
    end

    defp calendar_tool("GOOGLECALENDAR_CREATE_EVENT", args, store) do
      calendar = args["calendar_id"] || @primary_calendar

      with :ok <- writable(calendar) do
        id = "localevent#{store.seq + 1}"

        event =
          %{
            "id" => id,
            "summary" => args["summary"] || "",
            "start" =>
              if(args["start_date"],
                do: %{"date" => args["start_date"]},
                else: %{"dateTime" => args["start_datetime"], "timeZone" => args["timezone"]}
              ),
            "end" =>
              if(args["end_date"],
                do: %{"date" => args["end_date"]},
                else: %{"dateTime" => args["end_datetime"], "timeZone" => args["timezone"]}
              )
          }
          |> put_present("location", args["location"])
          |> put_present("description", args["description"])
          |> put_present("recurrence", args["recurrence"])
          |> stamp(calendar, store.seq + 1)

        {:ok, %{"response_data" => event}, put_event(store, calendar, event)}
      end
    end

    defp calendar_tool("GOOGLECALENDAR_PATCH_EVENT", %{"event_id" => id} = args, store) do
      calendar = args["calendar_id"]

      with :ok <- writable(calendar),
           {:ok, event} <- found(find_event(store, calendar, id)) do
        seq = store.seq + 1

        event =
          event
          |> put_present("summary", args["summary"])
          |> patch_time("start", args["start_time"], args["timezone"])
          |> patch_time("end", args["end_time"], args["timezone"])
          |> patch_text("location", args["location"])
          |> patch_text("description", args["description"])
          |> patch_rule(args["recurrence"])
          |> stamp(calendar, seq)

        store =
          if event["recurringEventId"],
            do: %{store | seq: seq, exceptions: Map.put(store.exceptions, id, event)},
            else: put_event(%{store | seq: seq}, calendar, event)

        {:ok, event, store}
      end
    end

    defp calendar_tool("GOOGLECALENDAR_DELETE_EVENT", %{"event_id" => id} = args, store) do
      calendar = args["calendar_id"] || @primary_calendar

      with :ok <- writable(calendar),
           {:ok, event} <- found(find_event(store, calendar, id)) do
        store =
          if event["recurringEventId"],
            do: %{store | exceptions: Map.put(store.exceptions, id, :cancelled)},
            else: update_in(store, [:events, calendar], &Map.delete(&1, id))

        {:ok, %{}, store}
      end
    end

    defp calendar_tool("GOOGLECALENDAR_EVENTS_MOVE", %{"event_id" => id} = args, store) do
      {from, to} = {args["calendar_id"], args["destination"]}

      with :ok <- writable(from),
           :ok <- writable(to),
           %{^id => event} <- get_in(store, [:events, from]) do
        event = stamp(event, to, store.seq + 1)
        store = update_in(store, [:events, from], &Map.delete(&1, id))
        {:ok, event, put_event(store, to, event)}
      else
        {:error, _} = error -> error
        _ -> {:error, "404 Not Found: event"}
      end
    end

    defp calendar_tool(slug, _args, _store),
      do: {:error, "the local provider mock does not implement #{slug}"}

    defp writable(@primary_calendar), do: :ok
    defp writable(@holiday_calendar), do: {:error, "403 Forbidden: insufficientPermissions"}
    defp writable(_), do: {:error, "404 Not Found: calendar"}

    defp found({:ok, event}), do: {:ok, event}
    defp found(:error), do: {:error, "404 Not Found: event"}

    defp calendar_events(store, id) do
      case Map.fetch(store.events, id) do
        {:ok, events} -> {:ok, events}
        :error -> :error
      end
    end

    defp put_event(store, calendar, event),
      do: %{
        store
        | seq: store.seq + 1,
          events: Map.update(store.events, calendar, %{}, &Map.put(&1, event["id"], event))
      }

    # A master event or one occurrence of a weekly series.
    defp find_event(store, calendar, id) do
      events = Map.get(store.events, calendar, %{})

      case {Map.fetch(events, id), String.split(id, "_", parts: 2)} do
        {{:ok, event}, _} ->
          {:ok, event}

        {:error, [series, stamp]} ->
          with %{^series => master} <- events,
               occurrence when is_map(occurrence) <-
                 Map.get(store.exceptions, id, occurrence(master, stamp)) do
            {:ok, occurrence}
          else
            _ -> :error
          end

        _ ->
          :error
      end
    end

    defp occurrences(%{"recurrence" => [_ | _]} = master, store, min, max) do
      first = instant(master["start"])
      length = DateTime.diff(instant(master["end"]), first)

      0..60
      |> Enum.map(&DateTime.add(first, &1 * 7 * 86_400))
      |> Enum.filter(&overlaps?(&1, DateTime.add(&1, length), min, max))
      |> Enum.map(&(master["id"] <> "_" <> Calendar.strftime(&1, "%Y%m%dT%H%M%SZ")))
      |> Enum.flat_map(fn id ->
        case Map.get(store.exceptions, id) do
          :cancelled -> []
          nil -> [occurrence(master, String.replace_prefix(id, master["id"] <> "_", ""))]
          event -> [event]
        end
      end)
      |> Enum.filter(&overlaps?(instant(&1["start"]), instant(&1["end"]), min, max))
    end

    defp occurrences(event, _store, min, max) do
      if overlaps?(instant(event["start"]), instant(event["end"]), min, max),
        do: [event],
        else: []
    end

    defp occurrence(master, stamp) do
      with <<y::binary-4, mo::binary-2, d::binary-2, "T", h::binary-2, mi::binary-2, s::binary-2,
             "Z">> <- stamp,
           {:ok, naive} <-
             NaiveDateTime.from_iso8601("#{y}-#{mo}-#{d}T#{h}:#{mi}:#{s}") do
        start = DateTime.from_naive!(naive, "Etc/UTC")
        length = DateTime.diff(instant(master["end"]), instant(master["start"]))

        master
        |> Map.drop(["recurrence"])
        |> Map.merge(%{
          "id" => master["id"] <> "_" <> stamp,
          "recurringEventId" => master["id"],
          "start" => timed(local(start)),
          "end" => timed(local(DateTime.add(start, length)))
        })
      else
        _ -> nil
      end
    end

    defp overlaps?(start, finish, min, max),
      do: DateTime.compare(finish, min) == :gt and DateTime.compare(start, max) == :lt

    defp instant(%{"dateTime" => value}), do: elem(DateTime.from_iso8601(value), 1)

    defp instant(%{"date" => value}),
      do: elem(DateTime.from_iso8601(value <> "T00:00:00" <> @calendar_offset), 1)

    defp local(utc) do
      utc
      |> DateTime.add(-3 * 3600)
      |> DateTime.to_naive()
      |> NaiveDateTime.to_iso8601()
      |> Kernel.<>(@calendar_offset)
    end

    defp put_present(event, _key, value) when value in [nil, ""], do: event
    defp put_present(event, key, value), do: Map.put(event, key, value)

    defp patch_time(event, _key, nil, _zone), do: event

    defp patch_time(event, key, value, _zone) when byte_size(value) == 10,
      do: Map.put(event, key, %{"date" => value})

    defp patch_time(event, key, value, zone),
      do: Map.put(event, key, %{"dateTime" => value, "timeZone" => zone || @calendar_zone})

    defp patch_text(event, _key, nil), do: event
    defp patch_text(event, key, ""), do: Map.delete(event, key)
    defp patch_text(event, key, value), do: Map.put(event, key, value)

    defp patch_rule(event, nil), do: event
    defp patch_rule(event, []), do: Map.delete(event, "recurrence")
    defp patch_rule(event, rules), do: Map.put(event, "recurrence", rules)

    defp settings, do: %{"api_key" => "local-composio", "base_url" => "local://composio"}

    defp accounts(group_id) do
      group_id = to_string(group_id)

      accounts =
        :global.trans({__MODULE__, :state}, fn ->
          state = state()

          case Map.fetch(state, group_id) do
            {:ok, accounts} ->
              accounts

            :error ->
              accounts = Enum.map(@toolkits, &account(group_id, &1))
              :persistent_term.put(@state_key, Map.put(state, group_id, accounts))
              accounts
          end
        end)

      {:ok, accounts}
    end

    # Every Connect Link mints its own account, as the provider does: a
    # toolkit that is connected again holds two accounts until the completed
    # one retires the other. Newest first, with a `created_at`, so callers
    # can order them the way they order the provider's.
    defp put_account(group_id, toolkit) do
      group_id = to_string(group_id)
      toolkit = normalize_toolkit(toolkit)

      :global.trans({__MODULE__, :state}, fn ->
        state = state()
        existing = Map.get(state, group_id, [])
        # An id is never reissued after a delete: the suffix grows past every
        # suffix the toolkit has held in this group.
        repeat =
          existing
          |> Enum.filter(&(toolkit_slug(&1) == toolkit))
          |> Enum.map(&account_repeat(&1["id"], group_id, toolkit))
          |> Enum.max(fn -> -1 end)
          |> Kernel.+(1)

        new_account = account(group_id, toolkit, repeat)
        :persistent_term.put(@state_key, Map.put(state, group_id, [new_account | existing]))
        new_account
      end)
    end

    defp update(fun) do
      :global.trans({__MODULE__, :state}, fn ->
        :persistent_term.put(@state_key, fun.(state()))
      end)
    end

    defp state, do: :persistent_term.get(@state_key, %{})
    defp all_accounts, do: state() |> Map.values() |> List.flatten()

    defp account_repeat(id, group_id, toolkit) do
      case String.replace_prefix(to_string(id), "local-#{group_id}-#{toolkit}", "") do
        "" -> 0
        "-" <> suffix -> String.to_integer(suffix) - 1
      end
    end

    defp account(group_id, toolkit, repeat \\ 0) do
      id =
        if repeat == 0,
          do: "local-#{group_id}-#{toolkit}",
          else: "local-#{group_id}-#{toolkit}-#{repeat + 1}"

      %{
        "id" => id,
        "connected_account_id" => id,
        "user_id" => group_id,
        "toolkit" => %{"slug" => toolkit},
        "status" => "ACTIVE",
        "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
      }
    end

    defp tools_for_toolkit(toolkit) do
      Enum.map(Map.fetch!(@toolkit_tools, toolkit), fn {slug, description} ->
        %{
          "slug" => slug,
          "name" => slug |> String.downcase() |> String.replace("_", " ") |> String.capitalize(),
          "description" => description,
          "toolkit" => %{"slug" => toolkit},
          "input_parameters" => input_parameters(slug)
        }
      end)
    end

    defp input_parameters(tool_slug) do
      {properties, required} = tool_input(tool_slug)
      schema = %{"type" => "object", "properties" => properties}
      if required == [], do: schema, else: Map.put(schema, "required", required)
    end

    # {properties, required inputs} per slug — one table drives both the
    # advertised input schema and execute-time validation.
    defp tool_input("SLACK_SEARCH_FOR_MESSAGES_WITH_QUERY") do
      {%{
         "query" => %{"type" => "string"},
         "count" => %{"type" => "integer"},
         "sort" => %{"type" => "string"},
         "sort_dir" => %{"type" => "string"}
       }, ["query"]}
    end

    defp tool_input("GMAIL_FETCH_EMAILS") do
      {%{
         "query" => %{"type" => "string"},
         "max_results" => %{"type" => "integer"},
         "include_payload" => %{"type" => "boolean"}
       }, []}
    end

    defp tool_input("GITHUB_LIST_NOTIFICATIONS_FOR_THE_AUTHENTICATED_USER") do
      {%{
         "all" => %{"type" => "boolean"},
         "participating" => %{"type" => "boolean"},
         "page" => %{"type" => "integer"},
         "per_page" => %{"type" => "integer"}
       }, []}
    end

    defp tool_input("GITHUB_GET_A_PULL_REQUEST") do
      {%{
         "owner" => %{"type" => "string"},
         "repo" => %{"type" => "string"},
         "pull_number" => %{"type" => "integer"}
       }, ["owner", "repo", "pull_number"]}
    end

    defp tool_input("LINEAR_RUN_QUERY_OR_MUTATION") do
      {%{
         "query_or_mutation" => %{"type" => "string"},
         "variables" => %{"type" => "object"}
       }, ["query_or_mutation", "variables"]}
    end

    defp tool_input("NOTION_FETCH_DATA") do
      {%{
         "get_pages" => %{"type" => "boolean"},
         "page_size" => %{"type" => "integer"}
       }, []}
    end

    # Composio's NOTION_FETCH_ROW takes the page's UUID as `page_id`.
    defp tool_input("NOTION_FETCH_ROW"),
      do: {%{"page_id" => %{"type" => "string"}}, ["page_id"]}

    defp tool_input("GOOGLECALENDAR_EVENTS_LIST") do
      {%{
         "calendarId" => %{"type" => "string"},
         "timeMin" => %{"type" => "string"},
         "timeMax" => %{"type" => "string"},
         "maxResults" => %{"type" => "integer"},
         "singleEvents" => %{"type" => "boolean"},
         "orderBy" => %{"type" => "string"}
       }, ["calendarId"]}
    end

    defp tool_input("GOOGLEDRIVE_LIST_FILES") do
      {%{
         "q" => %{"type" => "string"},
         "orderBy" => %{"type" => "string"},
         "pageSize" => %{"type" => "integer"}
       }, []}
    end

    defp tool_input(_tool_slug), do: {%{"query" => %{"type" => "string"}}, []}

    defp maybe_filter_toolkit(tools, nil), do: tools

    defp maybe_filter_toolkit(tools, toolkit),
      do: Enum.filter(tools, &(toolkit_slug(&1) == normalize_toolkit(toolkit)))

    defp maybe_filter_slugs(tools, nil), do: tools

    defp maybe_filter_slugs(tools, slugs) do
      wanted = slugs |> List.wrap() |> Enum.map(&(to_string(&1) |> String.upcase()))
      Enum.filter(tools, &(String.upcase(&1["slug"]) in wanted))
    end

    defp matching_account(accounts, toolkit, nil),
      do: Enum.find(accounts, &(toolkit_slug(&1) == toolkit))

    defp matching_account(accounts, toolkit, id),
      do: Enum.find(accounts, &(&1["id"] == id and toolkit_slug(&1) == toolkit))

    defp toolkit_slug(value),
      do: get_in(value, ["toolkit", "slug"]) || value["toolkit_slug"] || value["toolkit"]

    defp normalize_toolkit(value), do: value |> to_string() |> String.trim() |> String.downcase()

    defp toolkit_for_slug(slug) do
      slug = slug |> to_string() |> String.upcase()

      Enum.find(@toolkits, fn toolkit ->
        Enum.any?(Map.fetch!(@toolkit_tools, toolkit), &(elem(&1, 0) == slug)) or
          String.starts_with?(slug, String.upcase(toolkit) <> "_")
      end)
    end

    defp humanize(value), do: value |> String.replace(~r/[_-]+/, " ") |> String.capitalize()
  end
end
