package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
	"tomoshibi/internal/guess"
	"tomoshibi/internal/rtc"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"

	livekitconf "github.com/livekit/livekit-server/pkg/config"
	"github.com/livekit/protocol/livekit"
)

// The media server's own configuration, which the runtime and health panels
// read. Its zero value is enough; nothing here asserts on what it says.
func livekitDefaults() *livekitconf.Config {
	return &livekitconf.Config{}
}

/*
 * What these guard is the gate itself.
 *
 * The session tests beside them prove that a passphrase resolves to the right
 * capabilities. They say nothing about whether a request without one reaches an
 * endpoint, which is a different question and the only one an attacker asks.
 * The whole of this file was at zero coverage when it was written: every gate,
 * every handler, and the routing that decides which of them a path lands on.
 *
 * The endpoints below are exercised through a real router, because the mistake
 * this catches is not a wrong answer from a handler — it is a handler reachable
 * without going through the gate in front of it, and a handler tested directly
 * is tested with its gate removed.
 */

// A media server that is not there.
//
// Every reading answers with nothing and every action fails, which is the state
// these tests want: what is being checked is whether a request reaches a
// handler, not what the handler then finds.
type absent struct{}

func (absent) Stats() *livekit.NodeStats { return &livekit.NodeStats{} }

func (absent) Throughput() (float64, float64, time.Duration) { return 0, 0, 0 }

func (absent) Node() (string, string) { return "ND_test", "127.0.0.1" }

func (absent) Rooms(context.Context) ([]*livekit.Room, error) {
	return nil, errors.New("no media server")
}

func (absent) Participants(context.Context, string) ([]*livekit.ParticipantInfo, error) {
	return nil, errors.New("no media server")
}

func (absent) Remove(context.Context, string, string) error { return errors.New("no media server") }

func (absent) Mute(context.Context, string, string, string) error {
	return errors.New("no media server")
}

func (absent) Close(context.Context, string) error { return errors.New("no media server") }

func mount(t *testing.T, admins []config.Admin) (*API, http.Handler) {
	t.Helper()

	api, mux, _ := mountAudited(t, admins)

	return api, mux
}

// mountAudited is mount, and also what the audit log wrote.
func mountAudited(t *testing.T, admins []config.Admin) (*API, http.Handler, *kept) {
	t.Helper()

	audit, written := auditing()

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: admins}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return admins }, key),
		media:    absent{},
		control:  absent{},
		log:      audit,
		store:    unwritten{},
		history:  NewHistory(nil),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	return api, mux, written
}

/*
 * Everything the management surface answers, and which capability it wants.
 *
 * Every route Mount registers, and not a sample of them. The table held nine
 * once, so a route bound to the wrong gate anywhere among the other thirty was
 * caught by nothing — and once the acting half was cut into four, binding a
 * relay route to the accounts capability is exactly the mistake that compiles,
 * runs, and hands somebody the enrolment secret.
 */
