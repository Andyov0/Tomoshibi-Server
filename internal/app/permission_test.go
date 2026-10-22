package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What an account may use, at each door that asks.

Each permission is a box somebody unticks on the management pages and expects
to mean something, and each is enforced at a different endpoint — so the way
this fails is one door that was never told, which looks from the page exactly
like one that was. Every gate is asked from both sides here: refused with the
box unticked, and let through with it ticked, which is the default, so that a
gate that refused everybody would fail as surely as one that refused nobody.

Administrators are asked too, because they are not accounts. whoever() hands one
back dressed as an account with no permissions on it, and a gate that read the
permissions off that shape would lock every administrator out of the music
library while seeming to work for everybody else.
*/

// withheld is the listener's account with one permission taken away.
func withheld(t *testing.T, st *store.Store, permission string) {
	t.Helper()

	if err := st.SetAccountPerms("listener", map[string]bool{permission: false}); err != nil {
		t.Fatal(err)
	}
}

// frontAdmin is an administrator signed in at the front of the site, holding
// no record of permissions at all.
func frontAdmin(t *testing.T, st *store.Store, can ...string) *http.Cookie {
	t.Helper()

	trip := room.Trip(tripKey, "an administrator's passphrase")
	if err := st.AddAdmin(store.Admin{Trip: trip, Name: "keeper", Can: can}); err != nil {
		t.Fatal(err)
	}

	return sessionFor(t, st, "keeper", trip)
}

func TestWatchingTogetherNeedsTheWatchPermission(t *testing.T) {
	reached := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Watch = config.Watch{URL: upstream.URL, Token: watchToken}

	paths := []string{"/api/watch/ready", "/api/watch/resolve?url=https%3A%2F%2Fexample.invalid%2Fv"}

	for _, path := range paths {
		if got := musicGet(mux, path, cookie).Code; got != http.StatusOK {
			t.Errorf("%s answered %d to an account holding every default", path, got)
		}
	}

	withheld(t, app.store, store.PermWatch)
	before := reached

	for _, path := range paths {
		got := musicGet(mux, path, cookie)
		if got.Code != http.StatusForbidden || refusal(t, got) != "not_allowed" {
			t.Errorf("%s answered %d %s to an account not given watching together", path, got.Code, got.Body.String())
		}
	}

	if reached != before {
		t.Error("the gateway was asked on behalf of somebody not given watching together")
	}

	// What a ticket plays is still anybody's in the call: they watch whatever
	// somebody else put on.
	if got := musicGet(mux, "/api/watch/info?t=a-ticket-of-some-length", cookie).Code; got != http.StatusOK {
		t.Errorf("somebody not given watching together could not read what a ticket plays: %d", got)
	}

	keeper := frontAdmin(t, app.store, config.Observe)
	for _, path := range paths {
		if got := musicGet(mux, path, keeper).Code; got != http.StatusOK {
			t.Errorf("%s answered %d to an administrator, who holds every default", path, got)
		}
	}
}

func TestTheMusicLibraryNeedsTheMusicPermission(t *testing.T) {
	reached := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	t.Cleanup(upstream.Close)

	mux, app, cookie := signedInApp(t)
	app.conf.Meet.Music = config.Music{URL: upstream.URL, Token: musicToken}

	paths := []string{
		"/api/music/sources", "/api/music/search?source=a&q=b", "/api/music/track?source=a&id=b",
		"/api/music/audio?source=a&id=b", "/api/music/link?url=x",
	}

	for _, path := range paths {
		if got := musicGet(mux, path, cookie).Code; got != http.StatusOK {
			t.Errorf("%s answered %d to an account holding every default", path, got)
		}
	}

	withheld(t, app.store, store.PermMusic)
	before := reached

	for _, path := range paths {
		got := musicGet(mux, path, cookie)
		if got.Code != http.StatusForbidden || refusal(t, got) != "not_allowed" {
			t.Errorf("%s answered %d %s to an account not given the library", path, got.Code, got.Body.String())
		}
	}

	if reached != before {
		t.Error("the library was asked on behalf of somebody not given it")
	}

	keeper := frontAdmin(t, app.store)
	if got := musicGet(mux, "/api/music/sources", keeper).Code; got != http.StatusOK {
		t.Errorf("an administrator was refused the library: %d", got)
	}
}

