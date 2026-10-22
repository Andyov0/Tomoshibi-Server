package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
 * The acting half of the management pages, cut along what it acts on.
 *
 * What these guard is that each door asks for what it says it asks for, from
 * the administrator as they are now rather than as they were when they signed
 * in. Three faults, all silent. A route bound to the wrong capability, which
 * hands somebody trusted with the accounts the enrolment secret. A moderator
 * written down before the split who finds every door shut, because the rule
 * that moderate holds the four finer ones was lost. And a session that keeps
 * what it had for a week after somebody took it away, which is what every
 * session did: the capabilities were copied at sign-in and never asked again.
 *
 * And inside the accounts door, the one box that is not the accounts
 * capability's to tick. Emby relays a film through this deployment for
 * everybody in the room, and giving it or taking it away is moderate's alone.
 */

// call sends one request through the router with a session's cookie.
func call(mux http.Handler, method, path string, cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")

	if cookie != nil {
		request.AddCookie(cookie)
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder
}

// refusedFor reads the code a refusal carried.
func refusedFor(recorder *httptest.ResponseRecorder) string {
	var said struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Error
}

// signIn opens a session for one of the configured administrators.
func signIn(t *testing.T, api *API, passphrase string) *http.Cookie {
	t.Helper()

	_, token, ok := api.sessions.Open("", room.Passphrase(passphrase))
	if !ok {
		t.Fatalf("%q could not sign in", passphrase)
	}

	return &http.Cookie{Name: cookieName, Value: token}
}

func TestAModeratorWrittenBeforeTheSplitReachesEveryDoor(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "moderator"), Can: []string{config.Moderate}}})
	cookie := signIn(t, api, "moderator")

	for _, endpoint := range endpoints {
		recorder := call(mux, endpoint.method, endpoint.path, cookie, `{}`)

		// Nothing is behind most of these, so what matters is only that the
		// gate let the request through.
		if recorder.Code == http.StatusUnauthorized || recorder.Code == http.StatusForbidden {
			t.Errorf("%s %s refused an administrator written as [moderate] with %d; every "+
				"moderator on the deployment would have lost it",
				endpoint.method, endpoint.path, recorder.Code)
		}
	}
}

func TestEachCapabilityOpensItsOwnDoorsAndNoOthers(t *testing.T) {
	for _, given := range []string{config.ManageRooms, config.ManageAccounts, config.ManageRelays, config.ManageSettings} {
		t.Run(given, func(t *testing.T) {
			api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "finer"), Can: []string{given}}})
			cookie := signIn(t, api, "finer")

			for _, endpoint := range endpoints {
				recorder := call(mux, endpoint.method, endpoint.path, cookie, `{}`)
				refused := recorder.Code == http.StatusUnauthorized || recorder.Code == http.StatusForbidden

				if endpoint.needs == config.Observe || endpoint.needs == given {
					if refused {
						t.Errorf("%s %s refused somebody given %q: %d",
							endpoint.method, endpoint.path, given, recorder.Code)
					}

					continue
				}

				if recorder.Code != http.StatusForbidden {
					t.Errorf("%s %s needs %q and answered %d to somebody given only %q, want 403",
						endpoint.method, endpoint.path, endpoint.needs, recorder.Code, given)
				}
			}
		})
	}
}

// liveRoster is a list of administrators that can change while sessions are
// open, which is the whole of what the next tests are about.
type liveRoster struct {
	mu   sync.Mutex
	list []config.Admin
}

func (l *liveRoster) read() []config.Admin {
	l.mu.Lock()
	defer l.mu.Unlock()

	return append([]config.Admin(nil), l.list...)
}

func (l *liveRoster) set(list ...config.Admin) {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.list = list
}

func mountLive(t *testing.T, live *liveRoster) (*API, http.Handler) {
	t.Helper()

	api := &API{
		conf:     &config.Config{LiveKit: livekitDefaults()},
		sessions: NewSessions(live.read, key),
		media:    absent{},
		control:  absent{},
		log:      NewLog(),
		store:    unwritten{},
		history:  NewHistory(nil),
		stop:     make(chan struct{}),
	}

	mux := http.NewServeMux()
	api.Mount(mux)

	return api, mux
}

// lapse makes a session's last look at the roster older than the minute it
// trusts one for, which is what a minute passing does.
func lapse(api *API, cookie *http.Cookie) {
	api.sessions.mu.Lock()
	defer api.sessions.mu.Unlock()

	held := api.sessions.open[cookie.Value]
	held.Checked = time.Now().Add(-2 * rosterRecheck)
	api.sessions.open[cookie.Value] = held
}