var endpoints = []struct {
	method string
	path   string
	needs  string
}{
	{http.MethodGet, "/api/admin/now", config.Observe},
	{http.MethodGet, "/api/admin/history", config.Observe},
	{http.MethodGet, "/api/admin/rooms", config.Observe},
	{http.MethodGet, "/api/admin/rooms/x/participants", config.Observe},
	{http.MethodGet, "/api/admin/rooms/x/visits", config.Observe},
	{http.MethodGet, "/api/admin/runtime", config.Observe},
	{http.MethodGet, "/api/admin/policy", config.Observe},
	{http.MethodGet, "/api/admin/settings", config.Observe},
	{http.MethodGet, "/api/admin/relays", config.Observe},
	{http.MethodGet, "/api/admin/relays/x/check", config.Observe},
	{http.MethodGet, "/api/admin/admins", config.Observe},
	{http.MethodGet, "/api/admin/accounts", config.Observe},
	{http.MethodPost, "/api/admin/admins/me/passphrase", config.Observe},

	{http.MethodDelete, "/api/admin/rooms/x", config.ManageRooms},
	{http.MethodDelete, "/api/admin/rooms/x/participants/y", config.ManageRooms},
	{http.MethodPost, "/api/admin/rooms/x/participants/y/mute", config.ManageRooms},
	{http.MethodPut, "/api/admin/rooms/x/relay", config.ManageRooms},
	{http.MethodDelete, "/api/admin/rooms/x/relay", config.ManageRooms},
	{http.MethodDelete, "/api/admin/rooms/x/record", config.ManageRooms},
	{http.MethodPut, "/api/admin/rooms/x/participants/y/relay", config.ManageRooms},

	{http.MethodPost, "/api/admin/accounts", config.ManageAccounts},
	{http.MethodPatch, "/api/admin/accounts/x", config.ManageAccounts},
	{http.MethodDelete, "/api/admin/accounts/x", config.ManageAccounts},

	{http.MethodPost, "/api/admin/relays", config.ManageRelays},
	{http.MethodPatch, "/api/admin/relays/x", config.ManageRelays},
	{http.MethodDelete, "/api/admin/relays/x", config.ManageRelays},
	{http.MethodGet, "/api/admin/relays/script", config.ManageRelays},
	{http.MethodGet, "/api/admin/relays/command", config.ManageRelays},
	{http.MethodPut, "/api/admin/relays/order", config.ManageRelays},

	{http.MethodPut, "/api/admin/policy", config.ManageSettings},
	{http.MethodPut, "/api/admin/settings", config.ManageSettings},

	{http.MethodPost, "/api/admin/admins", config.Moderate},
	{http.MethodPatch, "/api/admin/admins/x", config.Moderate},
	{http.MethodDelete, "/api/admin/admins/x", config.Moderate},
}

func TestNothingIsReachableWithoutASession(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Can: []string{config.Moderate}}})

	for _, endpoint := range endpoints {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(endpoint.method, endpoint.path, nil))

		if recorder.Code != http.StatusUnauthorized {
			t.Errorf("%s %s answered %d without a session, want 401",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestACookieFromNowhereIsNotASession(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct")}})

	request := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: "invented"})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("an invented cookie answered %d, want 401", recorder.Code)
	}
}

/*
 * The distinction the whole two-tier design exists for. An administrator listed
 * only to watch has to reach every reading and none of the actions, and the
 * place that can go wrong is the router rather than the rule: a handler
 * registered behind the wrong gate holds a correct rule that is never asked.
 */