func TestArrangingNeedsTheArrangePermissionAndCancellingDoesNot(t *testing.T) {
	mux, st := hosted(t)
	host := signedInAs(t, st, "ada", "adaadaadaa")

	made := arrangeAs(t, mux, host, `{"room":"standup","at":"`+soon()+`"}`)
	if made.Code != http.StatusOK {
		t.Fatalf("arranging with every default answered %d %s", made.Code, made.Body.String())
	}

	var arranged arrangement
	_ = json.Unmarshal(made.Body.Bytes(), &arranged)

	if err := st.SetAccountPerms("ada", map[string]bool{store.PermArrange: false}); err != nil {
		t.Fatal(err)
	}

	if got := arrangeAs(t, mux, host, `{"room":"retro","at":"`+soon()+`"}`); got.Code != http.StatusForbidden || refusal(t, got) != "not_allowed" {
		t.Errorf("an account not given arranging arranged a meeting: %d %s", got.Code, got.Body.String())
	}

	// What they already arranged is still theirs to see and to call off.
	listing := httptest.NewRequest(http.MethodGet, "/api/meetings", nil)
	listing.AddCookie(host)

	if got := ask(mux, listing); got.Code != http.StatusOK {
		t.Errorf("listing one's meetings after the permission was taken away answered %d", got.Code)
	}

	cancelling := httptest.NewRequest(http.MethodDelete, "/api/meetings/"+arranged.ID, nil)
	cancelling.AddCookie(host)

	if got := ask(mux, cancelling); got.Code/100 != 2 {
		t.Errorf("cancelling one's own meeting after the permission was taken away answered %d %s", got.Code, got.Body.String())
	}
}

func TestAStandingLinkNeedsTheInvitePermission(t *testing.T) {
	mux, st := guarded(t)
	ada := sessionFor(t, st, "ada", room.Trip(tripKey, adaPassphrase))

	if got := mint(mux, "/api/rooms/standup@acme/invites", `{"standing":true}`, ada); got.Code != http.StatusOK {
		t.Fatalf("a member with every default making a standing link answered %d %s", got.Code, got.Body.String())
	}

	if err := st.SetAccountPerms("ada", map[string]bool{store.PermInvite: false}); err != nil {
		t.Fatal(err)
	}

	if got := mint(mux, "/api/rooms/standup@acme/invites", `{"standing":true}`, ada); got.Code != http.StatusForbidden || refusal(t, got) != "not_allowed" {
		t.Errorf("a member not given standing links made one: %d %s", got.Code, got.Body.String())
	}

	// The link a call makes, which ends with the meeting, is still the host's.
	if got := mint(mux, "/api/rooms/standup@acme/invites", ``, ada); got.Code != http.StatusOK {
		t.Errorf("a member not given standing links could not make an ordinary one: %d %s", got.Code, got.Body.String())
	}

	// And an administrator holds it whatever is written about them.
	adam := sessionFor(t, st, "adam", room.Trip(tripKey, adamPassphrase))
	if got := mint(mux, "/api/rooms/standup@acme/invites", `{"standing":true}`, adam); got.Code != http.StatusOK {
		t.Errorf("an administrator making a standing link answered %d %s", got.Code, got.Body.String())
	}
}