/*
Taking something away from somebody who is signed in.

The roster's own comments said removing somebody took effect on the next
request. The session copied its capabilities when it was opened and never asked
again, so a demoted moderator kept every power in the tab they had open for up
to a week of renewals, and a capability ticked for somebody did nothing until
they signed out and in. With capabilities ticked from a page, the second is a
checkbox that visibly does nothing; the first is the one that matters.
*/
func TestADemotedAdministratorLosesWhatTheyHadWithinAMinute(t *testing.T) {
	trip := room.Trip(key, "andy")
	live := &liveRoster{list: []config.Admin{{Trip: trip, Name: "andy", Can: []string{config.Moderate}}}}

	api, mux := mountLive(t, live)
	cookie := signIn(t, api, "andy")

	closing := func() int {
		return call(mux, http.MethodDelete, "/api/admin/rooms/standup", cookie, "").Code
	}

	if got := closing(); got == http.StatusForbidden || got == http.StatusUnauthorized {
		t.Fatalf("a moderator could not close a room: %d", got)
	}

	// Demoted to looking.
	live.set(config.Admin{Trip: trip, Name: "andy"})
	lapse(api, cookie)

	if got := closing(); got != http.StatusForbidden {
		t.Errorf("an administrator demoted to observe still closed a room a minute later "+
			"(%d); a session must not keep what the roster took away", got)
	}

	// And given the rooms alone, which is now something a page can do.
	live.set(config.Admin{Trip: trip, Name: "andy", Can: []string{config.ManageRooms}})
	lapse(api, cookie)

	if got := closing(); got == http.StatusForbidden || got == http.StatusUnauthorized {
		t.Errorf("an administrator given the rooms could not use them a minute later: %d", got)
	}

	// What the page is told it may do follows too, or it draws buttons that
	// refuse.
	var who whoami
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/session", cookie, "").Body.Bytes(), &who)

	if !reflect.DeepEqual(who.Can, []string{config.Observe, config.ManageRooms}) {
		t.Errorf("the session says it may %v, want [observe rooms]", who.Can)
	}
}

func TestARemovedAdministratorIsSignedOutWithinAMinute(t *testing.T) {
	andy := config.Admin{Trip: room.Trip(key, "andy"), Name: "andy", Can: []string{config.Moderate}}
	sam := config.Admin{Trip: room.Trip(key, "sam"), Name: "sam", Can: []string{config.Moderate}}
	live := &liveRoster{list: []config.Admin{andy, sam}}

	api, mux := mountLive(t, live)

	vaulted := newVault()
	api.sessions.Remember(vaulted)

	cookie := signIn(t, api, "sam")

	live.set(andy)
	lapse(api, cookie)

	if got := call(mux, http.MethodGet, "/api/admin/now", cookie, "").Code; got != http.StatusUnauthorized {
		t.Errorf("an administrator removed from the roster was still let in a minute later: %d", got)
	}

	// Gone from where it was written down as well, or a restart would bring
	// it back.
	if _, ok := vaulted.Session(cookie.Value); ok {
		t.Error("the removed administrator's session is still written down")
	}
}

// A session brought back after a restart was written down with what it held
// then. It asks the roster on its first use rather than trusting that.
func TestASessionBroughtBackAfterARestartAsksTheRosterAtOnce(t *testing.T) {
	trip := room.Trip(key, "andy")
	live := &liveRoster{list: []config.Admin{{Trip: trip, Name: "andy", Can: []string{config.Moderate}}}}

	vaulted := newVault()

	before, _ := mountLive(t, live)
	before.sessions.Remember(vaulted)
	cookie := signIn(t, before, "andy")

	// Demoted while the process was down.
	live.set(config.Admin{Trip: trip, Name: "andy"})

	after, mux := mountLive(t, live)
	after.sessions.Remember(vaulted)

	if got := call(mux, http.MethodDelete, "/api/admin/rooms/standup", cookie, "").Code; got != http.StatusForbidden {
		t.Errorf("a session restored from the store acted with the capabilities it was "+
			"written down with: %d, want 403", got)
	}
}

/*
The accounts door, and the one box in it that is moderate's.
*/

