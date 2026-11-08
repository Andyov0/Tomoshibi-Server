package admin

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
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
node that already holds every one of them. What somebody types is a prefix, and
what they paste is a token.

The token is the whole of the security here, and what it buys is the credential
every relay signs with, the redis password and the certificate's private key.
It used to be one long-lived secret from the configuration file, embedded in the
command the management pages printed: kept, pasted into every machine ever
brought up, left in each one's shell history, never used up and never expired.
The ceremony that was avoided by not minting a token per machine turned out to
be the whole of the protection, so a token is minted per machine now — by an
administrator, for one prefix, for half an hour, once (store/enrolments.go).
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

// Enrolments is where enrolment tokens wait to be used.
//
// Its own interface for the reason the package names narrow ones at all: the
// door that hands over the deployment has to be exercised by a test without a
// database behind it, and the one-use rule is the store's to keep.
type Enrolments interface {
	KeepEnrolGrant(token string, grant store.EnrolGrant) (store.EnrolGrant, error)
	EnrolGrant(token string, now time.Time) (store.EnrolGrant, bool)
	SpendEnrolGrant(token string, now time.Time) (store.EnrolGrant, error)
	EnrolGrants(now time.Time) ([]store.EnrolGrant, error)
	WithdrawEnrolGrant(id string) (bool, error)
}

// Enrolment is what a control node tells a new relay.
type Enrolment struct {
	// Secret is the long-lived enrolment secret this deployment used to run on.
	//
	// Ignored unless AcceptSecret says otherwise, and never good for taking over
	// a prefix already in use. It is kept readable for one reason: a fleet being
	// upgraded may have a machine half way through being brought up with an old
	// command, and the operator should be able to finish that by setting one
	// switch rather than by editing code. Every use is logged at warning level.
	Secret       string
	AcceptSecret bool

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

	// BinarySum is the SHA-256 of the binary /download/tomoshibi serves, in hex,
	// which the install script checks the download against. Set by whoever
	// serves the binary; nil leaves the package without one, and the script
	// then refuses to install what it cannot check.
	BinarySum func() (string, error)
}

// Configured reports whether a relay can be brought up from a script.
//
// A domain is what makes it possible; the secret no longer does, since what a
// machine presents is a token minted on the management pages.
func (e *Enrolment) Configured() bool {
	return e != nil && e.Domain != ""
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

// publicAddress says whether an address is one a relay's public name may point
// at: an IPv4 address somebody on the internet could reach.
//
// Not loopback, not a private range, not the shared range carriers put behind
// NAT, not link-local, multicast or unspecified. The enrolment used to accept
// any address that parsed, so whoever held the secret could point a name in
// this deployment's zone — one covered by its wildcard certificate — at a
// machine inside somebody's network. IPv4 only, because the record written is
// an A record and the address detection in the script is IPv4.
func publicAddress(raw string) bool {
	address, err := netip.ParseAddr(raw)
	if err != nil {
		return false
	}

	address = address.Unmap()
	if !address.Is4() || !address.IsGlobalUnicast() || address.IsPrivate() {
		return false
	}

	for _, reserved := range nonPublic {
		if reserved.Contains(address) {
			return false
		}
	}

	return true
}

// nonPublic is what IsGlobalUnicast and IsPrivate let through and nobody
// outside can reach.
var nonPublic = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

// enrolPackage is what a relay is handed once it has proved the token.
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

	// BinarySHA256 is what the binary about to be downloaded should hash to.
	//
	// Fetched over the same connection as the binary, so this does not protect
	// against the control node itself; it protects against everything between
	// the two — a proxy that cached an older build, a download cut short and
	// resumed wrongly, a mirror somebody put in front of the control node —
	// each of which used to install whatever arrived and run it as a service.
	BinarySHA256 string `json:"binarySha256,omitempty"`

	Cert string `json:"cert"`
	Key  string `json:"key"`

	ListenPort int `json:"listenPort"`
	UDPPort    int `json:"udpPort"`
	TCPPort    int `json:"tcpPort"`

	// Named says whether the control node created the DNS record. False means
	// the machine is otherwise ready and somebody has to point the name.
	Named bool `json:"named"`
}

// admitted is what a token, or the old secret, allows, and which of the two
// it was.
type admitted struct {
	grant store.EnrolGrant
	// legacy is the long-lived secret, which is never spent and never replaces.
	legacy bool
}