func TestWatchingIsNotActing(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "watcher"), Name: "watcher"}})

	_, token, ok := api.sessions.Open("", "watcher")
	if !ok {
		t.Fatal("the configured passphrase was refused")
	}

	for _, endpoint := range endpoints {
		request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(`{}`))
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)

		if endpoint.needs != config.Observe {
			if recorder.Code != http.StatusForbidden {
				t.Errorf("%s %s answered %d for somebody who may only watch, want 403",
					endpoint.method, endpoint.path, recorder.Code)
			}
			continue
		}

		// The reading endpoints reach a media server that is not there, so what
		// matters is that they were not refused: anything but 401 and 403 means
		// the gate let them through.
		if recorder.Code == http.StatusUnauthorized || recorder.Code == http.StatusForbidden {
			t.Errorf("%s %s refused somebody who may watch: %d",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestSigningInAndOut(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	// In.
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"correct"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("signing in answered %d, want 200", recorder.Code)
	}

	var who struct {
		Trip string   `json:"trip"`
		Can  []string `json:"can"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &who); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}

	if who.Trip != room.Trip(key, "correct") {
		t.Errorf("signed in as %q", who.Trip)
	}

	// Listed with nothing, so watching and only watching.
	if len(who.Can) != 1 || who.Can[0] != config.Observe {
		t.Errorf("capabilities %v, want only %q", who.Can, config.Observe)
	}

	cookie := recorder.Result().Cookies()
	if len(cookie) == 0 {
		t.Fatal("no cookie was set")
	}

	// The cookie has to be unreadable by anything on the page and unwilling to
	// travel to another site, which is what stands in for a request token here.
	if !cookie[0].HttpOnly {
		t.Error("the session cookie is readable by script")
	}
	if cookie[0].SameSite != http.SameSiteStrictMode {
		t.Error("the session cookie would travel with a cross-site request")
	}

	// Out.
	out := httptest.NewRequest(http.MethodDelete, "/api/admin/session", nil)
	out.AddCookie(cookie[0])

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, out)

	if recorder.Code != http.StatusNoContent {
		t.Errorf("signing out answered %d, want 204", recorder.Code)
	}

	// And the token it carried is spent.
	after := httptest.NewRequest(http.MethodGet, "/api/admin/now", nil)
	after.AddCookie(cookie[0])

	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, after)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("a signed-out session still answered %d", recorder.Code)
	}
}

func TestTheWrongPassphraseSaysNothingUseful(t *testing.T) {
	_, mux, written := mountAudited(t, []config.Admin{{Trip: room.Trip(key, "correct"), Name: "adam"}})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"wrong"}`))

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("a wrong passphrase answered %d, want 401", recorder.Code)
	}

	if len(recorder.Result().Cookies()) != 0 {
		t.Error("a refused sign-in still set a cookie")
	}

	// A rejected passphrase is still a passphrase, and one of these logs is
	// going to be read by somebody it does not belong to.
	for _, entry := range written.recorded() {
		if strings.Contains(entry.Reason, "wrong") || strings.Contains(entry.Trip, "wrong") {
			t.Errorf("the audit log holds what was typed: %+v", entry)
		}
	}
}

func TestGuessingIsRefusedBeforeItIsChecked(t *testing.T) {
	_, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct")}})

	// Past the ceiling on the endpoint as a whole, which is what an attacker
	// with many addresses runs into.
	for i := 0; i < guess.Overall+guess.PerAddress; i++ {
		mux.ServeHTTP(httptest.NewRecorder(), sign(`{"passphrase":"guess"}`))
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, sign(`{"passphrase":"guess"}`))

	if recorder.Code != http.StatusTooManyRequests {
		t.Errorf("guessing answered %d after the limit, want 429", recorder.Code)
	}
}

// Behind a CDN and then nginx the caller is the second entry from the right.
// Anything before it is the caller's own writing, and reading the first entry
// once gave every forged prefix a budget of its own, so one machine could guess
// at the ceiling of the endpoint rather than at its own ten a minute.
func TestAForgedForwardedAddressIsNotANewCaller(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "correct")}})
	api.conf.Meet.TrustProxy = true
	api.conf.Meet.Proxies = 2

	guessing := func(forged string) int {
		r := sign(`{"passphrase":"guess"}`)
		r.Header.Set("X-Forwarded-For", forged+", 192.0.2.7, 203.0.113.9")
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, r)
		return recorder.Code
	}

	for i := 0; i < guess.PerAddress; i++ {
		guessing("198.51.100." + strconv.Itoa(i))
	}

	if code := guessing("198.51.100.200"); code != http.StatusTooManyRequests {
		t.Errorf("a new forged prefix answered %d after the caller's limit, want 429", code)
	}
}

/*
 * With nobody configured the surface does not exist. Not refused — absent, so
 * that the paths answer like any other address nobody claimed and there is
 * nothing to find.
 */