// desk is the accounts page with two people at it: a moderator, and a clerk
// trusted with the accounts and nothing else.
func desk(t *testing.T) (api *API, mux http.Handler, written *kept, st *store.Store, moderator, clerk *http.Cookie) {
	t.Helper()

	api, mux, written = mountAudited(t, []config.Admin{
		{Trip: room.Trip(key, "moderator"), Name: "adam", Can: []string{config.Moderate}},
		{Trip: room.Trip(key, "clerk"), Name: "cara", Can: []string{config.ManageAccounts}},
	})

	st, err := store.Open(filepath.Join(t.TempDir(), "meet.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	api.ledger = st
	api.roster = st

	if err := st.AddAccount(store.Account{Name: "ada", Trip: room.Trip(key, "ada's passphrase")}); err != nil {
		t.Fatal(err)
	}

	return api, mux, written, st, signIn(t, api, "moderator"), signIn(t, api, "clerk")
}

func TestOnlyAModeratorMayGiveOrTakeAwayEmby(t *testing.T) {
	_, mux, written, st, moderator, clerk := desk(t)

	emby := func() bool {
		account, _ := st.Account("ada")
		return account.May(store.PermEmby)
	}

	refused := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"perms":{"emby":true}}`)
	if refused.Code != http.StatusForbidden || refusedFor(refused) != "emby_needs_moderate" {
		t.Errorf("somebody trusted with the accounts gave Emby: %d %s", refused.Code, refused.Body.String())
	}
	if emby() {
		t.Fatal("and it was written")
	}

	// Refused whole: the note that came with it is not written either, or a
	// refusal would be half a change the page reports as none.
	_ = call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"note":"ops","perms":{"emby":true}}`)
	if account, _ := st.Account("ada"); account.Note != "" || account.May(store.PermEmby) {
		t.Errorf("a refused request still changed the account: note %q, emby %v",
			account.Note, account.May(store.PermEmby))
	}

	given := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"perms":{"emby":true}}`)
	if given.Code != http.StatusOK {
		t.Fatalf("a moderator giving Emby answered %d: %s", given.Code, given.Body.String())
	}
	if !emby() {
		t.Fatal("a moderator gave Emby and it was not written")
	}

	// Recorded against whoever gave it, saying what changed.
	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "change account" && entry.Target == "ada" && !entry.Failed &&
			strings.HasPrefix(entry.Change, "perms ") && strings.Contains(entry.Change, "-> watch,emby") {
			found = entry.Trip == room.Trip(key, "moderator")
		}
	}
	if !found {
		t.Errorf("giving somebody Emby left no record of who did: %+v", written.recorded())
	}

	// Taking it away is the same decision.
	taken := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"perms":{"emby":false}}`)
	if taken.Code != http.StatusForbidden || !emby() {
		t.Errorf("somebody trusted with the accounts took Emby away: %d", taken.Code)
	}

	// And the other boxes stay the clerk's, sent the way a page sends them —
	// every box, Emby as it already is.
	other := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk,
		`{"perms":{"watch":true,"emby":true,"music":false,"arrange":true,"invite":true,"open":true}}`)
	if other.Code != http.StatusOK {
		t.Fatalf("somebody trusted with the accounts was refused a box that is theirs: %d %s",
			other.Code, other.Body.String())
	}

	account, _ := st.Account("ada")
	if account.May(store.PermMusic) || !account.May(store.PermEmby) {
		t.Errorf("after the clerk's change: %v", account.Effective())
	}
}

func TestAnAccountMadeWithEmbyIsMadeByAModerator(t *testing.T) {
	_, mux, _, st, moderator, clerk := desk(t)

	body := `{"name":"bob","passphrase":"bob's long passphrase","perms":{"emby":true}}`

	if got := call(mux, http.MethodPost, "/api/admin/accounts", clerk, body); got.Code != http.StatusForbidden {
		t.Errorf("somebody trusted with the accounts made one with Emby: %d", got.Code)
	}
	if _, ok := st.Account("bob"); ok {
		t.Fatal("and it was made")
	}

	if got := call(mux, http.MethodPost, "/api/admin/accounts", moderator, body); got.Code != http.StatusOK {
		t.Fatalf("a moderator making an account with Emby answered %d", got.Code)
	}
	if account, _ := st.Account("bob"); !account.May(store.PermEmby) {
		t.Error("the account was made without the Emby it was made with")
	}

	// Without Emby, it is an ordinary account and the clerk's to make.
	plain := `{"name":"cy","passphrase":"cy's long passphrase","perms":{"music":false,"teleport":true}}`
	if got := call(mux, http.MethodPost, "/api/admin/accounts", clerk, plain); got.Code != http.StatusOK {
		t.Fatalf("somebody trusted with the accounts could not make one: %d %s", got.Code, got.Body.String())
	}

	// The word nobody knows was dropped rather than refusing the account.
	if account, _ := st.Account("cy"); account.May(store.PermMusic) ||
		!reflect.DeepEqual(account.Perms, map[string]bool{store.PermMusic: false}) {
		t.Errorf("made with %v", account.Perms)
	}
}

// spentOn stands in for whatever relays the films.
type spentOn map[string]uint64

func (s spentOn) EmbySpent() map[string]uint64 { return s }

// YouTubeSpent is nothing: the films are what these tests count.
func (s spentOn) YouTubeSpent() uint64 { return 0 }