// admit reads what was presented.
//
// A token is looked up without being spent: the request may still be refused
// for a prefix or an address, and a token spent on a typo is a trip back to the
// management pages for somebody standing at a new machine. It is spent once
// everything has been checked and before anything is changed.
func (a *API) admit(presented string, now time.Time) (admitted, bool) {
	if presented == "" {
		return admitted{}, false
	}

	if a.enrolments != nil {
		if grant, ok := a.enrolments.EnrolGrant(presented, now); ok {
			return admitted{grant: grant}, true
		}
	}

	// Constant time: this comparison stands between a stranger and the
	// credential every relay in this deployment signs with.
	if a.enrolment.AcceptSecret && a.enrolment.Secret != "" &&
		subtle.ConstantTimeCompare([]byte(presented), []byte(a.enrolment.Secret)) == 1 {
		return admitted{legacy: true}, true
	}

	return admitted{}, false
}

// claim is what the install script calls.
//
// Authenticated by the token rather than by a session: the machine running
// this has no administrator sitting at it. Rate limited, because an endpoint
// exchanging a string for the deployment's credentials is worth guessing at.
func (a *API) claim(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	caller := limit.Caller(r, a.conf.Meet.Hops())
	attempt, allowed := a.doors.Enrol.Take(caller)
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
		// Replace is what the machine asks for, and it decides nothing now.
		//
		// It used to decide everything: whoever held the secret could move any
		// relay's name to any address by saying so. A takeover is now something
		// the administrator who minted the token chose, and this field is read
		// only so that a script asking for one with a token that does not allow
		// it is told so in those words.
		Replace bool `json:"replace"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	now := time.Now().UTC()
	from := callerIP(caller)

	// Every refusal from here names where the request came from. The audit
	// said "wrong secret" and nothing else, which is a record of somebody
	// trying a door with no way to tell one somebody from a thousand.
	refused := func(status int, reason, said, by string) {
		a.log.Record(Entry{
			Action: "enrol", Trip: orDash(by), Target: body.Prefix,
			Change: "from " + from, Failed: true, Reason: said,
		})
		refuse(w, status, reason)
	}

	held, ok := a.admit(body.Secret, now)
	if !ok {
		// Charged, which it was not once.
		//
		// Asking the limiter costs nothing by design — it is a question, and only
		// a failure spends anything. Both enrolment endpoints asked and neither
		// ever paid, so five thousand wrong secrets from one address were five
		// thousand refusals and no throttling at all.
		attempt.Failed()
		refused(http.StatusForbidden, "wrong_secret", "no such enrolment token", "")
		return
	}

	by := held.grant.By

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	// A token is for one name. Holding one for a machine called tokyo is not
	// permission to bring up, or take over, one called anything else.
	if !held.legacy && held.grant.Prefix != prefix {
		refused(http.StatusForbidden, "wrong_prefix", "the token was minted for "+held.grant.Prefix, by)
		return
	}

	if held.grant.From != "" && held.grant.From != from {
		refused(http.StatusForbidden, "wrong_source",
			"the token was minted for a machine at "+held.grant.From, by)
		return
	}

	// The address the machine names, and otherwise the one this request came
	// from. A machine behind NAT knows its public address and this server sees
	// it; on a machine with several, the one it names is the one it means.
	address := strings.TrimSpace(body.Address)
	if address == "" {
		address = from
	}

	if net.ParseIP(address) == nil || !publicAddress(address) {
		refused(http.StatusBadRequest, "bad_address", "not a public address: "+address, by)
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

	sum := ""
	if a.enrolment.BinarySum != nil {
		if sum, err = a.enrolment.BinarySum(); err != nil {
			slog.Error("failed to hash the binary a relay is about to download", "error", err)
			refuse(w, http.StatusServiceUnavailable, "no_binary")
			return
		}
	}

	// Whether this prefix is taken, checked before anything is changed. The DNS
	// record used to be created first, so a prefix that was then refused had
	// already had the name moved to the new machine — the refusal was honest
	// and the damage was done.
	//
	// And taking it over is the token's to allow. A replacement moves a relay's
	// name to whatever address this request names, so it was the one thing
	// worth stealing the secret for: the name keeps every client that measured
	// it, the certificate already covers it, and the calls dialled to it land on
	// the new machine.
	replace := held.grant.Replace && !held.legacy
	taken, err := a.prefixTaken(relay.Name)
	if err != nil {
		refuse(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}

	if taken && !replace {
		reason := "prefix already in use"
		if body.Replace {
			reason = "prefix already in use, and the token does not allow taking it over"
		}

		refused(http.StatusConflict, "relay_exists", reason, by)
		return
	}

	// Used up here: after every refusal that could still be a typo, and before
	// anything outside this process is touched. Two machines presenting one
	// token at once get one enrolment between them, because the store removes
	// it in the transaction that reads it.
	if !held.legacy {
		if _, err := a.enrolments.SpendEnrolGrant(body.Secret, now); err != nil {
			refused(http.StatusForbidden, "wrong_secret", "the token was used while this request was checked", by)
			return
		}
	} else {
		slog.Warn("a relay enrolled with the long-lived enrolment secret, which is accepted only because "+
			"meet.enrol.accept_secret is set: mint a token on the relays page instead and turn the "+
			"setting off", "prefix", prefix, "from", from)
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

	if err := a.relays.AddRelay(relay); errors.Is(err, store.ErrRelayExists) {
		// Taken between the check above and here, by another enrolment of the
		// same prefix. Only a replacing token may go on.
		if !replace {
			refused(http.StatusConflict, "relay_exists", "prefix already in use", by)
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

	// Where it came from and where its name now points, which are the two
	// facts anybody reading this afterwards needs and the two it used to leave
	// out: an enrolment that moved a relay's name somewhere it should not be
	// was otherwise a line saying only that a prefix had been enrolled.
	change := fmt.Sprintf("from %s, %s now points at %s", from, host, address)
	if taken {
		change += ", replacing the relay that held it"
	}
	if held.legacy {
		change += ", with the long-lived secret"
	}

	a.log.Record(Entry{
		Action: "enrol", Trip: orDash(by), Name: held.grant.ByName,
		Target: relay.Name, Change: change,
	})

	respond(w, enrolPackage{
		Name: relay.Name, Host: host, URL: relay.URL, Region: relay.Region,
		Node: placeOf(relay), Selector: a.selectorFor(relay),
		APIKey: a.conf.Key, APISecret: a.conf.Secret,
		RedisAddr: a.enrolment.RedisAddr, RedisPassword: a.enrolment.RedisPassword,
		BinarySHA256: sum,
		Cert:         string(cert), Key: string(key),
		ListenPort: a.enrolment.ListenPort,
		UDPPort:    a.enrolment.UDPPort,
		TCPPort:    a.enrolment.TCPPort,
		Named:      named,
	})
}

func orDash(trip string) string {
	if trip == "" {
		return "-"
	}
	return trip
}

// callerIP strips the port an address may carry.
func callerIP(caller string) string {
	if host, _, err := net.SplitHostPort(caller); err == nil {
		return host
	}
	return caller
}

// How long a token lives unless the administrator says otherwise, and the
// most it may be given.
//
// Half an hour is long enough to provision a machine, find the root password
// and paste the line; two hours is the most anybody setting up one machine
// needs, and a token is cheap to mint again.
const (
	enrolTokenLife    = 30 * time.Minute
	enrolTokenLongest = 2 * time.Hour
)

// mintEnrolment makes a token for one machine.
//
// Moderate rather than relays. What the token buys is not a relay but the
// deployment — the key pair every token is signed with, the redis password and
// the certificate's private key — and an administrator trusted with the fleet's
// list was, until this, one paste away from all three. Someone given the relays
// alone still adds, edits, orders and removes them, and adds one by address.
func (a *API) mintEnrolment(session Session, w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.enrolments == nil || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	var body struct {
		Prefix  string `json:"prefix"`
		Replace bool   `json:"replace"`
		From    string `json:"from"`
		Minutes int    `json:"minutes"`
	}

	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		refuse(w, http.StatusBadRequest, "unreadable")
		return
	}

	prefix := strings.ToLower(strings.TrimSpace(body.Prefix))
	if !validPrefix(prefix) {
		refuse(w, http.StatusBadRequest, "bad_prefix")
		return
	}

	from := strings.TrimSpace(body.From)
	if from != "" && net.ParseIP(from) == nil {
		refuse(w, http.StatusBadRequest, "bad_address")
		return
	}

	life := enrolTokenLife
	if body.Minutes > 0 {
		life = min(time.Duration(body.Minutes)*time.Minute, enrolTokenLongest)
	}

	// Said now rather than when the machine arrives. A token that cannot work
	// is worse than none: somebody carries it to a new machine, pastes it, and
	// is sent back to this page.
	taken, err := a.prefixTaken(prefix)
	if err != nil {
		refuse(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}

	if taken && !body.Replace {
		refuse(w, http.StatusConflict, "relay_exists")
		return
	}

	token, err := store.NewEnrolToken()
	if err != nil {
		refuse(w, http.StatusInternalServerError, "token_failed")
		return
	}

	now := time.Now().UTC()

	grant, err := a.enrolments.KeepEnrolGrant(token, store.EnrolGrant{
		Prefix: prefix, Replace: body.Replace && taken, From: from,
		Made: now, Expires: now.Add(life),
		By: session.Trip, ByName: session.Name,
	})
	if err != nil {
		refuse(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}

	change := "for " + life.String()
	if grant.Replace {
		change += ", taking over the relay of that name"
	}
	if from != "" {
		change += ", from " + from + " only"
	}

	a.log.Record(Entry{
		Action: "mint enrolment", Trip: session.Trip, Name: session.Name,
		Target: prefix, Change: change,
	})

	respond(w, map[string]any{
		"token":   token,
		"grant":   grant,
		"command": a.commandFor(prefix),
		"domain":  a.enrolment.Domain,
		"port":    a.enrolment.ListenPort,
	})
}

// enrolmentsWaiting lists the tokens minted and not yet used.
func (a *API) enrolmentsWaiting(_ Session, w http.ResponseWriter, _ *http.Request) {
	if a.enrolments == nil {
		respond(w, map[string]any{"waiting": []store.EnrolGrant{}})
		return
	}

	list, err := a.enrolments.EnrolGrants(time.Now().UTC())
	if err != nil {
		refuse(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}

	if list == nil {
		list = []store.EnrolGrant{}
	}

	respond(w, map[string]any{"waiting": list})
}

// withdrawEnrolment takes one back before it is used.
func (a *API) withdrawEnrolment(session Session, w http.ResponseWriter, r *http.Request) {
	if a.enrolments == nil {
		refuse(w, http.StatusNotFound, "no_such_enrolment")
		return
	}

	id := r.PathValue("id")

	found, err := a.enrolments.WithdrawEnrolGrant(id)
	if err != nil {
		refuse(w, http.StatusServiceUnavailable, "store_unavailable")
		return
	}

	if !found {
		refuse(w, http.StatusNotFound, "no_such_enrolment")
		return
	}

	a.log.Record(Entry{Action: "withdraw enrolment", Trip: session.Trip, Name: session.Name, Target: id})

	respond(w, map[string]any{"withdrawn": id})
}

// installScript is the script a new machine runs, for reading first.
//
// The same as the public one. It carried the enrolment secret once, which is
// why it sat behind a session; nothing in it is a secret now, and it stays
// here because the page that offers the command is the page that offers to
// show what the command runs.
func (a *API) installScript(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	w.Header().Set("Content-Disposition", `attachment; filename="add-relay.sh"`)

	a.writeInstall(w)
}

// installCommand is the one line somebody types on the new machine.
//
// The script is still there to be read — anything about to run as root should
// be readable first, and it is what the download beside this serves. What this
// gives is the shape that gets used: one command, copied, pasted, done.
//
// It carries no secret any more. The token is asked for by the script once it
// is running, and read from the terminal rather than from the command line, so
// that it lands in neither the shell's history nor the process list.
func (a *API) installCommand(_ Session, w http.ResponseWriter, _ *http.Request) {
	if !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	respond(w, map[string]any{
		"command": a.commandFor("<prefix>"),
		"domain":  a.enrolment.Domain,
		"port":    a.enrolment.ListenPort,
	})
}

func (a *API) commandFor(prefix string) string {
	control := strings.TrimRight(a.enrolment.PublicURL, "/")

	return fmt.Sprintf("bash <(curl -fLSs %s/install) %s", control, prefix)
}

// PublicInstall serves the same script to anybody.
//
// So that bringing a relay up is one command copied onto a fresh machine rather
// than a file moved onto it by hand. Nothing in it is a secret: what authorises
// the enrolment is a token the script asks for once it is running.
//
// Public on purpose. What is served is a shell script with this deployment's
// address and ports in it, which is not a secret: the addresses are handed to
// every client that joins, and without a token the script can do nothing but
// ask and be refused. The relay domain was in it too, which with /api/relays
// was the whole fleet listed by name to anybody; it is not any more.
func (a *API) PublicInstall(w http.ResponseWriter, _ *http.Request) {
	if a.enrolment == nil || !a.enrolment.Configured() {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	a.writeInstall(w)
}

func (a *API) writeInstall(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")

	fmt.Fprintf(w, installTemplate,
		strings.TrimRight(a.enrolment.PublicURL, "/"),
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
// type one, and whether the token it holds may take it over.
//
// Behind the token, because the list of relay names is not something to hand to
// whoever asks. The token is read and not spent: asking is not enrolling.
func (a *API) taken(w http.ResponseWriter, r *http.Request) {
	if !a.enrolment.Configured() || a.relays == nil {
		refuse(w, http.StatusServiceUnavailable, "no_enrolment")
		return
	}

	attempt, allowed := a.doors.Enrol.Take(limit.Caller(r, a.conf.Meet.Hops()))
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

	held, ok := a.admit(body.Secret, time.Now().UTC())
	if !ok {
		// Charged here too. This endpoint only says whether a name is taken, but
		// it takes the same token, so an unlimited door beside a limited one is
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

	if !held.legacy && held.grant.Prefix != prefix {
		refuse(w, http.StatusForbidden, "wrong_prefix")
		return
	}

	used, err := a.prefixTaken(prefix)
	if err != nil {
		refuse(w, http.StatusInternalServerError, "store_unavailable")
		return
	}

	respond(w, map[string]any{
		"prefix": prefix, "taken": used,
		"replace": used && held.grant.Replace && !held.legacy,
	})
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
