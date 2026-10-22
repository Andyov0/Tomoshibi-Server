package admin

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
	"tomoshibi/internal/dns"
	"tomoshibi/internal/limit"

	"tomoshibi/internal/store"
)

/*
Bringing a relay up by hand is five things that must agree: the binary, the
deployment's credentials, the redis address, the certificate, and a DNS name
pointing at the machine. Getting any one wrong produces a relay that starts
cleanly and fails in a way that looks like something else — the wrong secret
answers 401 to every join, no redis makes an island whose calls cannot hear the
others, and a name that does not resolve is refused by browsers with nothing in
the relay's own log to say why.

So all five are done by the machine itself, from a script, against the control
node that already holds every one of them. What somebody types is a prefix.

The secret in that script is the whole of the security here, and what it buys is
the credential every relay signs with. The script is therefore not a public
document: it is fetched from the management pages by somebody signed in, and
anybody holding a copy can enrol a relay into this deployment. That trade is
made deliberately — the alternative is a per-machine token that has to be
minted, carried, and pasted inside its lifetime, which is the ceremony this
exists to remove.
*/

// Naming is where a relay's DNS record goes.
//
// Created by the control node rather than by hand, because a relay whose name
// does not resolve is indistinguishable from the outside from one that is down,
// and the machine cannot create the record itself without holding credentials
// to the whole zone.
type Naming interface {
	Point(host, addr string) error
	Unpoint(host string) error
}

// Enrolment is what a control node tells a new relay.
type Enrolment struct {
	// Secret is what the install script proves it has. Long-lived, because the
	// script is meant to be kept and pasted into whatever machine comes next.
	Secret string

	// Domain is the zone relays are named under: a prefix of `tokyo` under
	// `relay.example.com` makes `tokyo.relay.example.com`.
	Domain string

	// PublicURL is where a new machine fetches from.
	PublicURL string

	RedisAddr     string
	RedisPassword string

	CertPath string
	KeyPath  string

	ListenPort int
	UDPPort    int
	TCPPort    int

	// Where a new relay answers STUN. Zero writes nothing, which is what a
	// deployment that has not chosen a port should get rather than a zero.
	ProbePort int

	// Naming creates the DNS record. Optional: without it a relay still enrols
	// and whoever ran the script is told to point the name themselves.
	Naming Naming
}

// Configured reports whether a relay can be brought up from a script.
func (e *Enrolment) Configured() bool {
	return e != nil && e.Secret != "" && e.Domain != ""
}

func (e *Enrolment) hostFor(prefix string) string {
	return prefix + "." + strings.Trim(e.Domain, ".")
}

// validPrefix says whether a prefix can be a DNS label.
//
// Checked rather than trusted: it becomes a name in a zone this deployment
// controls, sent by a machine somebody is in the middle of setting up. A typo
// should be a sentence rather than a record to be found and removed later.
func validPrefix(prefix string) bool {
	if len(prefix) == 0 || len(prefix) > 63 {
		return false
	}

	if prefix[0] == '-' || prefix[len(prefix)-1] == '-' {
		return false
	}

	for _, r := range prefix {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
		default:
			return false
		}
	}

	return true
}

// enrolPackage is what a relay is handed once it has proved the secret.
type enrolPackage struct {
	Name   string `json:"name"`
	Host   string `json:"host"`
	URL    string `json:"url"`
	Region string `json:"region,omitempty"`

	// Node is what this machine's media server should call the place it is in,
	// and Regions is where every machine in the fleet is.
	//
	// Both are written into the relay's configuration by the install script.
	// Without them the media server falls back to choosing a node at random,
	// which is how somebody joining through Shanghai ended up in a room held in
	// Hong Kong that they could not reach — a fault that was found once, fixed
	// by hand on every machine then running, and left in the script that brings
	// new ones up.
	// Rendered here rather than sent as an array, because the install script
	// reads this package with sed — a machine being brought up may have neither
	// jq nor python, and installing one to read a list is a dependency for the
	// sake of elegance. Newlines arrive escaped and are turned back the same way
	// the certificate's are.
	Node     string `json:"node,omitempty"`
	Selector string `json:"selector,omitempty"`

	APIKey    string `json:"apiKey"`
	APISecret string `json:"apiSecret"`

	RedisAddr     string `json:"redisAddr"`
	RedisPassword string `json:"redisPassword,omitempty"`

	Cert string `json:"cert"`
	Key  string `json:"key"`

	ListenPort int `json:"listenPort"`
	UDPPort    int `json:"udpPort"`
	TCPPort    int `json:"tcpPort"`

	// Named says whether the control node created the DNS record. False means
	// the machine is otherwise ready and somebody has to point the name.
	Named bool `json:"named"`
}