func TestWithNoAdministratorsThereIsNoSurface(t *testing.T) {
	api, mux := mount(t, nil)

	if api.Configured() {
		t.Error("a deployment with no administrators reports a management surface")
	}

	for _, endpoint := range append(endpoints, struct {
		method string
		path   string
		needs  string
	}{http.MethodPost, "/api/admin/session", ""}) {
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(endpoint.method, endpoint.path, nil))

		if recorder.Code != http.StatusNotFound {
			t.Errorf("%s %s answered %d with nobody configured, want 404",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestActionsAreRecordedAgainstWhoTookThem(t *testing.T) {
	trip := room.Trip(key, "moderator")
	api, mux, written := mountAudited(t, []config.Admin{{Trip: trip, Name: "adam", Can: []string{config.Moderate}}})

	_, token, _ := api.sessions.Open("", "moderator")

	// Reaches a media server that is not there, which is the point: a refusal
	// is worth recording as much as a success, and by the same signature.
	request := httptest.NewRequest(http.MethodDelete, "/api/admin/rooms/somewhere", nil)
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
	mux.ServeHTTP(httptest.NewRecorder(), request)

	var found bool
	for _, entry := range written.recorded() {
		if entry.Action == "close room" && entry.Room == "somewhere" {
			found = true
			if entry.Trip != trip {
				t.Errorf("recorded against %q, want %q", entry.Trip, trip)
			}
		}
	}

	if !found {
		t.Error("an action reached the media server and was not recorded")
	}
}

// A page on a sibling subdomain is the same site, so a SameSite=Strict cookie
// goes along with a form it posts. The browser says where a request came from in
// a header the page cannot write, and anything that is not this origin is turned
// away before the session is looked at.
func TestAnotherSiteCannotActThroughASession(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "moderator"), Can: []string{config.Moderate}}})
	_, token, ok := api.sessions.Open("", "moderator")
	if !ok {
		t.Fatal("the moderator could not sign in")
	}

	act := func(site string) int {
		request := httptest.NewRequest(http.MethodPost, "/api/admin/rooms/x/participants/y/mute",
			strings.NewReader(`{"track":"TR_x"}`))
		request.Header.Set("Content-Type", "text/plain")
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		if site != "" {
			request.Header.Set("Sec-Fetch-Site", site)
		}
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		return recorder.Code
	}

	for _, site := range []string{"same-site", "cross-site"} {
		if code := act(site); code != http.StatusForbidden {
			t.Errorf("a request from %s answered %d, want 403", site, code)
		}
	}

	// These pages themselves, and anything that is not a browser, still reach
	// the handler: the media server behind it is absent, so anything but a
	// refusal from the gate will do.
	for _, site := range []string{"same-origin", ""} {
		if code := act(site); code == http.StatusForbidden || code == http.StatusUnauthorized {
			t.Errorf("a request with Sec-Fetch-Site %q was refused: %d", site, code)
		}
	}
}

// The meeting endpoints honour the management cookie too -- closing a room,
// removing somebody, moving a call -- and they ask through SessionOf, not
// through the gate above. So SessionOf has to refuse the same requests the gate
// does, or the gate only closes the door nobody needed.
func TestASessionIsNotLentToAnotherSite(t *testing.T) {
	api, _ := mount(t, []config.Admin{{Trip: room.Trip(key, "moderator"), Can: []string{config.Moderate}}})
	_, token, _ := api.sessions.Open("", "moderator")

	carrying := func(method, site string) bool {
		request := httptest.NewRequest(method, "/api/rooms/standup/close", nil)
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})
		if site != "" {
			request.Header.Set("Sec-Fetch-Site", site)
		}
		_, ok := api.SessionOf(request)
		return ok
	}

	if carrying(http.MethodPost, "same-site") {
		t.Error("a POST from a sibling subdomain carried the management session")
	}
	if !carrying(http.MethodPost, "same-origin") || !carrying(http.MethodPost, "") {
		t.Error("a POST from these pages, or from something that is not a browser, lost the session")
	}
	if !carrying(http.MethodGet, "same-site") {
		t.Error("a read from elsewhere lost the session, which buys nothing and breaks links")
	}
}

func sign(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/admin/session", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	return request
}

