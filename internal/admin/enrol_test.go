package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"tomoshibi/internal/config"
	"tomoshibi/internal/room"
	"tomoshibi/internal/store"
)

/*
This endpoint exchanges a string for the credential every relay in the
deployment signs with, the redis password, and a private key. It is the most
valuable thing this server will hand to an unauthenticated caller, and the only
thing in front of it is one comparison.

So what is tested here is mostly refusal: a wrong secret, an empty one, a prefix
that would become something other than a DNS label, an address that is not one.
Each of those is a way somebody could arrive at the credentials, and each has to
end in the same place.

The rest is the property the automation exists for — that a machine which runs
the script is, afterwards, a relay this deployment knows about and points a name
at.
*/

// relayList is a store of relays somebody wrote down.
type relayList struct {
	mu     sync.Mutex
	relays []store.Relay
}

func (r *relayList) Relays() ([]store.Relay, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]store.Relay(nil), r.relays...), nil
}

func (r *relayList) AddRelay(relay store.Relay) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for _, existing := range r.relays {
		if existing.Name == relay.Name {
			return store.ErrRelayExists
		}
	}

	r.relays = append(r.relays, relay)
	return nil
}

func (r *relayList) UpdateRelay(relay store.Relay) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == relay.Name {
			r.relays[i] = relay
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

func (r *relayList) RemoveRelay(name string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == name {
			r.relays = append(r.relays[:i], r.relays[i+1:]...)
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

// ReorderRelays puts them in the order given, so that a caller which claims to
// have reordered can be checked rather than believed.
func (r *relayList) ReorderRelays(names []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	at := make(map[string]int, len(names))
	for position, name := range names {
		at[name] = position + 1
	}

	for i := range r.relays {
		if position, ok := at[r.relays[i].Name]; ok {
			r.relays[i].Order = position
		}
	}

	return nil
}

// RenameRelay moves one, so that a test can check a rename happened rather than
// take a caller's word for it.
func (r *relayList) RenameRelay(from, to string) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	for i := range r.relays {
		if r.relays[i].Name == from {
			r.relays[i].Name = to
			return nil
		}
	}

	return store.ErrNoSuchRelay
}

// naming records what it was asked to point where.
type naming struct {
	mu      sync.Mutex
	pointed map[string]string
	fail    error
}

func (n *naming) Point(host, addr string) error {
	n.mu.Lock()
	defer n.mu.Unlock()

	if n.fail != nil {
		return n.fail
	}

	if n.pointed == nil {
		n.pointed = map[string]string{}
	}
	n.pointed[host] = addr

	return nil
}

func (n *naming) Unpoint(host string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.pointed, host)
	return nil
}

const enrolSecret = "a secret that lives in the install script"

func enrolling(t *testing.T) (*API, *relayList, *naming, http.Handler) {
	t.Helper()

	dir := t.TempDir()
	certPath := filepath.Join(dir, "cert.pem")
	keyPath := filepath.Join(dir, "key.pem")

	if err := os.WriteFile(certPath, []byte("-----BEGIN CERTIFICATE-----\nnot really\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, []byte("-----BEGIN EC PRIVATE KEY-----\nnot really\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	key := make([]byte, 32)

	conf := &config.Config{
		Key:    "APIkey",
		Secret: "the deployment secret nobody unauthenticated should see",
		Meet: config.Meet{
			Role:      config.RoleControl,
			JoinRate:  1000,
			JoinBurst: 1000,
			Admins:    []config.Admin{{Trip: room.Trip(key, "a passphrase"), Name: "adam"}},
		},
	}

	api := New(conf, nil, nil, key)
	t.Cleanup(api.Close)

	relays := &relayList{}
	api.relays = relays

	names := &naming{}

	api.UseEnrolment(&Enrolment{
		Secret: enrolSecret, Domain: "relay.example.invalid",
		PublicURL: "https://meet.example.invalid",
		RedisAddr: "redis.invalid:6379", RedisPassword: "redis password",
		CertPath: certPath, KeyPath: keyPath,
		ListenPort: 13377, UDPPort: 13378, TCPPort: 13379,
		Naming: names,
	})

	mux := http.NewServeMux()
	api.MountEnrolment(mux)

	return api, relays, names, mux
}

func enrolRequest(body string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/api/enrol", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = "203.0.113.7:5555"

	return request
}

func TestAMachineWithTheSecretIsEnrolled(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","region":"jp","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("enrolment answered %d: %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Host != "tokyo.relay.example.invalid" {
		t.Errorf("host came back as %q", got.Host)
	}

	if got.URL != "wss://tokyo.relay.example.invalid:13377" {
		t.Errorf("url came back as %q; a relay must be dialled over wss on the deployment's port",
			got.URL)
	}

	if got.APISecret == "" || got.RedisAddr == "" || got.Cert == "" || got.Key == "" {
		t.Error("the package is missing something a relay cannot start without")
	}

	if !got.Named {
		t.Error("the package says no name was created, and one was")
	}

	if names.pointed["tokyo.relay.example.invalid"] != "198.51.100.9" {
		t.Errorf("the name was pointed at %q", names.pointed["tokyo.relay.example.invalid"])
	}

	// The whole point of the automation: afterwards, this deployment knows
	// about the relay without anybody adding it.
	list, _ := relays.Relays()
	if len(list) != 1 || list[0].Name != "tokyo" || !list[0].Enabled {
		t.Errorf("the relay list is %+v; the machine should be in it and taking calls", list)
	}
}

// The trust boundary, and the only thing in front of the deployment's secret.
func TestAWrongSecretGetsNothing(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	for _, secret := range []string{
		"",
		"wrong",
		enrolSecret + "x",
		strings.ToUpper(enrolSecret),
		enrolSecret[:len(enrolSecret)-1],
	} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": secret, "prefix": "tokyo", "address": "198.51.100.9",
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		if recorder.Code != http.StatusForbidden {
			t.Errorf("secret %q answered %d, wanted 403", secret, recorder.Code)
		}

		if strings.Contains(recorder.Body.String(), "the deployment secret") {
			t.Fatalf("secret %q was refused and the answer carried the credentials anyway", secret)
		}
	}

	if list, _ := relays.Relays(); len(list) != 0 {
		t.Errorf("a refused machine was added to the relay list: %+v", list)
	}

	if len(names.pointed) != 0 {
		t.Errorf("a refused machine had a name pointed at it: %v", names.pointed)
	}
}

// A prefix becomes a name in a zone this deployment controls. Anything that is
// not a label has to be refused before it gets there.
func TestAPrefixThatIsNotALabelIsRefused(t *testing.T) {
	_, _, names, mux := enrolling(t)

	for _, prefix := range []string{
		"", "-leading", "trailing-", "has space", "has.dot", "under_score",
		"UPPER!", "*", "../escape", strings.Repeat("x", 64),
	} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": enrolSecret, "prefix": prefix, "address": "198.51.100.9",
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		// The specific code, not merely "not 200": a route that does not exist
		// also answers something other than 200, and an earlier version of this
		// test passed against a 404 while the guard it names was never reached.
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("prefix %q answered %d, wanted 400", prefix, recorder.Code)
		}
	}

	if len(names.pointed) != 0 {
		t.Errorf("a refused prefix reached the zone: %v", names.pointed)
	}
}