// claim is what the install script calls.
//
// Authenticated by the secret rather than by a session: the machine running
// this has no administrator sitting at it. Rate limited by the same limiter the
// sign-in page uses, because an endpoint exchanging a string for the
// deployment's credentials is worth guessing at.
func (a *API) claim(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	caller := limit.Caller(r, a.conf.Meet.Hops())
	attempt, allowed := a.sessions.limit.Take(caller)
	if !allowed {
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}
	defer attempt.Settled()

	var body struct {
		Secret  string `json:"secret"`
		Prefix  string `json:"prefix"`
		Region  string `json:"region"`
		Address string `json:"address"`
		// Replace says this prefix is meant to be taken over.
		//
		// Off by default, which is the change that matters: a prefix somebody
		// typed twice by accident used to quietly move an existing relay's
		// address to the new machine, and the relay it belonged to went on
		// holding calls at a name that no longer pointed at it. Nothing said
		// so. Now it is refused and the script asks for another.
		Replace bool `json:"replace"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	// Constant time: this is the one comparison standing between a stranger and
	// the credential every relay in this deployment signs with.
	if subtle.ConstantTimeCompare([]byte(body.Secret), []byte(a.enrolment.Secret)) != 1 {
		// Charged, which it was not.
		//
		// Asking the limiter costs nothing by design — it is a question, and only
		// a failure spends anything. Both enrolment endpoints asked and neither
		// ever paid, so the comment saying this is "rate limited by the same
		// limiter the sign-in page uses" described a limiter being consulted
		// rather than one being applied: five thousand wrong secrets from one
		// address were five thousand refusals and no throttling at all.
		//
		// What a hit yields is the credential every token on this deployment is
		// signed with, the redis password, and the TLS private key. This is the
		// one unauthenticated door that hands over the whole thing, and the
		// secret behind it is a phrase somebody typed into a configuration file.
		attempt.Failed()

		a.log.Record(Entry{
			Action: "enrol", Trip: "-", Target: body.Prefix,
			Failed: true, Reason: "wrong secret",
		})
		refuse(w, http.StatusForbidden, "wrong_secret")
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	// The address the machine names, and otherwise the one this request came
	// from. A machine behind NAT knows its public address and this server sees
	// it; on a machine with several, the one it names is the one it means.
	address := strings.TrimSpace(body.Address)
	if address == "" {
		address = callerIP(caller)
	}

	if net.ParseIP(address) == nil {
		refuse(w, http.StatusBadRequest, "bad_address")
		return
	}

	host := a.enrolment.hostFor(prefix)

	relay := store.Relay{
		Name:    prefix,
		Region:  strings.TrimSpace(body.Region),
		URL:     fmt.Sprintf("wss://%s:%d", host, a.enrolment.ListenPort),
		Enabled: true,
	}

	if err := relay.Valid(); err != nil {
		refuse(w, http.StatusBadRequest, relayReason(err))
		return
	}

	cert, err := os.ReadFile(a.enrolment.CertPath)
	if err != nil {
		slog.Error("failed to read the certificate for an enrolment", "error", err)
		refuse(w, http.StatusInternalServerError, "no_certificate")
		return
	}

	key, err := os.ReadFile(a.enrolment.KeyPath)
	if err != nil {
		slog.Error("failed to read the certificate key for an enrolment", "error", err)
		refuse(w, http.StatusInternalServerError, "no_certificate")
		return
	}

	// Whether this prefix is taken, checked before anything is changed. The DNS
	// record used to be created first, so a prefix that was then refused had
	// already had the name moved to the new machine — the refusal was honest
	// and the damage was done.
	if taken, err := a.prefixTaken(relay.Name); err == nil && taken && !body.Replace {
		a.log.Record(Entry{
			Action: "enrol", Trip: "-", Target: relay.Name,
			Failed: true, Reason: "prefix already in use",
		})
		refuse(w, http.StatusConflict, "relay_exists")
		return
	}

	named := false
	if a.enrolment.Naming != nil {
		if err := a.enrolment.Naming.Point(host, address); err != nil {
			// Not fatal. Everything else about this relay is correct, and a
			// name added by hand finishes it — a better end than refusing an
			// install that has already done the work.
			slog.Error("failed to create the DNS record for a relay",
				"host", host, "address", address, "error", err)
		} else {
			named = true
			slog.Info("pointed a relay's name at it", "host", host, "address", address)

			// And asked, rather than assumed.
			//
			// A zone accepting a record is not the internet returning it, and
			// the ways those come apart are all quiet: a CNAME above the name
			// shadowing it, the subtree served by somebody else, a conflicting
			// record with higher precedence. Each ends with an API call that
			// succeeded, a log line saying the name was created, and a machine
			// nobody can reach by it — the install finishes, the certificate is
			// written, and the relay never carries a call.
			//
			// In the background because a fresh record is not visible at once
			// and the enrolment must not wait on a resolver; the answer is a
			// line in the log rather than a refusal, because by the time it is
			// known the machine is already up and the honest thing is to say so
			// rather than to undo it.
			go func(host, address string) {
				time.Sleep(dnsSettles)

				switch ok, err := dns.Answers(host, address); {
				case err != nil:
					slog.Warn("could not check whether a relay's name resolves; it may have "+
						"been created and may not be reachable by it",
						"host", host, "error", err)

				case !ok:
					slog.Error("a relay's name was created and does not resolve to it: the "+
						"zone accepted the record and something above it is answering first",
						"host", host, "address", address)

				default:
					slog.Info("a relay's name resolves to it", "host", host)
				}
			}(host, address)
		}
	}

	// A prefix already in use is refused unless somebody said to take it over.
	//
	// The dangerous case is not the deliberate rebuild — it is the typo. Two
	// machines given one prefix means the name points at the second while the
	// first goes on holding calls at an address that no longer reaches it, and
	// nothing anywhere says so. Refusing costs a rebuild one extra word and
	// costs a typo nothing at all.
	if err := a.relays.AddRelay(relay); errors.Is(err, store.ErrRelayExists) {
		if !body.Replace {
			a.log.Record(Entry{
				Action: "enrol", Trip: "-", Target: relay.Name,
				Failed: true, Reason: "prefix already in use",
			})
			refuse(w, http.StatusConflict, "relay_exists")
			return
		}

		// Onto what is already recorded, rather than over it.
		//
		// UpdateRelay replaces the whole record, and the record this handler
		// builds holds the four things an installer knows: name, region,
		// address, and that it is in service. Everything else about a relay is
		// configured afterwards and by somebody — which machines it forwards
		// for, which it may not be paired with, which one it bridges through,
		// where it is on the map, what it is called on screen, where it sits in
		// the list, whether it is reserved, whether it is a fallback.
		//
		// Written over, all of that went to zero on any reinstall, silently and
		// with nothing to point at afterwards: the relay came back, answered,
		// carried calls, and had simply stopped being the hop that two other
		// machines reached each other through. Reinstalling a machine is when
		// somebody is least able to notice its role has been forgotten, because
		// they are already expecting things to be briefly wrong.
		merged, err := a.merged(relay)
		if err != nil {
			refuse(w, http.StatusInternalServerError, relayReason(err))
			return
		}

		if err := a.relays.UpdateRelay(merged); err != nil {
			refuse(w, http.StatusInternalServerError, relayReason(err))
			return
		}

		slog.Info("a relay took over a prefix already in use", "name", relay.Name)
	} else if err != nil {
		refuse(w, http.StatusInternalServerError, relayReason(err))
		return
	}

	a.changed()
	a.log.Record(Entry{Action: "enrol", Trip: "-", Target: relay.Name})

	respond(w, enrolPackage{
		Name: relay.Name, Host: host, URL: relay.URL, Region: relay.Region,
		Node: placeOf(relay), Selector: a.selectorFor(relay),
		APIKey: a.conf.Key, APISecret: a.conf.Secret,
		RedisAddr: a.enrolment.RedisAddr, RedisPassword: a.enrolment.RedisPassword,
		Cert: string(cert), Key: string(key),
		ListenPort: a.enrolment.ListenPort,
		UDPPort:    a.enrolment.UDPPort,
		TCPPort:    a.enrolment.TCPPort,
		Named:      named,
	})
}

// callerIP strips the port an address may carry.
func callerIP(caller string) string {
	if host, _, err := net.SplitHostPort(caller); err == nil {
		return host
	}
	return caller
}

// installScript is what somebody pastes into a new machine.
//
// Served to a signed-in administrator rather than publicly, because it carries
// the enrolment secret. What it does is deliberately readable: anybody about to
// run something as root should be able to see all of it, and every step is one
// they would otherwise be doing by hand.
func (a *API) installScript(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	w.Header().Set("Content-Disposition", `attachment; filename="add-relay.sh"`)

	a.writeInstall(w, a.enrolment.Secret)
}

// installCommand is the one line somebody types on the new machine.
//
// The script is still there to be read — anything about to run as root should
// be readable first, and it is what the download beside this serves. What this
// gives is the shape that gets used: one command, copied, pasted, done. Moving
// a file onto a machine that has no keys on it yet is the step this whole path
// exists to remove, and leaving it as the only option left it half removed.
//
// Behind a session, because the command carries the enrolment secret.
func (a *API) installCommand(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	control := strings.TrimRight(a.enrolment.PublicURL, "/")

	respond(w, map[string]any{
		"command": fmt.Sprintf("bash <(curl -fLSs %s/install) <prefix> %s", control, a.enrolment.Secret),
		"domain":  a.enrolment.Domain,
		"port":    a.enrolment.ListenPort,
	})
}

// PublicInstall serves the same script to anybody, without the secret in it.
//
// So that bringing a relay up is one command copied onto a fresh machine rather
// than a file moved onto it by hand. The secret is not in what is served and not
// in the address either — it travels in the operator's own command, as ENROL, so
// that no proxy log, no CDN, and no shell history on a machine that has not been
// enrolled yet ever holds it.
//
// Public on purpose. What is served is a shell script with this deployment's
// address and ports in it, which is not a secret: the addresses are handed to
// every client that joins, and without the enrolment secret the script can do
// nothing but ask and be refused.
func (a *API) PublicInstall(w http.ResponseWriter, _ *http.Request) {
	if a.enrolment == nil || !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	a.writeInstall(w, "")
}

func (a *API) writeInstall(w http.ResponseWriter, secret string) {
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	fmt.Fprintf(w, installTemplate,
		strings.TrimRight(a.enrolment.PublicURL, "/"),
		a.enrolment.Domain,
		secret,
		a.enrolment.ListenPort, a.enrolment.UDPPort, a.enrolment.TCPPort,
		a.enrolment.ProbePort)
}

// prefixTaken says whether a relay already answers to this name.
func (a *API) prefixTaken(name string) (bool, error) {
	list, err := a.relays.Relays()
	if err != nil {
		return false, err
	}

	for _, relay := range list {
		if relay.Name == name {
			return true, nil
		}
	}

	return false, nil
}

// taken answers whether a prefix is free, for a script about to ask somebody to
// type one.
//
// Behind the enrolment secret, because the list of relay names is not something
// to hand to whoever asks — and whoever holds the secret can read the whole list
// by enrolling anyway.
func (a *API) taken(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	attempt, allowed := a.sessions.limit.Take(limit.Caller(r, a.conf.Meet.Hops()))
	if !allowed {
		refuse(w, http.StatusTooManyRequests, "too_many_attempts")
		return
	}
	defer attempt.Settled()

	var body struct {
		Secret string `json:"secret"`
		Prefix string `json:"prefix"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	if subtle.ConstantTimeCompare([]byte(body.Secret), []byte(a.enrolment.Secret)) != 1 {
		// Charged here too. This endpoint only says whether a name is taken, but
		// it takes the same secret, so an unlimited door beside a limited one is
		// one unlimited door.
		attempt.Failed()

		refuse(w, http.StatusForbidden, "wrong_secret")
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	held, err := a.prefixTaken(prefix)
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	respond(w, map[string]any{"prefix": prefix, "taken": held})
}

// merged carries an existing relay's configuration onto a fresh enrolment.
//
// The installer is the authority on the four fields it fills in and on nothing
// else; the record is the authority on everything a person set. Where the
// existing relay cannot be read the enrolment stands on its own, because an
// install that has already provisioned the machine should finish rather than
// refuse.
func (a *API) merged(fresh store.Relay) (store.Relay, error) {
	list, err := a.relays.Relays()
	if err != nil {
		return store.Relay{}, err
	}

	for _, was := range list {
		if was.Name != fresh.Name {
			continue
		}

		was.Region = fresh.Region
		was.URL = fresh.URL
		was.Enabled = fresh.Enabled

		return was, nil
	}

	return fresh, nil
}

// How long to wait before asking whether a new record resolves.
//
// Long enough that the ordinary case has propagated and short enough that
// somebody watching an install still sees the answer. The record is written
// with a five minute TTL, so a resolver that had the name cached as missing
// will still say so — which is why this reports rather than refuses.
const dnsSettles = 20 * time.Second

// nodeRegion is one place, as the media servers compare places.
type nodeRegion struct {
	Name string  `json:"name"`
	Lat  float64 `json:"lat"`
	Lon  float64 `json:"lon"`
}

// placeOf is the identifier a relay's media server uses for itself.
//
// Recorded on the relay where somebody has said it, and otherwise made from the
// name, which is what the machines standing today were given by hand. Made
// rather than refused because a relay with no identifier is a relay whose media
// server picks nodes at random, and a name always exists.
func placeOf(relay store.Relay) string {
	if relay.Node != "" {
		return relay.Node
	}

	slug := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r == ' ' || r == '_' || r == '-':
			return '-'
		default:
			return -1
		}
	}, relay.Name)

	return strings.Trim(slug, "-")
}

