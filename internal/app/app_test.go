package app

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/limit"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * Who may open a room, at the one place anybody ever asks for one.
 *
 * There is no endpoint that creates a room, because there is no room to create.
 * A name is opened by being joined, which means this rule has exactly one place
 * to live and no second path around it — and it also means the rule cannot be
 * read anywhere but here, from a request that looks like every other join.
 *
 * The whole application is not stood up. The join handler reaches the
 * configuration, the store, the rate limiter and the signing key, and none of
 * the rest; a media server started to exercise a rule it has no part in would be
 * the reason this went untested.
 */

// The key that signs signatures. Any bytes will do — what matters is that the
// same ones are used to derive the administrator's trip below, exactly as a
// deployment derives it once and writes it into the configuration.
var tripKey = []byte("a key for the tests and nowhere else")

const passphrase = "the administrator's passphrase"

// Where the code running here can be read, which the licence obliges this to
// offer to whoever is using it over a network.
const source = "https://example.invalid/source"

func mount(t *testing.T, admins []config.Admin) (*App, http.Handler) {
	t.Helper()

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	app := &App{
		conf: &config.Config{
			Key:    "APIkey",
			Secret: "a secret long enough for the media server to accept it",
			Meet: config.Meet{
				TokenTTL:  5 * time.Minute,
				JoinRate:  1000,
				JoinBurst: 1000,
				Admins:    admins,
				SourceURL: source,
			},
		},
		store:   st,
		limit:   limit.New(1000, 1000, 0),
		tripKey: tripKey,
	}

	// The two routes the join rule lives behind, written the way Handler writes
	// them: the room name arrives as a path value, and a handler called directly
	// would not have one.
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/rooms/{room}/join", app.join)
	mux.HandleFunc("GET /api/deployment", app.deployment)

	return app, mux
}

func administrator() config.Admin {
	return config.Admin{Trip: room.Trip(tripKey, passphrase), Name: "adam"}
}

// join asks for a room, with a passphrase or without one.
func join(name, said string) *http.Request {
	body := fmt.Sprintf(`{"name":"somebody","passphrase":%q}`, said)

	request := httptest.NewRequest(http.MethodPost, "/api/rooms/"+name+"/join",
		strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}

func ask(mux http.Handler, request *http.Request) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

// What every deployment does until somebody changes it.
func TestByDefaultAnybodyMayOpenARoom(t *testing.T) {
	_, mux := mount(t, nil)

	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("joining an unused name answered %d, want 200", code)
	}
}

func TestUnderAdminsAnUnusedNameIsRefused(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	recorder := ask(mux, join("standup", ""))

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("an unused name answered %d, want 403", recorder.Code)
	}

	var refusal struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &refusal); err != nil {
		t.Fatalf("the refusal was not readable: %v", err)
	}
	if refusal.Error != reasonNotOpen {
		t.Errorf("refused with %q, want %q", refusal.Error, reasonNotOpen)
	}
}

// The signature the token was going to carry anyway, finally being looked at.
func TestUnderAdminsAnAdministratorOpensOne(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("standup", passphrase)).Code; code != http.StatusOK {
		t.Fatalf("an administrator was refused an unused name: %d", code)
	}

	// And having been opened, it is open to whoever comes next. This is the
	// difference between a policy about opening rooms and a policy about
	// joining them, and getting it wrong would put the second half of a meeting
	// outside while the first half is still in it.
	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("somebody was refused a room that was already open: %d", code)
	}
}

// A passphrase that is somebody's and not an administrator's proves a name and
// nothing else. It is the ordinary case, and the one where a comparison written
// slightly wrong would open every door.
func TestAPassphraseThatIsNotAnAdministratorsOpensNothing(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	for i, said := range []string{
		"some other passphrase",
		passphrase[:len(passphrase)-1], // one character short
		"",
		passphrase + " ", // trimmed before signing, so this one is the right one
	} {
		want := http.StatusForbidden
		if strings.TrimSpace(said) == passphrase {
			want = http.StatusOK
		}

		// A name of its own each time. Sharing one would mean the first
		// administrator through opened it for everybody after, and every
		// refusal that followed would be a pass.
		name := fmt.Sprintf("standup-%d", i)
		if code := ask(mux, join(name, said)).Code; code != want {
			t.Errorf("%q answered %d, want %d", said, code, want)
		}
	}
}

