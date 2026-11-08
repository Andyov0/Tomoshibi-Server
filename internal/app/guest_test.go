package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tomoshibi/internal/config"
)

/*
A guest's identity is on every roster in the room, and the media server seats
whoever presents an identity already there and removes the one who had it. So
the join keeps an issued identity only for the tab it was issued to — the one
holding the proof that came with it — and gives anybody else who sends it a
fresh one. Through the router, with an operator's pin on the guest, because the
pin is the other thing the copy used to take.
*/

func guestJoin(t *testing.T, mux http.Handler, identity, proof string) (string, string, string) {
	t.Helper()

	body, _ := json.Marshal(map[string]string{"name": "Guest", "identity": identity, "proof": proof, "relay": "shanghai"})
	request := httptest.NewRequest(http.MethodPost, "/api/rooms/standup/join", strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")

	recorder := ask(mux, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("a guest's join answered %d: %s", recorder.Code, recorder.Body)
	}

	var said struct {
		Identity string `json:"identity"`
		Proof    string `json:"proof"`
		URL      string `json:"url"`
	}
	_ = json.Unmarshal(recorder.Body.Bytes(), &said)

	return said.Identity, said.Proof, said.URL
}

func TestAGuestsIdentityIsKeptByTheirTabAndNobodyElse(t *testing.T) {
	mux, st, _ := controlWithStore(t, config.PickProbe,
		forwarder("shanghai", "wss://sh.example.invalid", "sh.example.invalid:39219"),
		forwarder("guangzhou", "wss://gz.example.invalid", "gz.example.invalid:39219"),
	)

	identity, proof, _ := guestJoin(t, mux, "", "")
	if proof == "" {
		t.Fatal("a guest was given no proof to keep their identity with")
	}

	if err := st.PinEntry("standup", identity, "guangzhou"); err != nil {
		t.Fatal(err)
	}

	// Somebody else in the room, sending back what they read off the roster.
	copied, _, url := guestJoin(t, mux, identity, "")
	if copied == identity {
		t.Fatal("somebody holding only a guest's identity was seated as them, which removes the guest")
	}

	if url == "wss://gz.example.invalid" {
		t.Error("the copy took the pin an operator set on the guest")
	}

	// The guest's own tab, reloading.
	again, _, url := guestJoin(t, mux, identity, proof)
	if again != identity {
		t.Errorf("the guest's own tab, with its proof, was given %q instead of %q", again, identity)
	}

	if url != "wss://gz.example.invalid" {
		t.Errorf("the guest's pin was not theirs when they came back: %s", url)
	}

}
