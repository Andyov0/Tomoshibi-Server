package app

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
Running somebody else's room, by capability.

The management pages put closing, removing, muting and moving behind the rooms
capability. The meeting pages reach the same acts from inside a call — and they
asked for moderate, so an administrator given the rooms alone could close a
meeting from one page and be told on the other that it was not theirs, while one
given only the accounts would be refused on both, as they should be. Both doors
are asked the same question here, from both of the ways an administrator can be
recognised at them: the management session, and the account session of somebody
who is an administrator.
*/

func TestOnlyTheRoomsCapabilityRunsSomebodyElsesRoom(t *testing.T) {
	_, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	people := map[string][]string{
		"rooms":    {config.ManageRooms},
		"accounts": {config.ManageAccounts},
		"moderate": {config.Moderate},
	}

	for name, can := range people {
		if err := st.AddAdmin(store.Admin{
			Trip: room.Trip(tripKey, name+"'s passphrase"), Name: name, Can: can,
		}); err != nil {
			t.Fatal(err)
		}
	}

	// Built again now there are administrators, because the management pages
	// are mounted only where somebody could sign in to them.
	mux := app.Handler()

	if _, err := st.OpenRoom("standup", true); err != nil {
		t.Fatal(err)
	}

	_, theirs := tokenFor(t, "standup", "somebody else's passphrase")
	mark, _ := room.SignatureOf(theirs)

	if err := st.SetHost("standup", mark.Trip); err != nil {
		t.Fatal(err)
	}

	// Each joined as a guest, so nothing about the identity says who they are.
	guest, _ := tokenFor(t, "standup", "")

	want := map[string]int{
		"rooms":    http.StatusOK,
		"moderate": http.StatusOK,
		"accounts": http.StatusForbidden,
	}

	for name := range people {
		t.Run(name+" through the account door", func(t *testing.T) {
			token := "an account session for " + name
			now := time.Now().UTC()

			if err := st.KeepSession(token, store.Session{
				Trip: room.Trip(tripKey, name+"'s passphrase"), Name: name, Kind: "account",
				Opened: now, Expires: now.Add(time.Hour),
			}); err != nil {
				t.Fatal(err)
			}

			request := asking(http.MethodPost, "/api/rooms/standup/invites", guest, "")
			request.AddCookie(&http.Cookie{Name: "meet-live.account", Value: token})

			if got := ask(mux, request).Code; got != want[name] {
				t.Errorf("an administrator given %v, signed in at the front, asked for a link "+
					"into somebody else's room and got %d, want %d", people[name], got, want[name])
			}
		})

		t.Run(name+" through the management session", func(t *testing.T) {
			signing := asking(http.MethodPost, "/api/admin/session", "",
				`{"name":"`+name+`","passphrase":"`+name+`'s passphrase"}`)

			signed := ask(mux, signing)
			if signed.Code != http.StatusOK {
				t.Fatalf("signing in to the management pages answered %d", signed.Code)
			}

			request := asking(http.MethodPost, "/api/rooms/standup/invites", "", "")
			for _, cookie := range signed.Result().Cookies() {
				request.AddCookie(cookie)
			}

			if got := ask(mux, request).Code; got != want[name] {
				t.Errorf("an administrator given %v, from the management pages, asked for a "+
					"link into somebody else's room and got %d, want %d", people[name], got, want[name])
			}
		})
	}
}

