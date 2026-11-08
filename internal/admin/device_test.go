package admin

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
What somebody came in with reaches the page that asks.

The join writes it into the arrival (internal/app/device.go); the history is
built here field by field rather than by handing the arrival over, so a field
the store keeps and this forgets is a column that is empty on the page for
ever, with nothing anywhere saying why.
*/

// A store with one visit in it, from an iPhone.
type oneVisit struct{ unwritten }

func (oneVisit) Visits(string, int) ([]store.Visit, int) {
	return []store.Visit{{
		Identity: "gabcdefghij-0123456789abcdef0123456789abcdef",
		Arrival: store.Arrival{
			Name:   "somebody",
			Client: &store.Client{Kind: "iphone", App: "0.1.0.8", System: "iOS 27.0.1", Device: "iPhone17,1"},
			At:     time.Now().UTC(),
		},
	}}, 1
}

func TestTheHistorySaysWhatEachJoinCameFrom(t *testing.T) {
	api, mux := mount(t, []config.Admin{{Trip: room.Trip(key, "observer"), Can: []string{config.Observe}}})
	api.store = oneVisit{}
	cookie := signIn(t, api, "observer")

	recorder := call(mux, http.MethodGet, "/api/admin/rooms/standup/visits", cookie, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("visits answered %d: %s", recorder.Code, recorder.Body.String())
	}

	var said struct {
		Visits []struct {
			Client *store.Client `json:"client"`
		} `json:"visits"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(said.Visits) != 1 || said.Visits[0].Client == nil {
		t.Fatalf("the history did not say what the join came from: %s", recorder.Body.String())
	}
	if got := *said.Visits[0].Client; got.Kind != "iphone" || got.App != "0.1.0.8" || got.Device != "iPhone17,1" {
		t.Errorf("client read back as %+v", got)
	}
}

/*
And per person, on the accounts page, which is where "what does she use" is
asked: until the list carried it, the answer meant opening every room's history
and finding her in each. Through the router, with the store the deployment
runs, so a list that forgot to ask the joins — or asked them and dropped the
answer on the way to the page — is a page that says nothing about anybody's
devices, with nothing anywhere saying why.
*/
func TestTheAccountsSayWhatEachJoinedFrom(t *testing.T) {
	api, mux, _, st, moderator, _ := desk(t)
	api.store = st

	ada := "a" + room.Trip(key, "ada's passphrase") + "-0123456789abcdef"
	if err := st.Arrived("standup", ada, store.Arrival{
		Client: &store.Client{Kind: "windows", App: "0.1.2.4", System: "Windows 11"},
		At:     time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}

	recorder := call(mux, http.MethodGet, "/api/admin/accounts", moderator, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("accounts answered %d: %s", recorder.Code, recorder.Body.String())
	}

	var said []struct {
		Name    string       `json:"name"`
		Devices []store.Seen `json:"devices"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &said); err != nil {
		t.Fatalf("decode: %v", err)
	}

	if len(said) != 1 || len(said[0].Devices) != 1 {
		t.Fatalf("ada's row did not say what she joined from: %s", recorder.Body.String())
	}
	if got := said[0].Devices[0]; got.Client.Kind != "windows" || got.Room != "standup" {
		t.Errorf("read back as %+v", got)
	}
}
