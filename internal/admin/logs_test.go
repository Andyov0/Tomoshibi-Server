package admin

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/logring"
	"tomoshibi/internal/room"
)

/*
The log page, which has to open when the rest of the server will not.

The owner asked for the log because the pages it replaces would not open when
something went wrong (2026-08-20). So the test is the failing server: a store
that answers every question with an error and no media server at all, which is
what mount builds, and the log still has to answer — through the router and
behind the session, since a handler tested directly is a handler with its gate
removed. A handler that touched the store for anything would answer a 500 here.
*/
func TestTheLogAnswersWhileTheStoreAndMediaAreDown(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "observer"), Can: []string{config.Observe}}})

	ring := logring.New(10)
	api.ring = ring
	logged := slog.New(ring.Handler(slog.NewTextHandler(io.Discard, nil)))
	logged.Error("the store did not answer", "error", "timeout")
	logged.Warn("a relay did not answer", "relay", "hk")

	if recorder := call(mux, http.MethodGet, "/api/admin/log", nil, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("without a session the log answered %d", recorder.Code)
	}

	cookie := signIn(t, api, "observer")

	recorder := call(mux, http.MethodGet, "/api/admin/log", cookie, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("the log answered %d: %s", recorder.Code, recorder.Body.String())
	}

	var said struct {
		Lines []logring.Line `json:"lines"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(said.Lines) != 2 || said.Lines[0].Level != "error" || said.Lines[1].Message != "a relay did not answer" {
		t.Fatalf("the log said %+v", said.Lines)
	}

	// And only what came after the last line the page has.
	recorder = call(mux, http.MethodGet, "/api/admin/log?after=1", cookie, "")
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(said.Lines) != 1 || said.Lines[0].Seq != 2 {
		t.Errorf("after the first line the log said %+v", said.Lines)
	}
}

// A shelf that offers a Mac build and nothing else.
type macOnly struct{}

func (macOnly) Offered() ([]Offered, bool) {
	return []Offered{{Platform: "mac", Version: "1.2.0", Available: true, Size: 84}, {Platform: "ios"}}, true
}

func TestTheAppsPageIsToldWhatIsOffered(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "observer"), Can: []string{config.Observe}}})
	cookie := signIn(t, api, "observer")

	var said struct {
		Configured bool      `json:"configured"`
		Platforms  []Offered `json:"platforms"`
	}

	recorder := call(mux, http.MethodGet, "/api/admin/apps", cookie, "")
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil || recorder.Code != http.StatusOK {
		t.Fatalf("with no shelf: %d %s", recorder.Code, recorder.Body.String())
	}
	if said.Configured || len(said.Platforms) != 0 {
		t.Errorf("with no shelf the page was told %+v", said)
	}

	api.UseShelf(macOnly{})

	recorder = call(mux, http.MethodGet, "/api/admin/apps", cookie, "")
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !said.Configured || len(said.Platforms) != 2 || said.Platforms[0].Version != "1.2.0" || said.Platforms[1].Available {
		t.Errorf("the page was told %+v", said)
	}
}