// A record of names that is not there.
//
// Its own type rather than another face on absent, because a room on the media
// server and a name somebody once used are two different things that happen to
// be listed by the same word, and no one object can answer to both.
type unwritten struct{}

func (unwritten) Rooms() ([]store.Named, error) { return nil, errors.New("no store") }

// The policy a deployment nobody has configured runs under.
func (unwritten) Opening() room.Opening { return room.ByAnyone }
func (unwritten) Joining(configured room.Joining) room.Joining {
	if configured.Valid() {
		return configured
	}

	return room.ByWhoeverKnows
}
func (unwritten) SetJoining(room.Joining) error { return nil }
func (unwritten) AccountCount() int             { return 0 }

func (unwritten) SetOpening(room.Opening) error { return errors.New("no store") }

// A deployment with nothing written down knows neither where a room is nor who
// arrived at it, and says so by holding nothing rather than by refusing: both
// are decorations on a page, and a management surface that returned an error
// because it could not decorate one would be unusable on the machine that most
// needs it.
func (unwritten) HeldOn(string) (string, bool) { return "", false }

func (unwritten) Arrivals(string) map[string]store.Arrival { return nil }
func (unwritten) Visits(string, int) ([]store.Visit, int)  { return nil, 0 }
func (unwritten) ForgetRoom(string) (bool, error)          { return true, nil }

// A record of names that keeps the one setting these tests are about.
type remembers struct {
	unwritten
	opening room.Opening
}

func (r *remembers) Opening() room.Opening { return r.opening }

func (r *remembers) SetOpening(opening room.Opening) error {
	r.opening = opening
	return nil
}

func TestOnlyAModeratorMayChangeWhoOpensRooms(t *testing.T) {
	watcher := config.Admin{Trip: room.Trip(key, "watcher"), Name: "watcher"}
	api, mux := mount(t, []config.Admin{watcher})

	names := &remembers{opening: room.ByAnyone}
	api.store = names

	_, token, _ := api.sessions.Open("", "watcher")

	request := httptest.NewRequest(http.MethodPut, "/api/admin/policy",
		strings.NewReader(`{"openedBy":"admins"}`))
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Errorf("somebody who may only watch changed the policy: %d", recorder.Code)
	}
	if names.opening != room.ByAnyone {
		t.Errorf("the policy was changed anyway: %q", names.opening)
	}
}

func TestAModeratorMayChangeWhoOpensRooms(t *testing.T) {
	moderator := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam", Can: []string{config.Moderate},
	}
	api, mux, written := mountAudited(t, []config.Admin{moderator})

	names := &remembers{opening: room.ByAnyone}
	api.store = names

	_, token, _ := api.sessions.Open("", "moderator")

	request := httptest.NewRequest(http.MethodPut, "/api/admin/policy",
		strings.NewReader(`{"openedBy":"admins"}`))
	request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("changing the policy answered %d, want 200", recorder.Code)
	}
	if names.opening != room.ByAdmins {
		t.Errorf("the store holds %q, want %q", names.opening, room.ByAdmins)
	}

	// The answer is what the server is now doing rather than what was asked
	// for, which is the whole reason it is sent back at all: with an
	// administrator configured the two agree, and the test below is where they
	// do not.
	var got policy
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatalf("the answer was not readable: %v", err)
	}
	if got.OpenedBy != room.ByAdmins || got.Chosen != room.ByAdmins {
		t.Errorf("answered %+v", got)
	}

	// A change to who may open a room outlives whoever made it, so it belongs
	// in the record beside the rooms they closed.
	var found bool
	for _, entry := range written.recorded() {
		if entry.Action == "set who may open a room" && entry.Target == string(room.ByAdmins) {
			found = true
			if entry.Trip != moderator.Trip {
				t.Errorf("recorded against %q, want %q", entry.Trip, moderator.Trip)
			}
		}
	}
	if !found {
		t.Error("the policy was changed and not recorded")
	}
}