func TestAnAddressThatIsNotOneIsRefused(t *testing.T) {
	_, _, _, mux := enrolling(t)

	for _, address := range []string{"not-an-ip", "example.com", "999.1.1.1", "1.1.1.1;rm -rf /"} {
		recorder := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]string{
			"secret": enrolSecret, "prefix": "tokyo", "address": address,
		})
		mux.ServeHTTP(recorder, enrolRequest(string(body)))

		if recorder.Code != http.StatusBadRequest {
			t.Errorf("address %q answered %d, wanted 400", address, recorder.Code)
		}
	}
}

// A machine that does not name its own address is pointed at the one the
// request came from, which is what a machine behind NAT needs.
func TestTheCallersAddressIsUsedWhenNoneIsGiven(t *testing.T) {
	_, _, names, mux := enrolling(t)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("answered %d: %s", recorder.Code, recorder.Body)
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "203.0.113.7" {
		t.Errorf("the name was pointed at %q, wanted the address the request came from", got)
	}
}

// A prefix already in use is refused, and nothing is touched.
//
// The dangerous case is the typo rather than the deliberate rebuild. Two
// machines given one prefix means the name points at the second while the first
// goes on holding calls at an address that no longer reaches it — and nothing
// anywhere says so. This used to update silently.
func TestATakenPrefixIsRefusedAndChangesNothing(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if first.Code != http.StatusOK {
		t.Fatalf("first enrolment answered %d", first.Code)
	}

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.10"}`))

	if second.Code != http.StatusConflict {
		t.Fatalf("a second machine took the prefix %q and answered %d, wanted 409",
			"tokyo", second.Code)
	}

	// And crucially: the name still points where it did. An earlier version
	// created the record before checking, so the refusal was honest and the
	// existing relay had already been unreachable by then.
	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.9" {
		t.Errorf("the name moved to %q on a refused enrolment; the relay holding calls "+
			"there is now at an address nobody resolves", got)
	}

	list, _ := relays.Relays()
	if len(list) != 1 || list[0].URL != "wss://tokyo.relay.example.invalid:13377" {
		t.Errorf("the relay list changed on a refused enrolment: %+v", list)
	}
}