// selectorFor renders the node_selector block a relay is configured with.
//
// Empty when fewer than two relays have a location, because a region list that
// does not include the machine reading it makes the media server refuse to
// start — and one holding only that machine decides nothing. In both cases the
// relay is better off with the block absent.
func (a *API) selectorFor(relay store.Relay) string {
	regions := a.fleetRegions()
	if len(regions) < 2 {
		// Nothing to choose between, so no block — and a relay without one falls
		// back to picking a media node at random, which is the fault recorded in
		// internal/store/relays.go as having put people into meetings on machines
		// they could not reach.
		//
		// Fewer than two regions almost always means nobody has given the relays
		// a place. The management page has a field for it; until this was said,
		// the only way to find out it mattered was for calls to be bad.
		slog.Warn("this deployment has fewer than two relays with a place recorded, so new "+
			"relays are brought up without distance-aware node selection: set where each "+
			"machine is, on the relay page",
			"relay", relay.Name, "placed", len(regions))

		return ""
	}

	here := placeOf(relay)

	var found bool
	for _, region := range regions {
		if region.Name == here {
			found = true
			break
		}
	}

	// The machine being enrolled has no location recorded yet, so it is not in
	// the list it would be given — and a media server whose own region is
	// unknown to its own list refuses to start. Better no block, which means the
	// default selector, than a relay that will not come up.
	if !found {
		slog.Warn("this relay has no place recorded, so it is brought up without distance-aware "+
			"node selection: a media server whose own region is missing from its own list "+
			"refuses to start, so no block is written rather than one it would reject",
			"relay", relay.Name)

		return ""
	}

	block := "\nnode_selector:\n  kind: regionaware\n  sysload_limit: 0.9\n  regions:\n"
	for _, region := range regions {
		block += fmt.Sprintf("    - name: %s\n      lat: %g\n      lon: %g\n",
			region.Name, region.Lat, region.Lon)
	}

	return block
}

// fleetRegions is where every relay is, for the list each media server is given.
//
// Only the ones whose location somebody has recorded. A relay left out cannot be
// chosen by distance and cannot be overflowed onto, which is a smaller fault
// than the alternative: a guessed position places real calls on a machine
// somebody picked for being near a place it is not near.
func (a *API) fleetRegions() []nodeRegion {
	list, err := a.relays.Relays()
	if err != nil {
		return nil
	}

	out := make([]nodeRegion, 0, len(list))

	for _, relay := range list {
		if relay.Lat == 0 && relay.Lon == 0 {
			continue
		}

		out = append(out, nodeRegion{Name: placeOf(relay), Lat: relay.Lat, Lon: relay.Lon})
	}

	return out
}
