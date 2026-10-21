package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const calendarSecretTitle = "Dentist with Ana"

func calendarMainServer(t *testing.T, modules string, invoke http.HandlerFunc) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer main-test-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/modules":
			_, _ = w.Write([]byte(modules))
		case r.Method == http.MethodPost && r.URL.Path == "/v1/invoke":
			invoke(w, r)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	t.Setenv(commaClientControlURLEnv, server.URL)
	t.Setenv(commaClientControlTokenEnv, "main-test-token")
	return server
}

func TestCalendarForwardsToMainBeforeTheScopeGate(t *testing.T) {
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	var body map[string]any
	calendarMainServer(t, `{"modules":[]}`, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"events":[{"title":"` + calendarSecretTitle + `"}],"truncated":false}`))
	})
	c := &connector{cfg: config{deviceMode: true}, scope: scopeLocalFileRead}
	c.commandContext, c.cancelCommandContext = context.WithCancel(context.Background())
	c.cancelCommandContext()
	input := map[string]any{"calendarIds": []any{}, "start": "2026-10-19T00:00:00-03:00", "end": "2026-10-26T00:00:00-03:00"}
	result, err := c.dispatchSession(context.Background(), nil, "cal-1", "calendar", map[string]any{"op": "events", "input": input})
	if err != nil {
		t.Fatal(err)
	}
	if body["module"] != "calendar" || body["api"] != "events" || body["input"].(map[string]any)["start"] != input["start"] {
		t.Fatalf("Main received %#v", body)
	}
	events := result.(map[string]any)["events"].([]any)
	if len(events) != 1 || result.(map[string]any)["truncated"] != false {
		t.Fatalf("result = %#v", result)
	}
	if strings.Contains(logs.String(), calendarSecretTitle) {
		t.Fatal("event text reached the Connector log")
	}
}

func TestCalendarPassesMainErrorCodesAndRefusesUnknownOps(t *testing.T) {
	calendarMainServer(t, `{"modules":[]}`, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"error":"calendar_access_denied"}`))
	})
	c := &connector{cfg: config{deviceMode: true}, scope: scopeLocalFileRead}
	result, err := c.methodCalendar(map[string]any{"op": "calendars"})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["error"] != "calendar_access_denied" {
		t.Fatalf("result = %#v", result)
	}
	for _, op := range []string{"request-access", "", "open-privacy-settings"} {
		if _, err := c.methodCalendar(map[string]any{"op": op}); err == nil {
			t.Fatalf("accepted op %q", op)
		}
	}
}

func TestCalendarRefusesRedirectsAndOversizedResponses(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("followed a redirect")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer elsewhere.Close()
	mode := "redirect"
	calendarMainServer(t, `{"modules":[]}`, func(w http.ResponseWriter, r *http.Request) {
		if mode == "redirect" {
			http.Redirect(w, r, elsewhere.URL+"/v1/invoke", http.StatusTemporaryRedirect)
			return
		}
		_, _ = w.Write([]byte(`{"events":"` + strings.Repeat("x", maxCommaClientResponse) + `"}`))
	})
	c := &connector{cfg: config{deviceMode: true}, scope: scopeLocalFileRead}
	if _, err := c.methodCalendar(map[string]any{"op": "state"}); err == nil {
		t.Fatal("accepted a redirect")
	}
	mode = "large"
	if _, err := c.methodCalendar(map[string]any{"op": "state"}); err == nil {
		t.Fatal("accepted a response above 1 MiB")
	}
}

func TestCalendarCapabilityFollowsMainModule(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	modules := `{"modules":[{"id":"global-settings"}]}`
	server := calendarMainServer(t, "", func(http.ResponseWriter, *http.Request) {})
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer main-test-token" || r.URL.Path != "/v1/modules" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(modules))
	})
	device := func(scope string) *connector {
		t.Helper()
		c, err := newConnector(config{root: t.TempDir(), deviceMode: true, scope: scope})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(c.closeExternalRuntimes)
		return c
	}
	if device(scopeLocalFileRead).metadata().Capabilities["calendar"] == true {
		t.Fatal("advertised calendar without the Main module")
	}
	modules = `{"modules":[{"id":"global-settings"},{"id":"calendar"}]}`
	if device(scopeLocalFileRead).metadata().Capabilities["calendar"] != true {
		t.Fatal("did not advertise the Main calendar module")
	}
	full := device(scopeLocalFileRead)
	if err := full.setCurrentScope(""); err != nil {
		t.Fatal(err)
	}
	if full.metadata().Capabilities["calendar"] != true {
		t.Fatal("did not advertise calendar with operations allowed")
	}
	t.Setenv(commaClientControlURLEnv, "")
	if device(scopeLocalFileRead).metadata().Capabilities["calendar"] == true {
		t.Fatal("advertised calendar without a Main client-control")
	}
}

func TestCalendarCreatePassesTheCreationKeyToMain(t *testing.T) {
	var body map[string]any
	calendarMainServer(t, `{"modules":[]}`, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_, _ = w.Write([]byte(`{"eventId":"created-1"}`))
	})
	c := &connector{cfg: config{deviceMode: true}, scope: scopeLocalFileRead}
	input := map[string]any{"calendarId": "cal-1", "creationKey": "msg_1:call_1", "event": map[string]any{"title": "x"}}
	if _, err := c.methodCalendar(map[string]any{"op": "create-event", "input": input}); err != nil {
		t.Fatal(err)
	}
	if body["api"] != "create-event" || body["input"].(map[string]any)["creationKey"] != "msg_1:call_1" {
		t.Fatalf("Main received %#v", body)
	}
}