// Saying so takes it over, which is what a rebuilt machine needs.
func TestReplacingATakenPrefixIsAllowedWhenAsked(t *testing.T) {
	_, relays, names, mux := enrolling(t)

	first := httptest.NewRecorder()
	mux.ServeHTTP(first, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if first.Code != http.StatusOK {
		t.Fatalf("first enrolment answered %d", first.Code)
	}

	second := httptest.NewRecorder()
	mux.ServeHTTP(second, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.10","replace":true}`))

	if second.Code != http.StatusOK {
		t.Fatalf("an asked-for replacement answered %d: %s", second.Code, second.Body)
	}

	if list, _ := relays.Relays(); len(list) != 1 {
		t.Errorf("replacing produced %d relays, wanted 1", len(list))
	}

	if got := names.pointed["tokyo.relay.example.invalid"]; got != "198.51.100.10" {
		t.Errorf("the name still points at %q after the machine was replaced", got)
	}
}

// DNS failing must not fail the install. Everything else about the relay is
// correct and a name added by hand finishes it, which is a better end than
// refusing work that has already been done.
func TestAFailedNamingStillEnrols(t *testing.T) {
	_, relays, names, mux := enrolling(t)
	names.fail = errAsIf("cloudflare refused")

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("a naming failure refused the whole enrolment: %d %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	_ = json.Unmarshal(recorder.Body.Bytes(), &got)

	if got.Named {
		t.Error("the package claims a name was created and none was; the script would not " +
			"tell anybody to point it")
	}

	if list, _ := relays.Relays(); len(list) != 1 {
		t.Error("the relay was not recorded")
	}
}

type errAsIf string

func (e errAsIf) Error() string { return string(e) }

// The script carries the secret, so it is not a public document.
func TestTheScriptIsNotServedWithoutASession(t *testing.T) {
	api, _, _, _ := enrolling(t)

	mux := http.NewServeMux()
	api.Mount(mux)

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/relays/script", nil))

	if recorder.Code == http.StatusOK {
		t.Fatal("the install script was served to a caller with no session, and it carries " +
			"the enrolment secret")
	}

	if strings.Contains(recorder.Body.String(), enrolSecret) {
		t.Fatal("the refusal carried the secret")
	}
}

/*
What a reinstall must not take with it.

Both faults below are of one kind: an operation that was correct about the thing
it was named for and wrong about everything beside it. Neither could fail
visibly — the relay came back and worked, the removed relay went away — so
neither had a symptom that pointed anywhere near its cause.
*/

// A relay's role in the topology is not the installer's to forget.
//
// The installer knows four things: what the machine is called, where it is, how
// to reach it, and that it is in service. Everything else — which machines it
// carries for, which it may not be paired with, which one it reaches the others
// through, where it sits on the map — was configured by somebody afterwards, and
// a replacing enrolment used to write over all of it with zero.
func TestReinstallingARelayKeepsWhatSomebodyConfiguredOnIt(t *testing.T) {
	_, relays, _, mux := enrolling(t)

	// Enrolled once, then given a role.
	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"hongkong","region":"hk","address":"198.51.100.9"}`,
	)); code != http.StatusOK {
		t.Fatalf("the first enrolment answered %d", code)
	}

	list, _ := relays.Relays()
	configured := list[0]
	configured.Label = "HK Gomami"
	configured.Bridge = true
	configured.Forwards = true
	configured.Apart = []string{"shanghai-ct"}
	configured.Probe = "198.51.100.9:39218"
	configured.Lat, configured.Lon = 22.3, 114.2
	configured.AdminOnly = true
	configured.Order = 3

	if err := relays.UpdateRelay(configured); err != nil {
		t.Fatal(err)
	}

	// The machine is rebuilt and enrols again onto the same prefix, this time
	// from a new address and with the region corrected.
	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"hongkong","region":"hk-east",`+
			`"address":"203.0.113.44","replace":true}`,
	)); code != http.StatusOK {
		t.Fatalf("the replacing enrolment answered %d", code)
	}

	list, _ = relays.Relays()
	if len(list) != 1 {
		t.Fatalf("there are %d relays and there should be one", len(list))
	}

	after := list[0]

	// The four the installer owns did move.
	if after.Region != "hk-east" {
		t.Errorf("the region is %q; the enrolment is the authority on that", after.Region)
	}

	// And nothing else did.
	if !after.Bridge {
		t.Error("the bridge was forgotten: two machines that reached each other through " +
			"this one now reach each other not at all, and nothing says so")
	}

	if !after.Forwards || len(after.Apart) != 1 {
		t.Errorf("forwards %v and apart %v: that this machine carries calls it is not "+
			"holding, and the one machine it must never be paired with, were both "+
			"written over with nothing", after.Forwards, after.Apart)
	}

	if after.Probe == "" || after.Lat == 0 || after.Lon == 0 || after.Label == "" ||
		after.Order != 3 || !after.AdminOnly {
		t.Errorf("a reinstall cleared what somebody set: %+v", after)
	}
}

