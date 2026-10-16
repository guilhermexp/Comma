package main

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// Salix replays the canonical events in this fixture as Connector input
// (apps/salix_agent/test/external_session_store_test.exs). This test keeps
// them equal to what the native parsers produce for the recorded native
// lines. Run with UPDATE_ACTIVITY_FIXTURE=1 to rewrite "expected".
func TestActivityNativeEventsFixture(t *testing.T) {
	const path = "testdata/activity_native_events.json"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]any
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	parsers := map[string]func(map[string]any) []map[string]any{
		"claude": claudeStandardEvents,
		"codex": func(native map[string]any) []map[string]any {
			if event := codexStandardEvent(native); event != nil {
				return []map[string]any{event}
			}
			return nil
		},
	}
	update := os.Getenv("UPDATE_ACTIVITY_FIXTURE") == "1"
	for provider, parse := range parsers {
		entries, _ := fixture[provider].([]any)
		if len(entries) == 0 {
			t.Fatalf("%s: no fixture entries", provider)
		}
		for index, item := range entries {
			entry := item.(map[string]any)
			canonical := []any{}
			for _, event := range parse(entry["native"].(map[string]any)) {
				event["created_at"] = int64(entry["created_at"].(float64))
				event = attachRuntimeIdentity(event, "dispatch-fixture", "execution-fixture", entry["work_state"].(string))
				value, err := canonicalExternalRuntimeEvent(event)
				if err != nil {
					t.Fatalf("%s[%d]: %v", provider, index, err)
				}
				encoded, _ := json.Marshal(value)
				var decoded any
				_ = json.Unmarshal(encoded, &decoded)
				canonical = append(canonical, decoded)
			}
			if update {
				entry["expected"] = canonical
			} else if !reflect.DeepEqual(entry["expected"], canonical) {
				got, _ := json.MarshalIndent(canonical, "", "  ")
				t.Fatalf("%s[%d]: canonical events drifted from the fixture:\n%s", provider, index, got)
			}
		}
	}
	if update {
		encoded, _ := json.MarshalIndent(fixture, "", "  ")
		if err := os.WriteFile(path, append(encoded, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