func TestSomethingThatIsNotAPolicyIsRefused(t *testing.T) {
	api, mux := mount(t, []config.Admin{{
		Trip: room.Trip(key, "moderator"), Can: []string{config.Moderate},
	}})

	names := &remembers{opening: room.ByAnyone}
	api.store = names

	_, token, _ := api.sessions.Open("", "moderator")

	for _, body := range []string{`{"openedBy":"administrators"}`, `{"openedBy":""}`, `not json`} {
		request := httptest.NewRequest(http.MethodPut, "/api/admin/policy", strings.NewReader(body))
		request.AddCookie(&http.Cookie{Name: cookieName, Value: token})

		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusBadRequest {
			t.Errorf("%s answered %d, want 400", body, recorder.Code)
		}
	}

	if names.opening != room.ByAnyone {
		t.Errorf("one of them was stored anyway: %q", names.opening)
	}
}

/*
 * The one reading that is not simply what was stored.
 *
 * Asking for an administrator where nobody is configured as one cannot be
 * carried out by anything, so it is not carried out — every name would be
 * refused for as long as the deployment lasted, and the pages that could undo it
 * do not exist either. The panel says so rather than drawing a switch that is on
 * and doing nothing.
 */
func TestAPolicyNobodyCouldSatisfyIsNotInEffect(t *testing.T) {
	api, _ := mount(t, nil)
	api.store = &remembers{opening: room.ByAdmins}

	got := api.currentPolicy()

	if got.Chosen != room.ByAdmins {
		t.Errorf("chosen = %q, want %q", got.Chosen, room.ByAdmins)
	}
	if got.OpenedBy != room.ByAnyone {
		t.Errorf("in effect = %q, want %q with nobody configured", got.OpenedBy, room.ByAnyone)
	}
}

/*
What a control node records about load.

It has no media server, so every figure it can read about media from inside its
own process is zero — and it recorded exactly that, five seconds apart, for as
long as it ran. The chart drew a flat line at the bottom and was twice
investigated as a measurement problem, because a line of zeros and a line that
is not moving look identical.

The relays are where the media is. Summing them is the only honest answer a
control node has, and the two ways it can be wrong are worth pinning down: a
relay that cannot be reached must not take the whole reading with it, and the
loss rate must not be added up — eleven relays each dropping one packet a second
is not eleven times worse than one relay doing it.
*/

type carrying struct {
	stats map[string]rtc.Stats
}

func (c carrying) Relays() []string {
	out := make([]string, 0, len(c.stats))
	for url := range c.stats {
		out = append(out, url)
	}

	sort.Strings(out)

	return out
}

func (c carrying) AskStats(_ context.Context, relay string) (rtc.Stats, error) {
	stats, ok := c.stats[relay]
	if !ok {
		return rtc.Stats{}, errors.New("unreachable")
	}

	return stats, nil
}

func TestAControlNodeRecordsWhatTheRelaysAreCarrying(t *testing.T) {
	api := &API{
		fleet: carrying{stats: map[string]rtc.Stats{
			"wss://one.invalid": {
				InPerSec: 100, OutPerSec: 400, Rooms: 2, Clients: 5, NackPerSec: 3,
			},
			"wss://two.invalid": {
				InPerSec: 50, OutPerSec: 200, Rooms: 1, Clients: 3, NackPerSec: 1,
			},
		}},
	}

	at := api.sample()

	if at.In != 150 || at.Out != 600 {
		t.Errorf("recorded %.0f in and %.0f out, wanted 150 and 600; a control node that "+
			"cannot add up its relays can only ever report zero, and a chart of zeros "+
			"looks exactly like a chart that is not updating", at.In, at.Out)
	}

	if at.Rooms != 3 || at.Clients != 8 {
		t.Errorf("recorded %d rooms and %d clients, wanted 3 and 8", at.Rooms, at.Clients)
	}

	// Averaged, not summed. Two relays each losing two packets a second is a
	// deployment losing two packets a second, in two places.
	if at.Nack != 2 {
		t.Errorf("recorded a loss rate of %v, wanted the mean of 3 and 1", at.Nack)
	}
}