// And a relay that is removed takes its name with it.
//
// A name left pointing at an address is a name that goes on resolving after the
// provider hands that address to somebody else, under a host this deployment
// created and a client may still have written down.
// And the name it removes is the one the relay actually has.
//
// The host is built from the address rather than from the relay's name, because
// those are the same thing only until somebody renames the relay — and renaming
// is ordinary: the name typed on a machine being set up is short, and the name a
// page shows is not. Removing a relay called "GZ Volcano" asked the zone to
// delete "GZ Volcano.relays.example", which is not a name, and left the record it
// really had resolving to a machine that was gone.
func TestTheNameRemovedIsTheOneTheRelayAnswersTo(t *testing.T) {
	api, relays, names, mux := enrolling(t)

	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"osaka","region":"jp","address":"198.51.100.9"}`,
	)); code != http.StatusOK {
		t.Fatalf("enrolment answered %d", code)
	}

	// Renamed afterwards, which is what breaks the naive version.
	if err := relays.RenameRelay("osaka", "JP Osaka"); err != nil {
		t.Fatal(err)
	}

	api.conf.Meet.Admins[0].Can = []string{config.Moderate}

	_, token, ok := api.sessions.Open("", "a passphrase")
	if !ok {
		t.Fatal("could not open a management session")
	}

	managing := http.NewServeMux()
	api.Mount(managing)

	if code := ask(t, managing, http.MethodDelete, "/api/admin/relays/JP%20Osaka", token).Code; code != http.StatusOK {
		t.Fatalf("removing the relay answered %d", code)
	}

	if addr, still := names.pointed["osaka.relay.example.invalid"]; still {
		t.Errorf("the record still resolves, to %s: the name was built from what the relay "+
			"is called rather than from the address it answers at, so a rename left it "+
			"behind", addr)
	}
}

// A relay dialled by bare address has no name to remove, and asking the zone to
// delete one would be asking it to delete an address.
func TestARelayDialledByAddressHasNoNameToRemove(t *testing.T) {
	if got := hostOf("wss://198.51.100.9:39217"); got != "" {
		t.Errorf("hostOf on an address gave %q, want empty", got)
	}

	if got := hostOf("wss://osaka.relay.example.invalid:39217"); got != "osaka.relay.example.invalid" {
		t.Errorf("hostOf gave %q", got)
	}
}

func TestRemovingARelayRemovesTheNamePointedAtIt(t *testing.T) {
	api, relays, names, mux := enrolling(t)

	if code := post(mux, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"osaka","region":"jp","address":"198.51.100.9"}`,
	)); code != http.StatusOK {
		t.Fatalf("enrolment answered %d", code)
	}

	if names.pointed["osaka.relay.example.invalid"] == "" {
		t.Fatal("the enrolment did not create a name, so this test proves nothing")
	}

	managing := http.NewServeMux()
	api.Mount(managing)

	// The passphrase enrolling() configures an administrator with, and the
	// capability removing a relay asks for.
	api.conf.Meet.Admins[0].Can = []string{config.Moderate}

	_, token, ok := api.sessions.Open("", "a passphrase")
	if !ok {
		t.Fatal("could not open a management session")
	}

	if code := ask(t, managing, http.MethodDelete, "/api/admin/relays/osaka", token).Code; code != http.StatusOK {
		t.Fatalf("removing the relay answered %d", code)
	}

	if list, _ := relays.Relays(); len(list) != 0 {
		t.Fatalf("the relay is still on the list")
	}

	if addr, still := names.pointed["osaka.relay.example.invalid"]; still {
		t.Errorf("the name still resolves, to %s: the machine is gone and this address will "+
			"be somebody else's", addr)
	}
}

