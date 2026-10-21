package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// The Mac Calendar APIs of Main's client-control `calendar` module. Access is
// granted by the user in the Agenda and macOS, so no op may ask for it.
var calendarOps = map[string]bool{
	"state":        true,
	"calendars":    true,
	"events":       true,
	"event":        true,
	"create-event": true,
	"update-event": true,
	"delete-event": true,
}

// calendarModule caches Main's answer to whether it serves the calendar module.
// Main's module set is fixed for the life of this child; a failed probe is retried.
type calendarModule struct {
	mu        sync.Mutex
	known     bool
	available bool
}

// methodCalendar forwards one Mac Calendar op to Main. The result is Main's
// JSON, including `{error: code}` results; nothing of it is logged here.
func (c *connector) methodCalendar(params map[string]any) (any, error) {
	if !c.cfg.deviceMode {
		return nil, errors.New("restart this Connector with --device to read the Mac Calendar")
	}
	op, _ := params["op"].(string)
	if !calendarOps[op] {
		return nil, errors.New("unknown calendar op")
	}
	input, ok := params["input"].(map[string]any)
	if !ok {
		input = map[string]any{}
	}
	endpoint, token := commaClientControl()
	if endpoint == "" || token == "" {
		return nil, errors.New("Comma Mac Calendar owner is unavailable")
	}
	body, err := json.Marshal(map[string]any{"module": "calendar", "api": op, "input": input})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	raw, err := commaClientResponse(ctx, http.MethodPost, endpoint+"/v1/invoke", token, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, errors.New("Comma Mac Calendar returned an invalid response")
	}
	return result, nil
}

// calendarAvailable reports whether Main exposes the calendar module.
func (c *connector) calendarAvailable() bool {
	if !c.cfg.deviceMode {
		return false
	}
	endpoint, token := commaClientControl()
	if endpoint == "" || token == "" {
		return false
	}
	module := &c.calendarModule
	module.mu.Lock()
	defer module.mu.Unlock()
	if module.known {
		return module.available
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := commaClientResponse(ctx, http.MethodGet, endpoint+"/v1/modules", token, nil)
	if err != nil {
		return false
	}
	var listed struct {
		Modules []struct {
			ID string `json:"id"`
		} `json:"modules"`
	}
	if json.Unmarshal(raw, &listed) != nil {
		return false
	}
	module.known = true
	for _, entry := range listed.Modules {
		if entry.ID == "calendar" {
			module.available = true
		}
	}
	return module.available
}

func commaClientControl() (string, string) {
	return strings.TrimRight(strings.TrimSpace(os.Getenv(commaClientControlURLEnv)), "/"),
		strings.TrimSpace(os.Getenv(commaClientControlTokenEnv))
}