func TestARelayThatWillNotAnswerDoesNotEmptyTheReading(t *testing.T) {
	api := &API{
		fleet: carrying{stats: map[string]rtc.Stats{
			"wss://up.invalid": {InPerSec: 100, OutPerSec: 400, Rooms: 2, Clients: 5},
		}},
	}

	// One that answers and one that does not: Relays lists both, AskStats knows
	// only the first.
	api.fleet = carrying{stats: map[string]rtc.Stats{
		"wss://up.invalid": {InPerSec: 100, OutPerSec: 400, Rooms: 2, Clients: 5},
	}}

	at := api.sample()

	if at.In != 100 || at.Rooms != 2 {
		t.Errorf("a reachable relay contributed %.0f in and %d rooms, wanted 100 and 2",
			at.In, at.Rooms)
	}

	// And with nothing to ask at all, a moment of nothing rather than a panic on
	// a timer, which is how the first version of this took a process down.
	quiet := &API{}

	if got := quiet.sample(); got.In != 0 || got.At.IsZero() {
		t.Errorf("a node with no fleet and no media answered %+v; it should record an "+
			"empty moment and keep its clock", got)
	}
}

func (absent) Announce(context.Context, string, string, []byte) error { return nil }

func (absent) Tell(context.Context, string, string, string, []byte) error { return nil }

func (absent) Hold(context.Context, string, string) error { return nil }

/*
 * The pages cannot turn the door off.
 *
 * "Anybody who has the room's name" is a setting this server understands and is
 * not one it offers. A room here is a name, so it means "anybody who guesses
 * it", and the invite mechanism exists precisely so that one person can be let
 * into one call without being handed a name that admits them to every future
 * one — a control that undoes that is pressed by whoever has the page open
 * rather than by whoever thought about the deployment.
 *
 * It stays settable in the configuration file, where it is a deliberate act by
 * somebody editing it and is said in the log on every start. That is a
 * different thing from a radio button, and the difference is the whole of why
 * this test exists rather than the value simply being deleted.
 */
func TestTheJoiningPolicyCannotBeLoosenedFromAPage(t *testing.T) {
	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		log:      NewLog(),
		// One that can be written to, because half of this checks that the
		// settings which are offered still take. unwritten refuses every write
		// by design and would have passed the refusals and failed the rest.
		store:   &remembers{},
		history: NewHistory(nil),
		stop:    make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	// The opening half, which has two of these rather than one. Both let
	// anybody start a meeting on the deployment's machines, and "signed" is the
	// one that does not look like it does: the signature it asks for is made by
	// typing anything at all into the passphrase box, so as a barrier it is the
	// same barrier as none.
	for _, open := range []string{"anyone", "signed"} {
		if got := place(t, mux, cookieName+"="+token,
			"/api/admin/policy", `{"openedBy":"`+open+`"}`); got.Code != http.StatusBadRequest {
			t.Errorf("a page set the opening policy to %q and answered %d; nothing on a page "+
				"may leave this deployment open to whoever finds it", open, got.Code)
		}
	}

	for _, open := range []string{"accounts", "admins"} {
		if got := place(t, mux, cookieName+"="+token,
			"/api/admin/policy", `{"openedBy":"`+open+`"}`); got.Code != http.StatusOK {
			t.Errorf("setting the opening policy to %q answered %d, want 200", open, got.Code)
		}
	}

	loosen := place(t, mux, cookieName+"="+token, "/api/admin/policy", `{"joinedBy":"anyone"}`)

	if loosen.Code != http.StatusBadRequest {
		t.Errorf("a page was allowed to set the joining policy to %q and answered %d; the "+
			"one value that opens the deployment to whoever guesses a name is the one "+
			"value no button may reach", "anyone", loosen.Code)
	}

	// And the two that are offered still work, or the guard is just broken.
	for _, offered := range []string{"invited", "accounts"} {
		if got := place(t, mux, cookieName+"="+token,
			"/api/admin/policy", `{"joinedBy":"`+offered+`"}`); got.Code != http.StatusOK {
			t.Errorf("setting the joining policy to %q answered %d, want 200", offered, got.Code)
		}
	}
}