// BangumiSpent is nothing, for the same reason.
func (s spentOn) BangumiSpent() uint64 { return 0 }

func (s spentOn) MoveSpent(from, to string) {
	s[to] += s[from]
	delete(s, from)
}

func TestTheAccountsListSaysWhatEachAccountMayUse(t *testing.T) {
	api, mux, _, st, moderator, _ := desk(t)

	ada := room.Trip(key, "ada's passphrase")
	api.UseSpent(spentOn{ada: 1 << 30})

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator,
		`{"perms":{"emby":true,"music":false}}`); got.Code != http.StatusOK {
		t.Fatalf("setting permissions answered %d", got.Code)
	}

	// A change that does not mention them leaves them where they are.
	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"note":"ops"}`); got.Code != http.StatusOK {
		t.Fatalf("a note answered %d", got.Code)
	}

	if account, _ := st.Account("ada"); !account.May(store.PermEmby) || account.May(store.PermMusic) {
		t.Fatalf("a note took the permissions with it: %v", account.Effective())
	}

	var views []accountView
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/accounts", moderator, "").Body.Bytes(), &views)

	if len(views) != 1 {
		t.Fatalf("listed %d accounts", len(views))
	}

	view := views[0]

	if !reflect.DeepEqual(view.Perms, map[string]bool{store.PermEmby: true, store.PermMusic: false}) {
		t.Errorf("stored permissions listed as %v", view.Perms)
	}

	want := map[string]bool{
		store.PermWatch: true, store.PermEmby: true, store.PermMusic: false,
		store.PermArrange: true, store.PermInvite: true, store.PermOpen: true,
	}
	if !reflect.DeepEqual(view.Effective, want) {
		t.Errorf("effective permissions listed as %v, want %v", view.Effective, want)
	}

	if view.EmbySpent != 1<<30 {
		t.Errorf("the relay's figure for the account was listed as %d", view.EmbySpent)
	}
}

/*
The roster, and the administrators' own Emby.
*/

func TestChangingARoleKeepsTheNameAndThePicture(t *testing.T) {
	_, mux, _, st, moderator, _ := desk(t)

	sam := store.Admin{Trip: room.Trip(key, "sam"), Name: "sam"}
	if err := st.AddAdmin(sam); err != nil {
		t.Fatal(err)
	}
	if err := st.SetAdminAvatar(sam.Trip, "data:image/png;base64,AAAA"); err != nil {
		t.Fatal(err)
	}

	// The role alone, with no name in the request.
	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"can":["rooms","accounts"]}`); got.Code != http.StatusOK {
		t.Fatalf("changing a role answered %d: %s", got.Code, got.Body.String())
	}

	after, _ := st.AdminBySignature(sam.Trip)

	if after.Name != "sam" {
		t.Errorf("a change of role with no name in it left the name as %q", after.Name)
	}
	if after.Avatar == "" {
		t.Error("a change of role took the administrator's picture away")
	}
	if !reflect.DeepEqual(after.Can, []string{config.ManageRooms, config.ManageAccounts}) {
		t.Errorf("the role is now %v", after.Can)
	}
}

// The page renames somebody by sending their name and the capabilities the
// roster listed for them, which for a moderator is every one. What is written
// must be what was there, or a rename turns into a record an older build will
// not rewrite.
func TestRenamingAModeratorWritesNoNewWords(t *testing.T) {
	_, mux, _, st, moderator, _ := desk(t)

	sam := store.Admin{Trip: room.Trip(key, "sam"), Name: "sam", Can: []string{config.Observe, config.Moderate}}
	if err := st.AddAdmin(sam); err != nil {
		t.Fatal(err)
	}

	listed, _ := json.Marshal(capabilitiesOf(sam.Configured()))

	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"name":"samuel","can":`+string(listed)+`}`); got.Code != http.StatusOK {
		t.Fatalf("renaming answered %d: %s", got.Code, got.Body.String())
	}

	after, _ := st.AdminBySignature(sam.Trip)

	if !reflect.DeepEqual(after.Can, []string{config.Observe, config.Moderate}) || after.Name != "samuel" {
		t.Errorf("renaming a moderator stored %v as %q, want [observe moderate]", after.Can, after.Name)
	}
}

func TestOnlyAModeratorMayGiveAnAdministratorEmby(t *testing.T) {
	api, mux, _, st, moderator, _ := desk(t)

	sam := store.Admin{Trip: room.Trip(key, "sam"), Name: "sam"}
	if err := st.AddAdmin(sam); err != nil {
		t.Fatal(err)
	}

	// Everything but moderate.
	api.sessions.admins = roster([]config.Admin{
		{Trip: room.Trip(key, "moderator"), Name: "adam", Can: []string{config.Moderate}},
		{Trip: room.Trip(key, "almost"), Name: "al", Can: []string{
			config.ManageRooms, config.ManageAccounts, config.ManageRelays, config.ManageSettings,
		}},
	})
	almost := signIn(t, api, "almost")

	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, almost,
		`{"perms":{"emby":true}}`); got.Code != http.StatusForbidden {
		t.Errorf("an administrator without moderate gave another Emby: %d", got.Code)
	}

	if after, _ := st.AdminBySignature(sam.Trip); after.May(store.PermEmby) {
		t.Fatal("and it was written")
	}

	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"perms":{"emby":true}}`); got.Code != http.StatusOK {
		t.Fatalf("a moderator giving an administrator Emby answered %d: %s", got.Code, got.Body.String())
	}

	if after, _ := st.AdminBySignature(sam.Trip); !after.May(store.PermEmby) || after.Name != "sam" {
		t.Errorf("after the grant: %+v", after)
	}

	// And the roster says so, with the rest of what an administrator holds.
	var entries []rosterEntry
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/admins", moderator, "").Body.Bytes(), &entries)

	for _, entry := range entries {
		if entry.Trip == sam.Trip && (!entry.Effective[store.PermEmby] || !entry.Effective[store.PermMusic]) {
			t.Errorf("the roster lists %v for an administrator given Emby", entry.Effective)
		}
	}
}