/*
An administrator's picture, changed from the account page.

It went back through the whole-record rewrite, which now carries the picture
over from what is stored so that another administrator changing this one's role
cannot erase it — and so cannot be how the picture changes. Without its own way
to be written, the picture change would answer as though it had worked and
change nothing.
*/
func TestAnAdministratorChangesTheirOwnPicture(t *testing.T) {
	_, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "shanghai", URL: "wss://sh.example.invalid", Region: "CN-East"},
	)

	trip := room.Trip(tripKey, "andy's passphrase")

	if err := st.AddAdmin(store.Admin{Trip: trip, Name: "andy", Can: []string{config.Moderate}}); err != nil {
		t.Fatal(err)
	}

	if err := st.SetAdminPerms(trip, map[string]bool{store.PermEmby: true}); err != nil {
		t.Fatal(err)
	}

	mux := app.Handler()

	token := "an account session for andy"
	now := time.Now().UTC()

	if err := st.KeepSession(token, store.Session{
		Trip: trip, Name: "andy", Kind: "account", Opened: now, Expires: now.Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}

	request := asking(http.MethodPut, "/api/account/avatar", "", `{"image":"data:image/png;base64,AAAA"}`)
	request.AddCookie(&http.Cookie{Name: "meet-live.account", Value: token})

	if got := ask(mux, request); got.Code != http.StatusOK {
		t.Fatalf("an administrator changing their picture answered %d: %s", got.Code, got.Body.String())
	}

	admin, _ := st.AdminBySignature(trip)

	if admin.Avatar != "data:image/png;base64,AAAA" {
		t.Errorf("the picture was answered as changed and stored as %q", admin.Avatar)
	}

	if !admin.May(store.PermEmby) {
		t.Error("changing a picture took the administrator's Emby grant with it")
	}

	// And the passphrase, which moves the record to a new key: the picture and
	// the grant go with it.
	moving := asking(http.MethodPost, "/api/account/passphrase", "",
		`{"current":"andy's passphrase","next":"andy's new passphrase"}`)
	moving.AddCookie(&http.Cookie{Name: "meet-live.account", Value: token})

	moved := ask(mux, moving)
	if moved.Code != http.StatusOK {
		t.Fatalf("an administrator changing their passphrase answered %d: %s", moved.Code, moved.Body.String())
	}

	after, ok := st.AdminBySignature(room.Trip(tripKey, "andy's new passphrase"))
	if !ok || !strings.HasPrefix(after.Avatar, "data:image/png") || !after.May(store.PermEmby) {
		t.Errorf("after a change of passphrase the administrator is %+v (found %v)", after, ok)
	}
}

/*
The rooms capability carries into the places only an administrator may go, as
well as into the acts a host has.

Moving a room onto a relay reserved for administrators asks administrating, not
mayHost, and the management session's answer there is a second place the
capability is read. Read as moderate there, an administrator given the rooms
alone could act on a room from the management pages and still be told a
reserved machine was not for them, and nothing else would notice: every other
test of the rooms capability goes through mayHost.
*/
func TestTheRoomsCapabilityReachesAReservedRelay(t *testing.T) {
	_, st, app := controlWithStore(t, config.PickProbe,
		store.Relay{Name: "open", URL: "wss://open.example.invalid", Region: "CN-East"},
		store.Relay{
			Name: "reserved", URL: "wss://priv.example.invalid", Region: "CN-East",
			AdminOnly: true,
		},
	)

	people := map[string][]string{
		"rooms":    {config.ManageRooms},
		"accounts": {config.ManageAccounts},
	}

	for name, can := range people {
		if err := st.AddAdmin(store.Admin{
			Trip: room.Trip(tripKey, name+"'s passphrase"), Name: name, Can: can,
		}); err != nil {
			t.Fatal(err)
		}
	}

	mux := app.Handler()

	for _, name := range []string{"accounts", "rooms"} {
		t.Run(name, func(t *testing.T) {
			if _, err := st.OpenRoom("standup", true); err != nil {
				t.Fatal(err)
			}

			if err := st.PlaceRoom("standup", "open"); err != nil {
				t.Fatal(err)
			}

			// In the call as a guest, so nothing about the identity says who
			// they are and only the management session can.
			guest, _ := tokenFor(t, "standup", "")

			signed := ask(mux, asking(http.MethodPost, "/api/admin/session", "",
				`{"name":"`+name+`","passphrase":"`+name+`'s passphrase"}`))
			if signed.Code != http.StatusOK {
				t.Fatalf("signing in to the management pages answered %d", signed.Code)
			}

			request := asking(http.MethodPut, "/api/rooms/standup/relay", guest, `{"relay":"reserved"}`)
			for _, cookie := range signed.Result().Cookies() {
				request.AddCookie(cookie)
			}

			got := ask(mux, request)
			held, _ := st.HeldOn("standup")

			switch name {
			case "rooms":
				// No media server behind these tests, so the close after the
				// move cannot happen; what matters is that it was written down.
				if held != "reserved" {
					t.Errorf("an administrator given the rooms moved a room onto a reserved relay "+
						"and got %d, the room held on %q", got.Code, held)
				}

			case "accounts":
				if got.Code != http.StatusForbidden || held == "reserved" {
					t.Errorf("an administrator given only the accounts moved a room onto a reserved "+
						"relay: %d, held on %q", got.Code, held)
				}
			}
		})
	}
}
