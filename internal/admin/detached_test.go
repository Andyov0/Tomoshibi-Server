package admin

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
)

/*
A control node has no media server, and these pages are entirely about one.

Every endpoint below dereferenced it unconditionally until a test stood one up
without one and watched the process panic. That is the shape of this fault: not
a wrong answer but a crash, on a machine whose whole job is to keep serving the
page while the media happens elsewhere, and reachable by an administrator doing
nothing more unusual than opening the dashboard.

So these ask for a management surface with no media behind it and require an
answer rather than a fall. 503 and not 404: the endpoint exists and the
deployment is configured for it, and what is absent is the thing it reports on.
*/

// detachedAPI builds the management surface a control node has: administrators
// configured, no media server, no room control.
func detachedAPI(t *testing.T) http.Handler {
	t.Helper()

	key := make([]byte, 32)
	trip := room.Trip(key, "a passphrase nobody else has")

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:   config.RoleControl,
			Admins: []config.Admin{{Trip: trip, Name: "adam", Can: []string{config.Moderate}}},
		},
	}

	// nil media, which is what New receives on a control node.
	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	if api.attached() {
		t.Fatal("an API built with no media server reported one; a nil pointer in an " +
			"interface field is not a nil interface, and every guard downstream would pass")
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	return mux
}

func TestManagementSurvivesHavingNoMediaServer(t *testing.T) {
	mux := detachedAPI(t)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/health"},
		{http.MethodGet, "/api/admin/rooms"},
		{http.MethodGet, "/api/admin/rooms/standup/participants"},
		{http.MethodGet, "/api/admin/runtime"},
		{http.MethodDelete, "/api/admin/rooms/standup"},
		{http.MethodDelete, "/api/admin/rooms/standup/participants/somebody"},
		{http.MethodPost, "/api/admin/rooms/standup/participants/somebody/mute"},
	} {
		func() {
			// A panic here is the fault this file exists for, and it would
			// otherwise take the whole test binary down with it rather than
			// naming the endpoint that did it.
			defer func() {
				if fell := recover(); fell != nil {
					t.Errorf("%s %s panicked with no media server: %v", tc.method, tc.path, fell)
				}
			}()

			request := httptest.NewRequest(tc.method, tc.path, nil)
			recorder := httptest.NewRecorder()

			mux.ServeHTTP(recorder, request)

			// Unauthenticated, so the gate answers first: the point here is
			// only that nothing fell over on the way to it.
			if recorder.Code == 0 {
				t.Errorf("%s %s answered nothing at all", tc.method, tc.path)
			}
		}()
	}
}

// A control node that can reach relays still has no media server of its own.
//
// This is the state a real one is in a moment after starting: New leaves the
// control interface nil, and the cluster is attached immediately afterwards.
// The first version of this file tested only the state before that, so the
// sampler's guard was written against the wrong question — attached rather than
// local — and passed. In production it dereferenced a nil media server one
// second after start, on a timer, and the crash arrived detached from anything
// anybody had done.
//
// The distinction is real and worth keeping: with a cluster this node can list
// rooms and remove somebody from one, and it still cannot report its own
// throughput, because those counters are read from the process holding them.
func TestSamplingIsHarmlessOnceACusterIsAttached(t *testing.T) {
	key := make([]byte, 32)

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:   config.RoleControl,
			Admins: []config.Admin{{Trip: room.Trip(key, "a passphrase"), Name: "adam"}},
		},
	}

	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	// What a control node does at startup, right after New.
	api.UseCluster(rtc.NewCluster(func() []string { return []string{"wss://relay.invalid"} },
		conf.Key, conf.Secret))

	if !api.attached() {
		t.Fatal("a cluster was attached and the pages still report nothing to ask")
	}

	if api.local() {
		t.Fatal("a control node reported a media server of its own; every figure read from " +
			"one would be a nil dereference")
	}

	defer func() {
		if fell := recover(); fell != nil {
			t.Fatalf("sampling panicked on a control node with a cluster: %v", fell)
		}
	}()

	if got := api.sample(); got.In != 0 || got.Out != 0 {
		t.Errorf("a node with no media server of its own reported %+v", got)
	}
}

// The sampler runs on a timer and nobody is watching it. Left unguarded it
// would take the process down some seconds after a control node started, which
// is far enough from the cause to be read as a crash on startup.
func TestSamplingWithNoMediaServerIsHarmless(t *testing.T) {
	key := make([]byte, 32)

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "a secret long enough for the media server to accept it",
		Meet: config.Meet{
			Role:   config.RoleControl,
			Admins: []config.Admin{{Trip: room.Trip(key, "a passphrase"), Name: "adam"}},
		},
	}

	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	defer func() {
		if fell := recover(); fell != nil {
			t.Fatalf("sampling panicked with no media server: %v", fell)
		}
	}()

	got := api.sample()

	if got.In != 0 || got.Out != 0 || got.Rooms != 0 || got.Clients != 0 {
		t.Errorf("a node with no media server reported %+v; it can know none of this", got)
	}

	if got.At.IsZero() {
		t.Error("the sample carries no time, so a trend would not be able to place it")
	}
}