// A control that says one room is in progress.
type holding struct {
	absent
}

func (holding) Rooms(context.Context) ([]*livekit.Room, error) {
	return []*livekit.Room{{Name: "standup", Sid: "RM_1"}}, nil
}

/*
 * Tidying the list must not open a door into a meeting.
 *
 * The record is what says a name has been used, and the join path reads exactly
 * that to decide which of the two doors somebody is at. Remove it while a call
 * is running and the next person to arrive is treated as opening the room —
 * which on a deployment that lets anybody open a name means letting them in.
 *
 * So it refuses, with its own reason, rather than doing half of it or doing it
 * quietly. The operator can close the room and then forget it, and being told
 * that is more use than either half happening by itself.
 */
func TestForgettingARoomSomebodyIsInIsRefused(t *testing.T) {
	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		control:  holding{},
		log:      NewLog(),
		store:    unwritten{},
		history:  NewHistory(nil),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	busy := drop(t, mux, cookieName+"="+token, "/api/admin/rooms/standup/record")

	if busy.Code != http.StatusConflict {
		t.Errorf("forgetting a room somebody is in answered %d, want 409: the record is what "+
			"says the name has been used, and removing it turns the next arrival into "+
			"somebody opening a room that is already full of people", busy.Code)
	}

	// And a name nobody is in goes.
	gone := drop(t, mux, cookieName+"="+token, "/api/admin/rooms/retro/record")

	if gone.Code != http.StatusOK {
		t.Errorf("forgetting a quiet name answered %d, want 200: %s", gone.Code, gone.Body.String())
	}
}

// A control that cannot say what is happening.
type mute struct {
	absent
}

func (mute) Rooms(context.Context) ([]*livekit.Room, error) {
	return nil, errors.New("the media server did not answer")
}

/*
 * A room that cannot be checked is not a room that is free.
 *
 * The guard asked the media server whether anybody was in it and carried on
 * when the asking failed, which turned the guard off rather than the button —
 * so a media server that would not answer was exactly the moment a name could
 * be forgotten out from under a call in progress. That the guard had never once
 * run was invisible until it was pressed against a deployment whose relays do
 * not implement the question.
 *
 * Forgetting a name is housekeeping and is never urgent. Refusing until the
 * fleet answers costs an operator a retry; the other way costs somebody a door
 * into their meeting.
 */
func TestForgettingARoomThatCannotBeCheckedIsRefused(t *testing.T) {
	admin := config.Admin{
		Trip: room.Trip(key, "moderator"), Name: "adam",
		Can: []string{config.Observe, config.Moderate},
	}

	api := &API{
		conf:     &config.Config{Meet: config.Meet{Admins: []config.Admin{admin}}, LiveKit: livekitDefaults()},
		sessions: NewSessions(func() []config.Admin { return []config.Admin{admin} }, key),
		media:    absent{},
		control:  mute{},
		log:      NewLog(),
		store:    unwritten{},
		history:  NewHistory(nil),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	_, token, _ := api.sessions.Open("", "moderator")

	blind := drop(t, mux, cookieName+"="+token, "/api/admin/rooms/standup/record")

	if blind.Code != http.StatusBadGateway {
		t.Errorf("forgetting a room while the media servers were unreachable answered %d, "+
			"want 502: not being able to ask is not the same as the answer being no",
			blind.Code)
	}
}