func TestOpeningARoomNeedsTheOpenPermission(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickSticky, store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid"})

	const adaSays, bobSays = "ada's own passphrase", "bob's own passphrase"

	for _, account := range []store.Account{
		{Name: "ada", Trip: room.Trip(tripKey, adaSays)},
		{Name: "bob", Trip: room.Trip(tripKey, bobSays), Perms: map[string]bool{store.PermOpen: false}},
	} {
		if err := st.AddAccount(account); err != nil {
			t.Fatal(err)
		}
	}

	ada := sessionFor(t, st, "ada", room.Trip(tripKey, adaSays))
	bob := sessionFor(t, st, "bob", room.Trip(tripKey, bobSays))
	keeper := frontAdmin(t, st, config.Observe)

	cases := []struct {
		policy room.Opening
		who    string
		said   string
		cookie *http.Cookie
		want   int
	}{
		{room.ByAccounts, "ada signed in", "", ada, http.StatusOK},
		{room.ByAccounts, "bob signed in", "", bob, http.StatusForbidden},
		{room.ByAccounts, "an administrator signed in", "", keeper, http.StatusOK},

		{room.BySigned, "ada signed in", "", ada, http.StatusOK},
		{room.BySigned, "bob signed in", "", bob, http.StatusForbidden},
		{room.BySigned, "bob's passphrase typed", bobSays, nil, http.StatusForbidden},
		{room.BySigned, "a passphrase belonging to nobody", "anybody's own words", nil, http.StatusOK},
		{room.BySigned, "an administrator signed in", "", keeper, http.StatusOK},
	}

	for i, c := range cases {
		if err := st.SetOpening(c.policy); err != nil {
			t.Fatal(err)
		}

		name := "unused-" + string(rune('a'+i))
		got := scopedJoin(mux, "/api/rooms/"+name+"/join", c.said, c.cookie)

		if got.Code != c.want {
			t.Errorf("under %q, %s opening %s answered %d %s, want %d",
				c.policy, c.who, name, got.Code, got.Body.String(), c.want)
		}

		if c.want == http.StatusForbidden && refusal(t, got) != "room_not_open" {
			t.Errorf("under %q, %s was refused with %q, want room_not_open", c.policy, c.who, refusal(t, got))
		}
	}

	// Refused the opening, not the joining: bob comes into a room ada opened.
	if err := st.SetOpening(room.ByAccounts); err != nil {
		t.Fatal(err)
	}

	if got := scopedJoin(mux, "/api/rooms/unused-a/join", "", bob); got.Code != http.StatusOK {
		t.Errorf("somebody not given opening was kept out of a room somebody else opened: %d", got.Code)
	}
}

func TestTheAccountPageIsToldWhatItMayUse(t *testing.T) {
	mux, app, cookie := signedInApp(t)

	can := func(cookie *http.Cookie) []string {
		t.Helper()

		got := musicGet(mux, "/api/account/me", cookie)

		var me struct {
			Can []string `json:"can"`
		}
		if err := json.Unmarshal(got.Body.Bytes(), &me); err != nil || got.Code != http.StatusOK {
			t.Fatalf("the account page's own record answered %d %s", got.Code, got.Body.String())
		}

		return me.Can
	}

	if got := can(cookie); !slices.Equal(got, []string{"watch", "music", "arrange", "invite", "open"}) {
		t.Errorf("an account holding the defaults was told it may use %v", got)
	}

	if err := app.store.SetAccountPerms("listener", map[string]bool{store.PermEmby: true, store.PermMusic: false}); err != nil {
		t.Fatal(err)
	}

	if got := can(cookie); !slices.Equal(got, []string{"watch", "emby", "arrange", "invite", "open"}) {
		t.Errorf("an account given Emby and refused music was told it may use %v", got)
	}

	keeper := frontAdmin(t, app.store, config.Moderate)
	if got := can(keeper); slices.Contains(got, "emby") || !slices.Contains(got, "music") {
		t.Errorf("an administrator nobody granted Emby was told they may use %v", got)
	}
}

// slowBody is a request body that says when it is first read, and then waits
// to be let go: the moment between a request reading somebody's record and
// writing its change back, held open for as long as the test needs.
type slowBody struct {
	reading chan struct{}
	release chan struct{}
	rest    io.Reader
	once    bool
}

func (b *slowBody) Read(p []byte) (int, error) {
	if !b.once {
		b.once = true
		close(b.reading)
		<-b.release
	}

	return b.rest.Read(p)
}