/*
The switch above every Emby grant.
*/

// switchboard is a settings store holding the three switches.
type switchboard struct {
	mu      sync.Mutex
	on      bool
	tube    bool
	bangumi bool
}

func (s *switchboard) BangumiRelay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.bangumi
}

func (s *switchboard) SetBangumiRelay(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.bangumi = on
	return nil
}

func (s *switchboard) YouTubeRelay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.tube
}

func (s *switchboard) SetYouTubeRelay(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.tube = on
	return nil
}

func (s *switchboard) EmbyRelay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	return s.on
}

func (s *switchboard) SetEmbyRelay(on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.on = on
	return nil
}

func TestOnlyTheSettingsCapabilityTurnsTheEmbyRelayOn(t *testing.T) {
	api, mux, written := mountAudited(t, []config.Admin{
		{Trip: room.Trip(key, "watcher"), Name: "wes"},
		{Trip: room.Trip(key, "clerk"), Name: "cara", Can: []string{config.ManageAccounts}},
		{Trip: room.Trip(key, "keeper"), Name: "kit", Can: []string{config.ManageSettings}},
	})

	board := &switchboard{}
	api.settings = board
	api.conf.Meet.Watch = config.Watch{URL: "http://gateway.invalid", DirectOnly: true}

	for _, who := range []string{"watcher", "clerk"} {
		got := call(mux, http.MethodPut, "/api/admin/settings", signIn(t, api, who), `{"embyRelay":true}`)

		if got.Code != http.StatusForbidden {
			t.Errorf("%s turned the media server relay on: %d", who, got.Code)
		}
	}

	if board.EmbyRelay() {
		t.Fatal("the relay was turned on by somebody refused")
	}

	keeper := signIn(t, api, "keeper")

	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{}`); got.Code != http.StatusBadRequest {
		t.Errorf("a request that says nothing answered %d, want 400", got.Code)
	}

	if got := call(mux, http.MethodPut, "/api/admin/settings", keeper, `{"embyRelay":true}`); got.Code != http.StatusOK {
		t.Fatalf("turning the relay on answered %d", got.Code)
	}

	if !board.EmbyRelay() {
		t.Fatal("the relay was not turned on")
	}

	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "set the media server relay" && entry.Target == "on" && !entry.Failed {
			found = entry.Trip == room.Trip(key, "keeper")
		}
	}
	if !found {
		t.Error("turning the relay on left no record of who did")
	}

	// Anybody may read it, and the runtime panel shows it beside the file's own
	// half of the same question.
	watcher := signIn(t, api, "watcher")

	var read watching
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/settings", watcher, "").Body.Bytes(), &read)

	if read != (watching{Configured: true, DirectOnly: true, EmbyRelay: true}) {
		t.Errorf("the settings read back as %+v", read)
	}

	var runtime struct {
		Meet struct {
			Watch watching `json:"watch"`
		} `json:"meet"`
	}
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/runtime", watcher, "").Body.Bytes(), &runtime)

	if runtime.Meet.Watch != read {
		t.Errorf("the runtime panel says %+v about watching", runtime.Meet.Watch)
	}
}

/*
Setting the passphrase of somebody who holds Emby is choosing who holds it.

Whoever sets it can sign in with it and choose a film, and the grant goes with
the account rather than with the person. So an administrator trusted with the
accounts and refused the Emby box could reset a grantee's passphrase, sign in as
them, and spend the grant: the box was moderate's, and the passphrase was a way
round it.
*/
func TestResettingThePassphraseOfSomebodyWithEmbyIsModeratesToo(t *testing.T) {
	_, mux, _, st, moderator, clerk := desk(t)

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"perms":{"emby":true}}`); got.Code != http.StatusOK {
		t.Fatalf("a moderator giving Emby answered %d", got.Code)
	}

	before, _ := st.Account("ada")

	refused := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"passphrase":"clerk chose this one"}`)
	if refused.Code != http.StatusForbidden || refusedFor(refused) != "emby_needs_moderate" {
		t.Errorf("somebody trusted with the accounts reset the passphrase of an account holding Emby: %d %s",
			refused.Code, refused.Body.String())
	}

	if after, _ := st.Account("ada"); after.Trip != before.Trip {
		t.Fatal("and the new passphrase was written")
	}

	// Moderate may, as it may give the grant in the first place.
	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"passphrase":"the moderator chose this"}`); got.Code != http.StatusOK {
		t.Errorf("a moderator resetting the passphrase of an account holding Emby answered %d", got.Code)
	}

	// And an account without Emby stays the clerk's to reset — or this would
	// pass on a server that let nobody but a moderator reset anything.
	if err := st.AddAccount(store.Account{Name: "bo", Trip: room.Trip(key, "bo's passphrase")}); err != nil {
		t.Fatal(err)
	}

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/bo", clerk, `{"passphrase":"clerk chose this one"}`); got.Code != http.StatusOK {
		t.Errorf("somebody trusted with the accounts could not reset an ordinary account's passphrase: %d", got.Code)
	}
}