/*
 * A policy nobody could satisfy is not applied.
 *
 * Reachable only by editing a configuration file to remove the administrators
 * while the store still holds the stricter setting — at which point the pages
 * that could put it back have stopped existing too. Enforced literally, every
 * name nobody had used would be refused for the life of the deployment, and the
 * only clue would be people saying their meeting link does not work.
 */
func TestWithNobodyToOpenARoomAnybodyMay(t *testing.T) {
	app, mux := mount(t, nil)

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("standup", "")).Code; code != http.StatusOK {
		t.Errorf("a policy nobody could satisfy refused a join: %d", code)
	}
}

/*
 * What the client is told, and what it is not.
 *
 * It needs the policy to say the right thing on the screen where a room name is
 * typed, and it needs somewhere to read the source, which the licence obliges
 * this to offer whoever is using it over a network. It is never told whether the
 * person at that screen is an administrator, because answering that would be a
 * way to test a guessed passphrase — an unauthenticated one, quicker than the
 * sign-in page that is rate limited for exactly this reason.
 */
func TestWhatTheClientIsToldAboutTheDeployment(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/deployment", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("the deployment answered %d, want 200", recorder.Code)
	}

	var said map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if said["openedBy"] != string(room.ByAdmins) {
		t.Errorf("openedBy = %v, want %q", said["openedBy"], room.ByAdmins)
	}
	if said["source"] != source {
		t.Errorf("source = %v, want %q", said["source"], source)
	}

	// The joining policy, which is worth the one thing it gives away.
	//
	// The page has to say what is true of this deployment. It was telling
	// everybody "anybody can join one that already exists", which had been true
	// everywhere until there was a setting that made it false — and it went on
	// saying so to people who were about to be turned away with no idea what
	// would have worked.
	//
	// What it tells somebody probing is whether guessing names is worth their
	// time, and they learn that from their first attempt anyway: a refusal comes
	// back as not_invited. One request against a sentence every visitor reads is
	// a trade worth making, and it is the only one on this endpoint that is.
	if said["joinedBy"] != string(room.ByWhoeverKnows) {
		t.Errorf("joinedBy = %v, want %q", said["joinedBy"], room.ByWhoeverKnows)
	}

	// Nothing else. Anything added here is said to everybody who loads the page,
	// including whoever is working out what this server will admit.
	if len(said) != 3 {
		t.Errorf("the deployment says more about itself than it was asked: %v", said)
	}
}

// A name the server would never accept is refused before any of this, so a
// misspelling cannot be mistaken for a room somebody is being kept out of.
func TestAnImpossibleNameIsStillJustAnImpossibleName(t *testing.T) {
	app, mux := mount(t, []config.Admin{administrator()})

	if err := app.store.SetOpening(room.ByAdmins); err != nil {
		t.Fatalf("SetOpening: %v", err)
	}

	if code := ask(mux, join("stand_up", "")).Code; code != http.StatusBadRequest {
		t.Errorf("an invalid name answered %d, want 400", code)
	}
}

// A page compares the build it was loaded from with the one the server says it
// is now, and offers a reload when they differ. So the build has to be said,
// and it has to be left out where it is not known -- a development server built
// outside a repository would otherwise tell every open page that it is out of
// date, every time it restarted.
func TestTheDeploymentSaysWhichBuildItIs(t *testing.T) {
	_, mux := mount(t, []config.Admin{administrator()})
	read := func() map[string]any {
		var said map[string]any
		recorder := ask(mux, httptest.NewRequest(http.MethodGet, "/api/deployment", nil))
		if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
			t.Fatalf("the answer was not readable: %v", err)
		}
		return said
	}

	was := buildID
	t.Cleanup(func() { buildID = was })

	buildID = "4576c38bc551d8bb1a6abee1490b3fe8b61b417f"
	if got := read()["build"]; got != buildID {
		t.Errorf("build = %v, want %q", got, buildID)
	}

	buildID = ""
	if got, present := read()["build"]; present {
		t.Errorf("an unknown build was sent as %v rather than left out", got)
	}
}