/*
Blocking somebody is how their films stop being relayed, and it has to survive
whatever they were doing at the moment it happened.

Changing one's own picture or passphrase read the whole record at the start of
the request and wrote the whole of it back at the end — after the picture had
arrived, at whatever pace the person's connection sent it — so a block made in
between was written over with the record as it was before: the block gone, the
session working again, and their films relayed again.
*/
func TestABlockMadeWhileSomebodyChangesTheirOwnRecordStays(t *testing.T) {
	for name, change := range map[string]struct {
		method, path, body string
	}{
		"picture":    {http.MethodPut, "/api/account/avatar", `{"image":"data:image/png;base64,AAAA"}`},
		"passphrase": {http.MethodPost, "/api/account/passphrase", `{"current":"listener's passphrase","next":"listener's new passphrase"}`},
	} {
		t.Run(name, func(t *testing.T) {
			mux, st, _ := controlWithStore(t, config.PickProbe)

			trip := room.Trip(tripKey, "listener's passphrase")
			if err := st.AddAccount(store.Account{Name: "listener", Trip: trip}); err != nil {
				t.Fatal(err)
			}

			cookie := sessionFor(t, st, "listener", trip)

			body := &slowBody{
				reading: make(chan struct{}),
				release: make(chan struct{}),
				rest:    strings.NewReader(change.body),
			}

			request := httptest.NewRequest(change.method, change.path, body)
			request.Header.Set("Content-Type", "application/json")
			request.AddCookie(cookie)

			answered := make(chan *httptest.ResponseRecorder)
			go func() { answered <- ask(mux, request) }()

			// Past the door — signed in, record read — and waiting on the body.
			<-body.reading

			account, _ := st.Account("listener")
			account.Blocked = true
			account.Note = "blocked while changing their picture"
			if err := st.UpdateAccount("listener", account); err != nil {
				t.Fatal(err)
			}

			close(body.release)
			got := <-answered

			// The change itself went through: this is not a test of a request
			// that was refused and so wrote nothing.
			if got.Code != http.StatusOK {
				t.Fatalf("the %s change answered %d: %s", name, got.Code, got.Body.String())
			}

			after, _ := st.Account("listener")
			if !after.Blocked || after.Note != "blocked while changing their picture" {
				t.Errorf("after a %s change finished, the block made during it is %v and the note %q",
					name, after.Blocked, after.Note)
			}

			switch name {
			case "picture":
				if after.Avatar != "data:image/png;base64,AAAA" {
					t.Errorf("the picture was answered as changed and stored as %q", after.Avatar)
				}
			case "passphrase":
				if after.Trip != room.Trip(tripKey, "listener's new passphrase") {
					t.Errorf("the passphrase was answered as changed and the signature is %q", after.Trip)
				}
			}
		})
	}
}

// A passphrase an administrator set while the person was changing theirs is
// not undone by the person's change finishing: the reset is usually why.
func TestAResetMadeWhileSomebodyChangesTheirPassphraseStays(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe)

	trip := room.Trip(tripKey, "listener's passphrase")
	if err := st.AddAccount(store.Account{Name: "listener", Trip: trip}); err != nil {
		t.Fatal(err)
	}

	cookie := sessionFor(t, st, "listener", trip)

	body := &slowBody{
		reading: make(chan struct{}),
		release: make(chan struct{}),
		rest:    strings.NewReader(`{"current":"listener's passphrase","next":"listener's new passphrase"}`),
	}

	request := httptest.NewRequest(http.MethodPost, "/api/account/passphrase", body)
	request.AddCookie(cookie)

	answered := make(chan *httptest.ResponseRecorder)
	go func() { answered <- ask(mux, request) }()

	<-body.reading

	reset := room.Trip(tripKey, "the administrator's reset")
	account, _ := st.Account("listener")
	account.Trip = reset
	if err := st.UpdateAccount("listener", account); err != nil {
		t.Fatal(err)
	}

	close(body.release)
	got := <-answered

	if got.Code == http.StatusOK {
		t.Errorf("a change of passphrase from a signature that had since been reset was accepted")
	}

	if after, _ := st.Account("listener"); after.Trip != reset {
		t.Errorf("the administrator's reset was undone: the signature is %q", after.Trip)
	}
}

// Somebody changing their own passphrase takes what they have spent with them,
// as a reset by an administrator does (internal/admin), since the management
// pages find the figure by the signature the passphrase makes.
func TestChangingOnesOwnPassphraseKeepsWhatOneSpent(t *testing.T) {
	mux, st, app := controlWithStore(t, config.PickProbe)

	trip := room.Trip(tripKey, "listener's passphrase")
	if err := st.AddAccount(store.Account{Name: "listener", Trip: trip}); err != nil {
		t.Fatal(err)
	}

	app.relayed.spend(trip, 4096)

	request := httptest.NewRequest(http.MethodPost, "/api/account/passphrase",
		strings.NewReader(`{"current":"listener's passphrase","next":"listener's new passphrase"}`))
	request.AddCookie(sessionFor(t, st, "listener", trip))

	if got := ask(mux, request); got.Code != http.StatusOK {
		t.Fatalf("changing a passphrase answered %d %s", got.Code, got.Body.String())
	}

	spent := app.relayed.EmbySpent()
	if spent[room.Trip(tripKey, "listener's new passphrase")] != 4096 || spent[trip] != 0 {
		t.Errorf("after a change of passphrase the figures are %v", spent)
	}
}