/*
A box pressed on a page drawn half a minute ago changes that box, and not the
others as the page last saw them.

The page sent the whole set as it last drew it, and the server replaced the set
it held with that. Between two polls of the list, one administrator giving
somebody Emby and another unticking their music had the second request carry
Emby unticked, and the grant was gone with nothing on either page to say so.
*/
func TestABoxPressedOnAnOlderPageLeavesTheOtherBoxesAlone(t *testing.T) {
	_, mux, _, st, moderator, clerk := desk(t)

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"perms":{"emby":true}}`); got.Code != http.StatusOK {
		t.Fatalf("a moderator giving Emby answered %d", got.Code)
	}

	// What a page that knew nothing of the grant sends for one press.
	for who, cookie := range map[string]*http.Cookie{"a moderator": moderator, "somebody trusted with the accounts": clerk} {
		got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", cookie, `{"perms":{"music":false}}`)
		if got.Code != http.StatusOK {
			t.Fatalf("%s unticking music answered %d %s", who, got.Code, got.Body.String())
		}

		account, _ := st.Account("ada")
		if !account.May(store.PermEmby) {
			t.Errorf("%s unticking music took away the Emby another administrator had given", who)
		}

		if account.May(store.PermMusic) {
			t.Errorf("%s unticked music and it was not written", who)
		}

		// Put back for the next.
		if err := st.ChangeAccountPerms("ada", map[string]bool{store.PermMusic: true}); err != nil {
			t.Fatal(err)
		}
	}
}

// readingLedger is the accounts as stored, with something that happens the
// moment one account has been read: another administrator, or the person
// themselves, changing it before the request that read it writes.
type readingLedger struct {
	*store.Store
	once  sync.Once
	after func()
}

func (l *readingLedger) Account(name string) (store.Account, bool) {
	account, ok := l.Store.Account(name)
	l.once.Do(l.after)

	return account, ok
}

// A ticked box writes the box and nothing else. The request reads the whole
// record first, and writing that back with the box would put the rest of it as
// it was a moment earlier — the person's new picture, made in that moment,
// undone by somebody else's press.
func TestATickedBoxWritesOnlyTheBox(t *testing.T) {
	api, mux, _, st, moderator, _ := desk(t)

	api.ledger = &readingLedger{Store: st, after: func() {
		account, _ := st.Account("ada")
		account.Avatar = "data:image/png;base64,NEW"
		account.Note = "written meanwhile"
		if err := st.UpdateAccount("ada", account); err != nil {
			t.Error(err)
		}
	}}

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"perms":{"music":false}}`); got.Code != http.StatusOK {
		t.Fatalf("ticking a box answered %d %s", got.Code, got.Body.String())
	}

	account, _ := st.Account("ada")
	if account.Avatar != "data:image/png;base64,NEW" || account.Note != "written meanwhile" {
		t.Errorf("a ticked box wrote the rest of the record back as it was read: picture %q, note %q",
			account.Avatar, account.Note)
	}

	if account.May(store.PermMusic) {
		t.Error("and the box itself was not written")
	}
}