// post runs one enrolment request and gives back its status.
func post(mux http.Handler, request *http.Request) int {
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	return recorder.Code
}

/*
What a relay is told about where everything is.

An enrolment used to write neither a region nor a region list, which left the
media server on a new machine falling back to the selector that picks a node at
random. That is not a degraded choice — it is the fault that put somebody who
joined through Shanghai into a room held in Hong Kong, on a path that does not
carry between those two. It was found once, fixed by hand on every machine then
running, and left untouched in the script that brings new ones up, so it was
waiting for the next relay rather than fixed.
*/

func TestAnEnrolledRelayIsToldWhereEverythingIs(t *testing.T) {
	_, relays, _, mux := enrolling(t)

	// A fleet with locations, which is what makes a region list mean anything.
	for _, existing := range []store.Relay{
		{Name: "HK Gomami", Region: "hk", URL: "wss://hk.invalid", Enabled: true, Lat: 22.32, Lon: 114.17},
		{Name: "SG Misaka", Region: "sg", URL: "wss://sg.invalid", Enabled: true, Lat: 1.35, Lon: 103.82},
	} {
		if err := relays.AddRelay(existing); err != nil {
			t.Fatal(err)
		}
	}

	// The machine being brought up, already known and located — which is the
	// case a replacing enrolment is.
	if err := relays.AddRelay(store.Relay{
		Name: "tokyo", Region: "jp", URL: "wss://tokyo.invalid", Enabled: true,
		Lat: 35.68, Lon: 139.69,
	}); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"tokyo","region":"jp",`+
			`"address":"198.51.100.9","replace":true}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("enrolment answered %d: %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Node == "" {
		t.Fatal("the package does not say what this machine should call the place it is in, " +
			"so its media server has no region and chooses nodes at random")
	}

	if got.Selector == "" {
		t.Fatal("the package carries no region list, so the media server falls back to the " +
			"selector that picks a node at random")
	}

	// The one thing about that list that must hold: it names the machine
	// reading it. A media server given a list its own region is missing from
	// does not degrade — it refuses to start.
	if !strings.Contains(got.Selector, "name: "+got.Node) {
		t.Errorf("the region list does not name this machine's own region %q, which is a "+
			"relay that will not come up:\n%s", got.Node, got.Selector)
	}

	if !strings.Contains(got.Selector, "kind: regionaware") {
		t.Errorf("the block does not ask for the region-aware selector:\n%s", got.Selector)
	}

	for _, elsewhere := range []string{"hk-gomami", "sg-misaka"} {
		if !strings.Contains(got.Selector, "name: "+elsewhere) {
			t.Errorf("the list leaves out %s, so this machine can never place a call there "+
				"and can never overflow onto it:\n%s", elsewhere, got.Selector)
		}
	}
}

// A relay whose position nobody recorded is given no block at all.
//
// The alternative is worse than useless: a list built without it does not name
// its region, and a media server whose own region is missing from its list
// refuses to start — so the install would finish, the certificate would be
// written, the name would be pointed, and the service would not come up.
func TestARelayWithNoPositionIsNotGivenAListThatWouldStopItStarting(t *testing.T) {
	_, relays, _, mux := enrolling(t)

	for _, existing := range []store.Relay{
		{Name: "HK Gomami", Region: "hk", URL: "wss://hk.invalid", Enabled: true, Lat: 22.32, Lon: 114.17},
		{Name: "SG Misaka", Region: "sg", URL: "wss://sg.invalid", Enabled: true, Lat: 1.35, Lon: 103.82},
	} {
		if err := relays.AddRelay(existing); err != nil {
			t.Fatal(err)
		}
	}

	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, enrolRequest(
		`{"secret":"`+enrolSecret+`","prefix":"nowhere","region":"jp","address":"198.51.100.9"}`))

	if recorder.Code != http.StatusOK {
		t.Fatalf("enrolment answered %d: %s", recorder.Code, recorder.Body)
	}

	var got enrolPackage
	if err := json.Unmarshal(recorder.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}

	if got.Selector != "" {
		t.Errorf("a relay with no recorded position was handed a region list it is not in, "+
			"which is a media server that refuses to start:\n%s", got.Selector)
	}
}