// A rename and a box in one request: the box is written under the name the
// record now has, not the one the request was addressed to, which a rename has
// just taken away.
func TestARenameAndABoxTogetherBothTakeEffect(t *testing.T) {
	_, mux, _, st, moderator, _ := desk(t)

	got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator, `{"name":"adele","perms":{"music":false}}`)
	if got.Code != http.StatusOK {
		t.Fatalf("a rename with a box answered %d %s", got.Code, got.Body.String())
	}

	if _, ok := st.Account("ada"); ok {
		t.Error("the old name is still there")
	}

	renamed, ok := st.Account("adele")
	if !ok || renamed.May(store.PermMusic) {
		t.Errorf("after a rename with music unticked, the account is %+v (found %v)", renamed, ok)
	}
}

/*
A box that names Emby unchanged, from somebody who may not move it, writes
nothing about Emby.

The comparison is made against the record as the request read it, and the
write happens a moment later. Written as read, an unchanged Emby would be the
read put back over whatever a moderator did in that moment: a revocation
undone, by somebody the box is not offered to at all.
*/
func TestEmbyNamedUnchangedIsNotWrittenBySomebodyWithoutModerate(t *testing.T) {
	api, mux, _, st, _, clerk := desk(t)

	if err := st.SetAccountPerms("ada", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	// A moderator takes Emby away just after the clerk's request has read the
	// account as holding it.
	api.ledger = &readingLedger{Store: st, after: func() {
		if err := st.ChangeAccountPerms("ada", map[string]bool{store.PermEmby: false}); err != nil {
			t.Error(err)
		}
	}}

	got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"perms":{"emby":true,"music":false}}`)
	if got.Code != http.StatusOK {
		t.Fatalf("unticking music beside an unchanged Emby answered %d %s", got.Code, got.Body.String())
	}

	account, _ := st.Account("ada")
	if account.May(store.PermEmby) {
		t.Error("somebody without moderate wrote Emby back over a revocation made while their request was on its way")
	}

	if account.May(store.PermMusic) {
		t.Error("and the box they did press was not written")
	}
}

// Renaming somebody who holds Emby is not choosing who holds it: the grant is
// asked for by signature, which a rename leaves where it was. So it stays the
// accounts capability's, and the grant stays with the passphrase it was given
// to.
func TestRenamingSomebodyWithEmbyIsTheAccountsCapabilitys(t *testing.T) {
	_, mux, _, st, _, clerk := desk(t)

	if err := st.SetAccountPerms("ada", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	before, _ := st.Account("ada")

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", clerk, `{"name":"adele"}`); got.Code != http.StatusOK {
		t.Fatalf("somebody trusted with the accounts renaming an account with Emby answered %d %s",
			got.Code, got.Body.String())
	}

	after, ok := st.Account("adele")
	if !ok || after.Trip != before.Trip || !after.May(store.PermEmby) {
		t.Errorf("after a rename the account is %+v (found %v)", after, ok)
	}
}

/*
A custom role's box changes that box, and not the others as the page last drew
them.

The page sent the whole list as it last drew it, and the server replaced the
list it held with that: an administrator ticking Relays for somebody on a page
polled a minute ago took away the Settings another administrator had given in
between. A first version of the box that sent only itself, against a server
that still replaced, was worse: ticking a second box took the first away.
*/
func TestACapabilityBoxPressedOnAnOlderPageLeavesTheOthersAlone(t *testing.T) {
	_, mux, written, st, moderator, _ := desk(t)

	sam := store.Admin{Trip: room.Trip(key, "sam"), Name: "sam", Can: []string{config.ManageAccounts}}
	if err := st.AddAdmin(sam); err != nil {
		t.Fatal(err)
	}

	can := func() []string {
		after, _ := st.AdminBySignature(sam.Trip)
		return after.Can
	}

	// One administrator gives Settings.
	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"caps":{"settings":true}}`); got.Code != http.StatusOK {
		t.Fatalf("ticking Settings answered %d %s", got.Code, got.Body.String())
	}

	// Another, whose page still shows Accounts alone, ticks Relays.
	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"caps":{"relays":true}}`); got.Code != http.StatusOK {
		t.Fatalf("ticking Relays answered %d %s", got.Code, got.Body.String())
	}

	if want := []string{config.ManageAccounts, config.ManageRelays, config.ManageSettings}; !reflect.DeepEqual(can(), want) {
		t.Errorf("after two boxes pressed on two pages the role is %v, want %v", can(), want)
	}

	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"caps":{"accounts":false}}`); got.Code != http.StatusOK {
		t.Fatalf("unticking Accounts answered %d", got.Code)
	}

	if want := []string{config.ManageRelays, config.ManageSettings}; !reflect.DeepEqual(can(), want) {
		t.Errorf("after unticking Accounts the role is %v, want %v", can(), want)
	}

	// Recorded as what it left behind, not as the one box.
	found := false
	for _, entry := range written.recorded() {
		if entry.Action == "change administrator" && entry.Change == "can accounts,relays,settings -> relays,settings" {
			found = true
		}
	}
	if !found {
		t.Errorf("unticking a box left no record of what the role became: %+v", written.recorded())
	}

	// The boxes are the four finer capabilities. Moderate is the role
	// control's, written whole and guarded there against losing the last one.
	refused := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator, `{"caps":{"moderate":true}}`)
	if refused.Code != http.StatusBadRequest || refusedFor(refused) != "unknown_capability" {
		t.Errorf("a box named moderate answered %d %s", refused.Code, refused.Body.String())
	}

	if slices.Contains(can(), config.Moderate) {
		t.Fatal("and moderate was written")
	}

	// Pressed for somebody since made a moderator, a box changes nothing:
	// moderate holds every box, and a word written beside it is one nobody
	// chose.
	if err := st.UpdateAdmin(store.Admin{Trip: sam.Trip, Name: "sam", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"caps":{"rooms":true}}`); got.Code != http.StatusOK {
		t.Fatalf("a box pressed for a moderator answered %d", got.Code)
	}

	if want := []string{config.Moderate}; !reflect.DeepEqual(can(), want) {
		t.Errorf("a box pressed on an older page for somebody since made a moderator left them %v", can())
	}
}

// An administrator's Emby box sends itself, and the server lays it over what it
// holds rather than replacing the grants with it.
func TestAnAdministratorsEmbyBoxIsLaidOverTheirGrants(t *testing.T) {
	_, mux, _, st, moderator, _ := desk(t)

	sam := store.Admin{Trip: room.Trip(key, "sam"), Name: "sam"}
	if err := st.AddAdmin(sam); err != nil {
		t.Fatal(err)
	}

	if err := st.SetAdminPerms(sam.Trip, map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	// A box that names nothing about Emby, as an older page about a grant it
	// had not seen would send for any other.
	if got := call(mux, http.MethodPatch, "/api/admin/admins/"+sam.Trip, moderator,
		`{"perms":{"music":true}}`); got.Code != http.StatusOK {
		t.Fatalf("answered %d %s", got.Code, got.Body.String())
	}

	if after, _ := st.AdminBySignature(sam.Trip); !after.May(store.PermEmby) {
		t.Error("a change to the administrator's grants that did not name Emby took it away")
	}
}

// A figure follows the person across a change of passphrase. It is counted by
// signature, and a reset used to put somebody back to nought on this page while
// what they had spent stayed counted against a signature nobody now has.
func TestWhatSomebodySpentFollowsThemToANewPassphrase(t *testing.T) {
	api, mux, _, st, moderator, _ := desk(t)

	was := room.Trip(key, "ada's passphrase")
	api.UseSpent(spentOn{was: 4096})

	if err := st.SetAccountPerms("ada", map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	if got := call(mux, http.MethodPatch, "/api/admin/accounts/ada", moderator,
		`{"passphrase":"ada's new passphrase"}`); got.Code != http.StatusOK {
		t.Fatalf("a reset answered %d %s", got.Code, got.Body.String())
	}

	var listed []accountView
	_ = json.Unmarshal(call(mux, http.MethodGet, "/api/admin/accounts", moderator, "").Body.Bytes(), &listed)

	for _, one := range listed {
		if one.Name == "ada" && one.EmbySpent != 4096 {
			t.Errorf("after a reset the page says ada has spent %d, where she had spent 4096", one.EmbySpent)
		}
	}
}

// The same for an administrator changing their own: their figure is found by
// the signature too.
func TestWhatAnAdministratorSpentFollowsThemToANewPassphrase(t *testing.T) {
	api, mux, _, st, _, _ := desk(t)

	was := room.Trip(key, "sam's passphrase")
	if err := st.AddAdmin(store.Admin{Trip: was, Name: "sam", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	api.sessions.admins = roster([]config.Admin{{Trip: was, Name: "sam", Can: []string{config.Moderate}}})
	api.UseSpent(spentOn{was: 4096})

	sam := signIn(t, api, "sam's passphrase")

	got := call(mux, http.MethodPost, "/api/admin/admins/me/passphrase", sam,
		`{"current":"sam's passphrase","next":"sam's new passphrase"}`)
	if got.Code != http.StatusOK {
		t.Fatalf("changing one's own passphrase answered %d %s", got.Code, got.Body.String())
	}

	if spent := api.spending(); spent[room.Trip(key, "sam's new passphrase")] != 4096 {
		t.Errorf("after an administrator changed their passphrase the figures are %v", spent)
	}
}
