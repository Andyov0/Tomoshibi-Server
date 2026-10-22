// Package config loads one document describing the whole process: this
// server's own settings alongside the media server's.
//
// They cannot be unmarshalled together. LiveKit's loader can be asked to reject
// keys it does not recognise, and a shared document would make that check
// useless, so the `meet` section is lifted out first and what remains is handed
// over untouched. One file, one deletion, and no fighting the upstream type.
package config

import (
	"bytes"
	"crypto/subtle"
	"crypto/tls"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"tomoshibi/internal/room"
	"tomoshibi/internal/testflight"

	livekit "github.com/livekit/livekit-server/pkg/config"
	"gopkg.in/yaml.v3"
)

// Role is which half of a split deployment this process is.
//
// One binary, three ways to run it. Undivided is what upstream does and stays
// the default: a single process holding the client, the join endpoint, and the
// media. The other two exist because media and web have opposite requirements —
// media wants to sit close to the people sending it and is charged by the byte,
// while the client wants a name, a certificate, and somewhere cheap to serve a
// few kilobytes from. Splitting them lets each go where it belongs.
type Role string

const (
	// RoleFull serves everything from one process. The default, and what a
	// deployment that has not thought about this wants.
	RoleFull Role = "full"

	// RoleRelay carries media and nothing else: the embedded media server and
	// the signalling paths in front of it. No client, no join endpoint, no
	// store, no management pages. Several of these sit behind one control.
	RoleRelay Role = "relay"

	// RoleControl serves the client, the join endpoint, and the management
	// pages, and starts no media server of its own. It signs the tokens the
	// relays verify and tells each client which relay to dial.
	RoleControl Role = "control"
)

// Valid reports whether a role is one this binary knows how to be.
func (r Role) Valid() bool {
	switch r {
	case RoleFull, RoleRelay, RoleControl:
		return true
	}
	return false
}

// Relay is one media server a control node can hand clients to.
type Relay struct {
	// URL is what a client dials, as a WebSocket origin: `wss://sh.example.com`.
	// Handed to the client verbatim, so it must be reachable from a browser
	// rather than from the control node.
	URL string `yaml:"url"`

	// Name identifies this relay in logs and on the management pages.
	Name string `yaml:"name"`

	// Region is a label this deployment gives a place. Compared against a
	// client's own, never interpreted, so whatever vocabulary a deployment
	// already uses works: `cn-east`, `hk`, `eu`.
	Region string `yaml:"region"`
}

// How a control node picks which relay a client is told to dial.
const (
	// PickSticky sends everybody in a room to the same relay, chosen by the
	// room's name.
	//
	// The default, and the one that costs least. Media between two people on
	// one relay never leaves it; between two relays it is carried twice, once
	// to cross and once to deliver. On metered egress that difference is the
	// whole bill, so participants are gathered unless something asks otherwise.
	PickSticky = "sticky"

	// PickNearest sends each client to the relay whose region matches their
	// own, falling back to sticky when nothing matches.
	//
	// Trades the saving above for latency: a meeting spread over three regions
	// becomes three relays forwarding to each other. Worth it when the people
	// are genuinely far apart, and only then.
	PickNearest = "nearest"

	// PickRoundRobin spreads clients over the relays in turn, ignoring both
	// room and region. For levelling load across identical machines.
	PickRoundRobin = "round_robin"

	// PickProbe lets the client measure the relays and say which answered
	// fastest, falling back to sticky when it does not say.
	//
	// The only policy that knows what a network is actually doing. A region
	// label is somebody's belief about where the packets go, written once and
	// wrong the day a route changes; a measurement is the route as it is this
	// minute, taken from the one place that can see it — the browser making the
	// call. It costs one small request per relay before joining, in parallel,
	// which is nothing beside a call that is about to run for an hour.
	//
	// What a client sends is a name from the list it was given, never an
	// address: a policy that took a URL from the request would let anybody be
	// told to send their meeting anywhere.
	PickProbe = "probe"
)

// Meet is everything the media server has no opinion about.
type Meet struct {
	// Role is which half of a split deployment this is. Empty means full.
	Role Role `yaml:"role"`

	// Relays are the media servers a control node hands clients to. Only read
	// under RoleControl; a full deployment is its own relay and a relay is
	// never asked to choose one.
	Relays []Relay `yaml:"relays"`

	// RelayPolicy is how a control node chooses between them.
	RelayPolicy string `yaml:"relay_policy"`

	// LinkMbits is what a relay's network link is thought to carry, in megabits
	// per second.
	//
	// Not measured and not measurable from here: this server knows what it is
	// sending, not what the wire beneath it can hold. It is a figure somebody
	// types because they know what they are paying for.
	//
	// Three things on the management pages read it, and all three were wrong on
	// any deployment that is not a gigabit, because it was written into the
	// client as a constant. The "busy" mark on a relay never appeared on a
	// slower link and never went out on a faster one, the bandwidth bar was a
	// fraction of the wrong number, and the six-month plot's fixed axis -- which
	// is fixed on purpose, so that "how near the ceiling an evening came" is
	// visible rather than normalised away by rescaling -- had a ceiling that was
	// not the ceiling.
	//
	// Zero keeps the gigabit that was assumed, so nothing changes for a
	// deployment that has not thought about it.
	LinkMbits int `yaml:"link_mbits"`

	// Enrol lets a new relay bring itself up from a script.
	Enrol Enrol `yaml:"enrol"`

	// Listen is the address serving the client, the API, and the signalling
	// proxy. The one port anybody outside this machine talks to over TCP.
	Listen string `yaml:"listen"`

	// WebRoot serves the client from a directory instead of the copy built into
	// the binary. Useful while working on the client; unset in a deployment.
	WebRoot string `yaml:"web_root"`

	// Database is the key-value file recording which rooms have been used.
	Database string `yaml:"database"`

	// TripcodeKey signs the passphrases that turn a display name into one
	// nobody else can wear. Created on first use.
	//
	// Its own file rather than the API credentials, because the two have
	// opposite lifetimes: those should be rotated, and rotating this one
	// silently changes everybody's signature, which is the one thing a
	// signature must never do.
	TripcodeKey string `yaml:"tripcode_key"`

	// PublicURL overrides the address clients are told to dial. Only needed
	// behind a proxy or a name the request does not already carry.
	PublicURL string `yaml:"public_url"`

	// PublicAddresses are addresses this machine answers on that its interfaces
	// do not carry.
	//
	// Only a control node reads these, and only to recognise its own relay. It
	// reaches a relay by the name that relay publishes; where that relay is this
	// same machine, the name resolves to a public address which NAT maps rather
	// than assigns — so reading the interfaces finds the private address and
	// misses the one being dialled. The connection then goes out to the network
	// and, on most hosts, never comes back: not refused, just waiting.
	//
	// Measured on the deployment that prompted this: twelve seconds per
	// management call, and a 502 on the busiest page because the proxy in front
	// gave up first. Declaring the address here makes it eleven milliseconds.
	PublicAddresses []string `yaml:"public_addresses"`

	// Silent answers nothing but a WebSocket upgrade.
	//
	// For a relay on a network that decides what a machine is by asking it.
	// Mainland Chinese hosts are probed with an ordinary HTTPS request, and any
	// answer — 204, 401, even 404 — identifies the port as a website, which an
	// unregistered domain is not allowed to be. A WebSocket endpoint owes no
	// answer to a request that is not an upgrade, so under this it gives none:
	// the connection is closed without a status line.
	//
	// The cost is the health endpoint, which a control node's page and a
	// client's own measurement both use. A relay elsewhere should leave this
	// off and stay readable.
	Silent bool `yaml:"silent"`

	// ProbePort answers STUN binding requests, so a browser can time one round
	// trip over the transport a call uses.
	//
	// The picker's other measurement opens the signalling socket, which is TCP:
	// a handshake, a TLS handshake and an HTTP upgrade, so about three round
	// trips. It ranks relays correctly and reads as three times too slow, and a
	// number nobody believes is a number nobody uses.
	//
	// Zero is off. Deliberately not 3478: the standard STUN port is scanned
	// continuously and answering on it is an invitation, so every deployment
	// should pick something unremarkable.
	ProbePort int `yaml:"probe_port"`

	// TLSCert and TLSKey serve this listener over TLS directly, without a proxy
	// in front.
	//
	// Present because a relay usually has no proxy to put there and often
	// cannot get one. Browsers refuse a plaintext WebSocket from a page loaded
	// over HTTPS, so a relay dialled from a real deployment has to be wss —
	// and the machines that make the best relays are frequently the ones where
	// installing anything is hardest: a package mirror that will not answer, a
	// port 80 the network never delivers, a host that cannot be issued a
	// certificate locally at all.
	//
	// A certificate copied in from elsewhere, served by the one binary that was
	// already going to be copied in, removes all of that. A deployment that does
	// have a proxy leaves both empty and nothing changes.
	TLSCert string `yaml:"tls_cert"`
	TLSKey  string `yaml:"tls_key"`

	// TokenTTL is how long a join token stays valid. Short by design: it is
	// spent on the next connect and never reused.
	TokenTTL time.Duration `yaml:"token_ttl"`

	// JoinRate and JoinBurst bound how fast rooms can be asked for. A room
	// exists because somebody named it, so asking for an unused one succeeds
	// exactly like asking for a busy one. There is no failure to count, which
	// leaves the rate as the only thing between a script and somebody's meeting.
	JoinRate  float64 `yaml:"join_rate"`
	JoinBurst int     `yaml:"join_burst"`

	// TrustProxy believes `X-Forwarded-For` and `X-Forwarded-Host`. Only true
	// behind a proxy that sets them; exposed directly they are whatever the
	// caller typed, and believing them would let anyone claim a fresh rate-limit
	// budget per request.
	TrustProxy bool `yaml:"trust_proxy"`

	// Proxies is how many proxies stand in front of this server, each of them
	// appending the address it saw to X-Forwarded-For. Read only with
	// trust_proxy, and zero means one.
	//
	// The caller is found by counting that many entries in from the right,
	// because everything to the left of what the proxies wrote is the caller's
	// own writing. It has to be said rather than guessed: behind a CDN and then
	// nginx the last entry is the CDN's node, and reading it charges everybody
	// arriving through that node as one caller.
	Proxies int `yaml:"proxies"`

	// Admins may open the management pages. Empty, which is the default, means
	// there are none and those pages do not exist.
	Admins []Admin `yaml:"admins"`

	// Rooms is what may be done with a name nobody has used.
	Rooms Rooms `yaml:"rooms"`

	// SourceURL is where the code running here can be read.
	//
	// Shown to everybody who opens the client, because this is licensed under
	// the AGPL and its thirteenth section obliges whoever offers a program over
	// a network to offer its source to the people using it that way. Set it to
	// wherever a changed copy lives: a link to somebody else's repository is
	// not an offer of the source anybody is actually running.
	SourceURL string `yaml:"source_url"`

	// Music is a library somebody signed in may play into a call. See Music.
	Music Music `yaml:"music"`

	// Watch is a gateway for watching a video together. See Watch.
	Watch Watch `yaml:"watch"`

	// Apps is where the native apps are offered to signed-in accounts and to
	// people holding a link into a meeting. See Apps.
	Apps Apps `yaml:"apps"`
}

// Apps is what the download page offers somebody signed in, and what the page
// an invitation opens offers its holder: the Mac and Android apps from a
// directory on this machine, and the iOS app by TestFlight — an invitation by
// address for an account, the beta's public link for somebody without one. It
// is also the statements that let the apps open this deployment's links.
//
// Every key is optional, and a key left out is a section of the page that says
// the app is not available yet rather than one that offers something broken.
// That is deliberate even where only some of a section is set: the page is a
// courtesy beside a meeting server, and refusing to start a meeting server over
// a half-written TestFlight section would turn one missing invitation form into
// every call on the deployment. What cannot mean anything at all — a key file
// that is not a key, an Android app named without its fingerprint or by a name
// no app can have — is refused at startup, because that is a mistake in a file
// somebody is about to deploy and the sentence is most useful then.
//
// Read only where pages are served. A relay serves none and ignores all of it.
type Apps struct {
	// MacDir holds the builds handed over as files — the Mac app's disk
	// images, the Android app's packages and the Windows app's installers —
	// and the apps.json manifest that names them, a list for each platform. The manifest is read on every
	// request, so a new version is a file copied in and a manifest rewritten,
	// without a restart; see internal/app/apps.go for its shape.
	//
	// Still called mac_dir, after the first platform it held. Renaming the key
	// would leave every deployment's file naming one this server no longer
	// reads, and the download page saying none of the apps is available yet
	// for no reason anybody could see.
	MacDir string `yaml:"mac_dir"`

	// AndroidPackage and AndroidCertificates are the Android app this
	// deployment vouches for, at /.well-known/assetlinks.json, so that its
	// links, an invitation above all, open in that app rather than in the
	// browser; see internal/app/assetlinks.go.
	//
	// The package is the app's application id. Each certificate is the SHA-256
	// fingerprint of a key the app is signed with, as `keytool -list -v`
	// prints it, and there is more than one where the app is signed more than
	// one way: a key of the developer's own and the key Google Play re-signs
	// with, say. The two are set together or not at all, and with neither the
	// address answers 404, because a deployment without an Android app must not
	// claim one.
	AndroidPackage      string   `yaml:"android_package"`
	AndroidCertificates []string `yaml:"android_certificates"`

	// AppleAppIDs are the iOS and Mac apps this deployment vouches for, at
	// /.well-known/apple-app-site-association, so that its invitation and
	// meeting links open in the app rather than in Safari; see
	// internal/app/universal.go.
	//
	// Each is the app identifier Apple's statement names an app by: the
	// developer's team id, ten capital letters and digits, a dot, and the app's
	// bundle id, as SM86NB3CPZ.app.example.ios. One entry for each app, since the
	// iOS app and the Mac app are two bundles. With none the address answers 404,
	// for the reason the Android statement's does: a deployment without an Apple
	// app must not claim one.
	AppleAppIDs []string `yaml:"apple_app_ids"`

	// TestFlight is the App Store Connect API key that invites testers, and the
	// beta's public link.
	TestFlight TestFlight `yaml:"testflight"`
}

// AppleLinked reports whether an Apple app is claimed at all, which is when the
// statement Apple's devices verify is served.
func (a Apps) AppleLinked() bool {
	return len(a.AppleAppIDs) > 0
}

// AndroidLinked reports whether an Android app is claimed at all, which is
// when the statement Android verifies is served.
func (a Apps) AndroidLinked() bool {
	return a.AndroidPackage != "" && len(a.AndroidCertificates) > 0
}

// TestFlight is an App Store Connect API key and the beta group it invites
// into.
//
// The key is made under Users and Access in App Store Connect, with a role that
// may manage testers, and its .p8 file is downloaded once; KeyID and Issuer are
// shown beside it there. Group is the id of an external beta group of the app,
// which is in the group's address in App Store Connect.
//
// PublicLink is apart from the key and needs none of it. It is the link App
// Store Connect gives a beta group whose public link is turned on,
// https://testflight.apple.com/join/ and a code, which lets whoever opens it
// on an iPhone or iPad join the beta without being invited by address. It is
// offered only to somebody holding an invitation or a meeting link who is not
// signed in: an account is invited by its address, so that the people testing
// the app are people this deployment can name, and somebody with no account
// has no address here to invite. The ceiling on how many may join through it is
// set beside it in App Store Connect, and is the thing to lower if it travels
// further than meant. Without it, nobody without an account is offered the iOS
// app.
type TestFlight struct {
	KeyID      string `yaml:"key_id"`
	Issuer     string `yaml:"issuer"`
	KeyFile    string `yaml:"key_file"`
	Group      string `yaml:"group"`
	PublicLink string `yaml:"public_link"`
}

// Configured reports whether every part of the key is there, which is when
// invitations are offered at all. The public link is not part of the key and
// is not asked about here.
func (t TestFlight) Configured() bool {
	return t.KeyID != "" && t.Issuer != "" && t.KeyFile != "" && t.Group != ""
}

// Music is a gateway to a music library, run by this deployment somewhere else.
//
// The server passes signed-in people's searches and plays on to it with a token
// only the server holds, and the client plays what comes back into the call as
// shared sound -- see internal/app/music.go. What the gateway reaches is the
// deployment's business; the client is shown four paths and no address. Unset,
// there is no library on this deployment and the client offers none.
type Music struct {
	// URL is where the gateway answers, reachable from this server only. The
	// gateway's paths are appended to it.
	URL string `yaml:"url"`

	// Token is sent with every request so the gateway can tell this server from
	// anything else that reaches its address.
	Token string `yaml:"token"`
}

// MinMusicToken is the shortest token accepted: a guessable one would let
// anything on the gateway's network play from somebody's subscription.
const MinMusicToken = 24

// Watch is a gateway that reads a video link -- what it plays, and how long it
// is -- and relays its media for viewers who cannot fetch it themselves.
//
// Somebody signed in pastes a link and everybody in the call watches it
// together, each playing it in their own browser; see internal/app/watch.go.
// Shaped as Music is, for the same reasons. Unset, there is no watching
// together on this deployment and the client offers none.
type Watch struct {
	URL   string `yaml:"url"`
	Token string `yaml:"token"`

	// DirectOnly has every viewer play a video from where it is, and nobody
	// through this server. The gateway still reads links -- a title and a
	// length are a few hundred bytes -- but nothing it would relay passes
	// through here: no video, no playlist, no media server's library. A
	// viewer whose own connection cannot reach a video does not see it, and
	// is told so; a source that plays only through the relay is refused when
	// it is pasted.
	//
	// For a deployment that pays for what leaves it. A relayed film is every
	// byte of it, for every viewer who needed the relay, through whatever is
	// in front of this server.
	//
	// With three exceptions, each decided in the store rather than here by a
	// switch on the management pages: a media server's film chosen by
	// somebody given the Emby permission, while watch.emby_relay is on;
	// YouTube, for every viewer who cannot reach it, while
	// watch.youtube_relay is on; and Bilibili's bangumi, for everybody, while
	// watch.bangumi_relay is on. The first two start off. The third starts on,
	// the owner's choice, and relays nothing unless the gateway was started
	// with RELAY_BANGUMI to read bangumi for the relay; with all three off,
	// or the last never read, this means exactly what it says. See
	// internal/app/watchledger.go.
	DirectOnly bool `yaml:"direct_only"`
}

// Enrol is what a machine running the install script is told.
//
// Off unless a secret is set. What an enrolment hands over is the credential
// every relay signs with, the redis password and a private key, so a deployment
// that has not said it wants this does not get an endpoint that gives them away.
type Enrol struct {
	// Secret is what the install script proves it has. Long-lived, because the
	// script is meant to be kept and pasted into whatever machine comes next —
	// which makes the script itself a credential.
	Secret string `yaml:"secret"`

	// Domain is what a prefix is added to: `tokyo` under `relay.example.com`
	// becomes `tokyo.relay.example.com`.
	//
	// ⚠ It must not be a name that already carries a CNAME. A CNAME shadows
	// every name beneath it, so records created under one are never answered —
	// the zone shows them and the world does not.
	Domain string `yaml:"domain"`

	// PublicURL is where a new machine fetches the binary and claims its
	// configuration: this deployment as the outside reaches it.
	PublicURL string `yaml:"public_url"`

	// Ports every relay in this deployment listens on. Sent to each new machine
	// so they agree without anybody having to remember.
	ListenPort int `yaml:"listen_port"`
	UDPPort    int `yaml:"udp_port"`
	TCPPort    int `yaml:"tcp_port"`

	// ProbePort is written into every new relay's configuration, and is the
	// reason the picker can show a number anybody believes.
	//
	// It was not, and the effect was quiet: the enrolment wrote no probe port,
	// zero is off, so every machine brought up by the script answered no STUN
	// and was timed over the signalling socket instead — three round trips
	// against one. A relay given a probe port by hand afterwards then won the
	// ranking against nearer machines on nothing but the measurement it had
	// been allowed. That comparison is fixed in the client, which now measures
	// the whole list one way; this is what makes the fast way available at all.
	//
	// Zero is off, and the same reasoning as the field it becomes applies: not
	// 3478, which is scanned continuously.
	ProbePort int `yaml:"probe_port"`

	// CertFile and KeyFile are the certificate handed to a new relay. Empty
	// takes the listener's own, which is what a control node serving TLS
	// directly already holds.
	CertFile string `yaml:"cert_file"`
	KeyFile  string `yaml:"key_file"`

	// RedisAddr is how a *relay* reaches redis, which is not how this node
	// does.
	//
	// A control node running redis beside it says 127.0.0.1, and sending that
	// to another machine points it at its own loopback — where there is nothing,
	// so the relay fails to start with an error about redis that names an
	// address it was never meant to try. Empty falls back to this node's own,
	// which is right only when redis is somewhere else entirely.
	RedisAddr string `yaml:"redis_addr"`

	// Binary is the file served to a new relay. The control node hands out the
	// build it is running, so a fleet cannot drift apart by version.
	Binary string `yaml:"binary"`

	// Cloudflare creates each relay's DNS record. Optional: without it a relay
	// still enrols and whoever ran the script points the name themselves.
	CloudflareToken string `yaml:"cloudflare_token"`
	CloudflareZone  string `yaml:"cloudflare_zone"`
}

// Rooms is the policy for names nobody has used.
type Rooms struct {
	// OpenedBy is who may use one for the first time.
	//
	// The starting value alone. It is written into the store the first time the
	// server runs, and from then on the management pages are what change it —
	// so editing this afterwards changes nothing, and the runtime panel shows
	// the two side by side for whoever is reading the file and wondering why.
	OpenedBy room.Opening `yaml:"opened_by"`

	// JoinedBy is who may enter a room that already exists.
	//
	// A separate question from who may create one, and the one that was never
	// asked: knowing a name let anybody in, so a deployment whose rooms are
	// called things like 223223 had a door that could be guessed.
	//
	// `invited` asks for an invite, an account, an administrator's passphrase,
	// or being the host, and is the default. `accounts` asks for an account and
	// nothing else. There is no setting for the old behaviour: the invite
	// mechanism exists so that somebody can be let into one call without being
	// handed a name, and an option to turn it off is an option to undo the
	// reason it is there.
	JoinedBy room.Joining `yaml:"joined_by"`

	// Remember is how long a name stays used after the last time it was joined.
	//
	// Two things at once, and they agree. A name is written down on first use
	// and nothing ever took one away, so the store grew for as long as anybody
	// asked it for names — bounded by the rate limiter in how fast and by
	// nothing at all in how many. And a name nobody has spoken in days is not a
	// room in use; treating it as one leaves a room open for good because
	// somebody said its name once, last year.
	//
	// Three days, down from thirty. A meeting that happens again happens within
	// the week, and everything else here is a name somebody typed once. The
	// month was chosen when the record held a name and a count; it now also
	// holds where an operator said the room goes, and that is the reason the
	// number came down — a placement is deliberately not aged out on its own, so
	// the record's own life is the only thing bounding it, and a month of it was
	// a choice made about a meeting nobody remembers outliving the meeting by
	// four weeks.
	//
	// Under `admins` this is therefore how long a room stays open unattended.
	// Zero keeps every name for ever, which is what this did before the setting
	// existed and is still available to anybody who wants it — and now also
	// means a placement with nothing at all bounding it.
	Remember time.Duration `yaml:"remember"`
}

// What an administrator is allowed to do.
//
// Observe and Moderate were the whole of it, because the two halves differ by
// more than degree. Watching costs nothing and answers the question anybody
// debugging a call actually has; removing somebody from a room changes what
// another person is experiencing, at once and without warning. Bound together,
// the choice becomes give everybody the dangerous half or give nobody the
// useful one.
//
// The acting half has since been cut along the lines of what it acts on —
// meetings, accounts, relays, deployment-wide switches — because "somebody who
// looks after the accounts" and "somebody who runs the fleet" are different
// people, and the only way to give either of them their job was to give both of
// them everything. Moderate stays, and holds all four: every administrator
// written down before the split keeps exactly what they had, without anybody
// rewriting a file or a store. What Moderate holds that none of the four do is
// the roster itself — appointing administrators — and the Emby grant, which
// spends the deployment's bandwidth on somebody's behalf.
const (
	// Observe reads: what is happening now, which rooms exist, who is in them
	// and what they are sending, whether the server is healthy.
	Observe = "observe"

	// ManageRooms acts on meetings: close one, remove or mute somebody, move a
	// call to another machine, forget a name. It is also what lets an
	// administrator host any room from the meeting pages, since those are the
	// same acts reached from a different door.
	ManageRooms = "rooms"

	// ManageAccounts makes, changes and removes the ways in that are not
	// administrators — except the Emby grant, which is Moderate's.
	ManageAccounts = "accounts"

	// ManageRelays adds, edits, orders and removes the machines meetings are
	// held on, and hands out the install line, which carries the enrolment
	// secret.
	ManageRelays = "relays"

	// ManageSettings changes the deployment-wide switches: who may open and
	// enter rooms, and whether the Emby relay is on at all.
	ManageSettings = "settings"

	// Moderate is all of the above, and the roster.
	Moderate = "moderate"
)

// capabilities is every one of them, in the order a page lists them.
//
// One list rather than a comparison repeated wherever a capability is read,
// because there were four such comparisons — the startup check, the store, the
// page handler and the two places that spell capabilities back out — and a
// capability added to three of them is one that the fourth silently drops.
var capabilities = []string{Observe, ManageRooms, ManageAccounts, ManageRelays, ManageSettings, Moderate}

// Capabilities lists every capability an administrator can be given.
//
// A copy, so that no caller can grow the list for everybody else.
func Capabilities() []string {
	return append([]string(nil), capabilities...)
}

// Known reports whether a word is a capability this build understands.
func Known(capability string) bool {
	for _, one := range capabilities {
		if one == capability {
			return true
		}
	}

	return false
}

// moderating reports whether Moderate carries a capability with it.
func moderating(capability string) bool {
	switch capability {
	case ManageRooms, ManageAccounts, ManageRelays, ManageSettings:
		return true
	}

	return false
}

// Admin is somebody who may open the management pages.
//
// Identified by the signature their passphrase produces rather than by the
// passphrase itself. A passphrase in a configuration file is a credential lying
// in plain sight — on disk, in every backup, and in whatever holds the
// deployment's history. A signature is public: it is printed beside its owner's
// name in every room they join, and knowing it grants nothing.
type Admin struct {
	// Trip is the signature, without the kind prefix the identity carries.
	Trip string `yaml:"trip"`

	// Name appears in the audit log. Not used for anything else, because
	// nothing here is authorised by a name.
	Name string `yaml:"name"`

	// Can lists what this administrator may do. Empty means Observe alone,
	// which is the safe reading of an entry somebody wrote in a hurry.
	Can []string `yaml:"can"`
}

// Allows reports whether this administrator holds a capability.
//
// Observe is held by everybody listed, and Moderate holds the four finer ones.
// The second is what keeps an entry written as ["moderate"] — which is every
// entry that could act before the finer ones existed — meaning what it meant:
// without it, binding a route to ManageRooms would have quietly taken the rooms
// away from every moderator on the deployment.
func (a Admin) Allows(capability string) bool {
	if capability == Observe {
		return true
	}

	for _, held := range a.Can {
		if held == capability {
			return true
		}

		if held == Moderate && moderating(capability) {
			return true
		}
	}

	return false
}

// Config is both halves, resolved.
type Config struct {
	Meet    Meet
	LiveKit *livekit.Config

	// Key and Secret are the API credentials the embedded media server verifies
	// with, and therefore the ones this server signs with. Read back out of the
	// resolved LiveKit config rather than configured separately, so there is no
	// second place for them to drift.
	Key    string
	Secret string
}

// Defaults every field falls back to.
//
// Hops is how many X-Forwarded-For entries, counted from the right, were
// written by proxies this deployment trusts: none without trust_proxy, and one
// when trust_proxy is set and proxies is not.
func (m Meet) Hops() int {
	if !m.TrustProxy {
		return 0
	}

	return max(1, m.Proxies)
}

// Chosen so that running the binary with no configuration at all produces a
// working server. The burst covers a large meeting arriving at once; the rate is
// what a script is left with afterwards.
var defaults = Meet{
	Role:        RoleFull,
	RelayPolicy: PickSticky,
	Listen:      ":8080",
	Database:    "meet.db",
	TripcodeKey: "tripcode.key",
	TokenTTL:    5 * time.Minute,
	JoinRate:    10,
	JoinBurst:   120,
	TrustProxy:  false,
	// Three days, the owner's choice: keep a room for three days. Rooms.Remember
	// has the argument for it.
	Rooms: Rooms{OpenedBy: room.ByAnyone, JoinedBy: room.ByInvitation, Remember: 3 * 24 * time.Hour},
	Enrol: Enrol{ListenPort: 13377, UDPPort: 13378, TCPPort: 13379},
	// Empty rather than a repository somebody else runs.
	//
	// Section 13 is the reason this field exists: whoever offers this over a
	// network owes its source to the people using it that way, and the join page
	// carries a link to satisfy that. A default pointing at the upstream project
	// makes that link an offer of code the deployment is not running, which is
	// worse than no link -- it looks like compliance and is not, and nobody
	// reading their own page would notice, because the link works.
	//
	// Empty, the startup check says so and the page says the source has not been
	// named. A deployment that has not been told where its code is cannot be
	// made to answer that question correctly by guessing.
	SourceURL: "",
}

// Load reads the configuration from path, or returns the defaults if path is
// empty.
func Load(path string) (*Config, error) {
	document := []byte{}

	if path != "" {
		read, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", path, err)
		}
		document = read
	}

	meet, rest, err := split(document)
	if err != nil {
		return nil, err
	}

	// Strict: a typo in a LiveKit key should be an error rather than a setting
	// that silently did nothing. Ours is checked the same way, in split.
	lk, err := livekit.NewConfig(string(rest), true, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("load the media server configuration: %w", err)
	}

	key, secret, err := credentials(lk)
	if err != nil {
		return nil, err
	}

	if err := checkAdmins(meet.Admins); err != nil {
		return nil, err
	}

	if meet.Rooms.Remember < 0 {
		return nil, fmt.Errorf(
			"rooms.remember: %s is not a length of time to keep a name for. Use zero to keep them for ever",
			meet.Rooms.Remember)
	}

	if meet.Rooms.JoinedBy == "" {
		meet.Rooms.JoinedBy = room.ByInvitation
	}

	// Understood, not offered, and said every time. A deployment may treat its
	// room names as secrets and hand them out like passwords, and this is how
	// that is written down — but it is not a thing anybody should arrive at by
	// pressing the top option on a page, so the management pages do not have it
	// and the log says so on every start.
	if meet.Rooms.JoinedBy == room.ByWhoeverKnows {
		slog.Warn("rooms.joined_by is \"anyone\", so anybody who has a room's name is in the " +
			"meeting — and a room here is a name, so anybody who guesses one is too. The " +
			"management pages do not offer this; it is set in the configuration file")
	}

	if !meet.Rooms.JoinedBy.Valid() {
		return nil, fmt.Errorf(
			"rooms.joined_by: %q is not who may join a room. The three are %q, %q and %q",
			meet.Rooms.JoinedBy, room.ByInvitation, room.ByAccount, room.ByWhoeverKnows)
	}

	// Understood, not offered, and said every time. Both mean anybody may start
	// a meeting on this deployment's machines — "signed" included, since the
	// signature it asks for is made by typing anything at all.
	if meet.Rooms.OpenedBy == room.ByAnyone || meet.Rooms.OpenedBy == room.BySigned {
		slog.Warn("rooms.opened_by lets anybody start a meeting on this deployment: "+
			"\"signed\" asks for a passphrase and a passphrase is whatever somebody types. "+
			"The management pages do not offer either; both are set in the configuration file",
			"setting", meet.Rooms.OpenedBy)
	}

	if !meet.Rooms.OpenedBy.Valid() {
		return nil, fmt.Errorf(
			// All three, because there are three. This listed two and left out
			// the middle one, so somebody who mistyped "signed" was told by the
			// error message that the setting they wanted does not exist.
			"rooms.opened_by: %q is not who a room can be opened by. The three are %q, %q and %q",
			meet.Rooms.OpenedBy, room.ByAnyone, room.BySigned, room.ByAdmins)
	}

	if err := checkRole(&meet); err != nil {
		return nil, err
	}

	if err := checkTLS(&meet); err != nil {
		return nil, err
	}

	if err := checkMusic(meet.Music); err != nil {
		return nil, err
	}

	if err := checkWatch(meet.Watch); err != nil {
		return nil, err
	}

	if err := checkApps(&meet); err != nil {
		return nil, err
	}

	return &Config{Meet: meet, LiveKit: lk, Key: key, Secret: secret}, nil
}

// checkApps refuses a TestFlight key that cannot be used, an Android or Apple
// claim that cannot be verified and a public link that is not one, and says
// what else in the apps section will leave part of the download page empty.
//
// Only those are refused. Each is plainly a mistake rather than something not
// done yet: nobody names a key file they do not mean to use, writes down an
// app's fingerprint or identifier without meaning the app to be trusted, or
// pastes a link they do not mean people to follow. A key that cannot be read
// would otherwise surface as every invitation failing, reported to the person
// pressing the button as App Store Connect refusing them; a claim that cannot
// be verified as invitations opening in the browser on every phone, which says
// nothing at all about why; and a link that is not TestFlight's as a button
// that sends a guest somewhere else. The rest is said and let through, for the
// reason given on Apps.
func checkApps(meet *Meet) error {
	// Ignored rather than refused on a relay. A fleet's relays are often made
	// from one file with the role changed, and a section that does nothing there
	// is not worth refusing to carry media over.
	if meet.Role == RoleRelay {
		return nil
	}

	if err := checkAndroid(&meet.Apps); err != nil {
		return err
	}

	if err := checkApple(meet.Apps.AppleAppIDs); err != nil {
		return err
	}

	apps := meet.Apps
	flight := apps.TestFlight

	if err := checkPublicLink(flight.PublicLink); err != nil {
		return err
	}

	if flight.KeyFile != "" {
		if _, err := testflight.ReadKey(flight.KeyFile); err != nil {
			return fmt.Errorf("meet.apps.testflight.key_file: %w. Name the .p8 file App Store "+
				"Connect gave you, or remove the key to leave invitations off", err)
		}
	}

	var missing []string
	for _, part := range []struct{ key, value string }{
		{"key_id", flight.KeyID}, {"issuer", flight.Issuer},
		{"key_file", flight.KeyFile}, {"group", flight.Group},
	} {
		if part.value == "" {
			missing = append(missing, "meet.apps.testflight."+part.key)
		}
	}

	if len(missing) > 0 && len(missing) < 4 {
		slog.Warn("part of meet.apps.testflight is set and part is not, so the download page "+
			"offers no TestFlight invitations until the rest is", "missing", strings.Join(missing, ", "))
	}

	if apps.MacDir != "" {
		if info, err := os.Stat(apps.MacDir); err != nil || !info.IsDir() {
			slog.Warn("meet.apps.mac_dir is not a directory this server can read, so the "+
				"download page says the Mac, Android and Windows apps are not available yet", "dir", apps.MacDir)
		}
	}

	return nil
}

// androidPackage is an Android application id as Android's own package parser
// holds one to: at least two parts separated by dots, each beginning with a
// letter and going on in letters, digits and underscores. A name outside it is
// not one any app can have, so a statement naming it vouches for nothing.
var androidPackage = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`)

// androidFingerprint is a SHA-256 certificate fingerprint as the statement
// carries one: thirty-two bytes, each two hexadecimal digits, with colons
// between them.
var androidFingerprint = regexp.MustCompile(`^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$`)

// checkAndroid refuses an Android claim that cannot be verified, and writes the
// fingerprints in upper case.
//
// Every refusal here is a statement Android would fetch, fail to match against
// the app, and say nothing about: the phone opens the deployment's links in the
// browser, as it would for any site, and the only trace is a line in a log on
// somebody else's phone. A package with no fingerprint, or fingerprints with no
// package, cannot be served at all, since the statement is the two together.
//
// Upper case because that is how keytool prints a fingerprint and how the
// Digital Asset Links documentation writes them. Whether the verifier also
// matches lower case is not something worth finding out on a phone, and a
// fingerprint copied from a tool that prints lower case, with colons put in by
// hand, is the same fingerprint, so it is accepted and rewritten rather than
// refused. A fingerprint without its colons, which is how apksigner prints one,
// is refused with the form it needs, since inserting them here would be
// guessing where a mistyped digit went.
func checkAndroid(apps *Apps) error {
	if apps.AndroidPackage == "" && len(apps.AndroidCertificates) == 0 {
		return nil
	}

	const wayOut = "or remove android_package and android_certificates to claim no Android app"

	if apps.AndroidPackage == "" {
		return fmt.Errorf("meet.apps.android_certificates is set and meet.apps.android_package is "+
			"not; a fingerprint says which key signs the app and the package says which app it is, "+
			"so name the package the app is built with, %s", wayOut)
	}

	if !androidPackage.MatchString(apps.AndroidPackage) {
		return fmt.Errorf("meet.apps.android_package: %q is not an Android application id. It is "+
			"the applicationId the app is built with, two or more dotted parts each beginning with "+
			"a letter, such as app.example.android; correct it, %s", apps.AndroidPackage, wayOut)
	}

	if len(apps.AndroidCertificates) == 0 {
		return fmt.Errorf("meet.apps.android_package is set and meet.apps.android_certificates is "+
			"not; Android believes a claim to an app only with the fingerprint of a key the app is "+
			"signed with, so add it as keytool -list -v prints it beside SHA256, %s", wayOut)
	}

	for i, fingerprint := range apps.AndroidCertificates {
		if !androidFingerprint.MatchString(fingerprint) {
			return fmt.Errorf("meet.apps.android_certificates[%d]: %q is not a SHA-256 certificate "+
				"fingerprint. Each is thirty-two bytes in hexadecimal with colons between them, as "+
				"keytool -list -v prints it beside SHA256; correct it, %s", i, fingerprint, wayOut)
		}

		apps.AndroidCertificates[i] = strings.ToUpper(fingerprint)
	}

	return nil
}

// appleAppID is an app identifier as the statement Apple's devices fetch names
// one: a team id of ten capital letters and digits, a dot, and a bundle id of
// letters, digits, hyphens and dots, which is what Xcode accepts for one.
var appleAppID = regexp.MustCompile(`^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$`)

// checkApple refuses an Apple claim that cannot be verified.
//
// For the reason checkAndroid refuses one: a device fetches the statement,
// finds no app it knows by the identifier written there, and opens every
// invitation in Safari with nothing anywhere saying why. The commonest way to
// write one wrongly is the bundle id alone, which is what Xcode shows on the
// target's first page, and the next is the team id in lower case; both are
// refused with the form wanted rather than mended, since the team id cannot be
// guessed and the case is not something worth finding out about on a phone.
func checkApple(ids []string) error {
	for i, id := range ids {
		if !appleAppID.MatchString(id) {
			return fmt.Errorf("meet.apps.apple_app_ids[%d]: %q is not an Apple app identifier. Each is "+
				"the team id, ten capital letters and digits, a dot and the bundle id, such as "+
				"ABCDE12345.app.example.ios; correct it, or remove apple_app_ids to claim no Apple app", i, id)
		}
	}

	return nil
}

// testFlightLink is a TestFlight public link: Apple's address for joining a
// beta, and a code of letters and digits.
var testFlightLink = regexp.MustCompile(`^https://testflight\.apple\.com/join/[A-Za-z0-9]+$`)

// checkPublicLink refuses a public link that is not TestFlight's.
//
// The link is put on a button for people who have no account here and were
// sent nothing but an invitation, so whatever is written is where a guest is
// sent. Anything but TestFlight's own address is a mistake — the App Store
// page, an address with something pasted after it, a link to somewhere else —
// and the time to find out is before the first guest presses it.
func checkPublicLink(link string) error {
	if link == "" || testFlightLink.MatchString(link) {
		return nil
	}

	return fmt.Errorf("meet.apps.testflight.public_link: %q is not a TestFlight public link. It is "+
		"the address App Store Connect shows beside a beta group's public link, such as "+
		"https://testflight.apple.com/join/AbCd1234; correct it, or remove public_link to offer the "+
		"iOS app to accounts alone", link)
}

// checkWatch refuses a watch gateway half set up, as checkMusic refuses a
// library: the same four mistakes, and the same reasons to find them at startup.
func checkWatch(watch Watch) error {
	return checkGateway("meet.watch", watch.URL, watch.Token,
		"the gateway relays media for whoever holds it")
}

// checkMusic refuses a library half set up: an address with no token, a token
// with no address, a token short enough to guess, or an address that is not one.
// Each would otherwise be a library that answers nothing, discovered by
// somebody pressing play.
func checkMusic(music Music) error {
	return checkGateway("meet.music", music.URL, music.Token,
		"the gateway trusts whoever holds it with somebody's subscription")
}

// checkGateway is the check both gateways share. `why` is what a short token
// would give away, said in the refusal.
func checkGateway(key, address, token, why string) error {
	if address == "" && token == "" {
		return nil
	}

	if address == "" {
		return fmt.Errorf("%s.token is set and %s.url is not; the token is "+
			"for a gateway, so name it or remove both", key, key)
	}

	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return fmt.Errorf("%s.url: %q is not an http or https address", key, address)
	}

	if len(token) < MinMusicToken {
		return fmt.Errorf("%s.token is %d characters and needs at least %d: %s",
			key, len(token), MinMusicToken, why)
	}

	return nil
}

// checkTLS refuses a certificate that cannot be served, at startup.
//
// Every failure here is one that would otherwise appear as a listener that
// never came up, or worse, one that came up plaintext on a deployment that
// believed it was encrypted — and the browser refusing to connect is a long way
// from the file that was misspelled.
func checkTLS(meet *Meet) error {
	switch {
	case meet.TLSCert == "" && meet.TLSKey == "":
		return nil

	case meet.TLSCert == "":
		return fmt.Errorf("meet.tls_key is set and meet.tls_cert is not; both are needed to " +
			"serve TLS, and neither alone does anything")

	case meet.TLSKey == "":
		return fmt.Errorf("meet.tls_cert is set and meet.tls_key is not; both are needed to " +
			"serve TLS, and neither alone does anything")
	}

	// Loaded rather than merely stat'd, so that a certificate which does not
	// match its key, or a file holding something other than a certificate, is a
	// message here rather than a listener that fails to start later.
	if _, err := tls.LoadX509KeyPair(meet.TLSCert, meet.TLSKey); err != nil {
		return fmt.Errorf("meet.tls_cert and meet.tls_key: %w", err)
	}

	return nil
}

// checkRole refuses a split that cannot work, at startup.
//
// Every one of these is a configuration that starts cleanly and then fails at
// the moment somebody tries to join — a control node with nowhere to send them,
// a relay policy nobody implements. The failure is far from the cause by then,
// and the person reading the logs is looking at a join that broke rather than
// at the file that broke it.
func checkRole(meet *Meet) error {
	if meet.Role == "" {
		meet.Role = RoleFull
	}

	if !meet.Role.Valid() {
		return fmt.Errorf(
			"meet.role: %q is not a role. The three are %q, %q and %q",
			meet.Role, RoleFull, RoleRelay, RoleControl)
	}

	if meet.RelayPolicy == "" {
		meet.RelayPolicy = PickSticky
	}

	switch meet.RelayPolicy {
	case PickSticky, PickNearest, PickRoundRobin, PickProbe:
	default:
		return fmt.Errorf(
			"meet.relay_policy: %q is not a way to choose a relay. The four are %q, %q, %q and %q",
			meet.RelayPolicy, PickSticky, PickNearest, PickRoundRobin, PickProbe)
	}

	// Refused rather than warned about, because it cannot mean anything.
	//
	// "nearest" reads where a client is out of a header, and that header is only
	// read where trust_proxy says somebody upstream overwrites it -- unguarded
	// it is whatever the caller typed. So the two together are a policy that
	// never matches and silently falls through to sticky: the setting is
	// accepted, does nothing, and the only way to find out is to notice that
	// every client lands where sticky would have put them.
	if meet.Proxies < 0 {
		return fmt.Errorf("meet.proxies is %d, and a count of proxies cannot be negative", meet.Proxies)
	}

	// Refused for the same reason: a count of proxies is only ever used to read
	// X-Forwarded-For, which trust_proxy false says is not read at all.
	if meet.Proxies > 0 && !meet.TrustProxy {
		return fmt.Errorf(
			"meet.proxies is %d, which says how many proxies append to X-Forwarded-For, and "+
				"meet.trust_proxy is false, so that header is not read at all. Set trust_proxy "+
				"as well, or remove proxies", meet.Proxies)
	}

	if meet.RelayPolicy == PickNearest && !meet.TrustProxy {
		return fmt.Errorf(
			"meet.relay_policy is %q, which reads where a client is from a header, and "+
				"meet.trust_proxy is false, so that header is not believed and nothing would "+
				"ever match. Set trust_proxy where a proxy in front overwrites it, or choose "+
				"%q, which asks the client to measure instead",
			PickNearest, PickProbe)
	}

	switch meet.Role {
	case RoleControl:
		if len(meet.Relays) == 0 {
			return fmt.Errorf(
				"meet.role is %q, which starts no media server of its own, and no relays are "+
					"listed under `meet.relays` — every join would authorise somebody for a "+
					"meeting with nowhere to hold it", RoleControl)
		}

		seen := make(map[string]bool, len(meet.Relays))
		named := make(map[string]bool, len(meet.Relays))
		for i, relay := range meet.Relays {
			where := fmt.Sprintf("meet.relays[%d]", i)
			if relay.Name != "" {
				where = fmt.Sprintf("%s (%s)", where, relay.Name)
			}

			// A name is how a client refers to a relay it has measured, and how
			// an operator recognises one in a log. Required under probe because
			// the protocol turns on it; checked for collisions always, since two
			// relays answering to one name make both the client's choice and the
			// log ambiguous.
			if relay.Name == "" && meet.RelayPolicy == PickProbe {
				return fmt.Errorf(
					"meet.relay_policy is %q, where a client measures the relays and names the "+
						"one that answered fastest, but meet.relays[%d] has no name to send back",
					PickProbe, i)
			}

			if relay.Name != "" {
				if named[relay.Name] {
					return fmt.Errorf("%s: the name %q is used by another relay", where, relay.Name)
				}
				named[relay.Name] = true
			}

			if relay.URL == "" {
				return fmt.Errorf("%s has no url. A client is handed this verbatim, so it "+
					"needs the address a browser would dial, like wss://relay.example.com", where)
			}

			if !strings.HasPrefix(relay.URL, "ws://") && !strings.HasPrefix(relay.URL, "wss://") {
				return fmt.Errorf(
					"%s: %q is not a WebSocket address. It is dialled by a browser, so it "+
						"begins ws:// or wss://", where, relay.URL)
			}

			if seen[relay.URL] {
				return fmt.Errorf("%s: %q is listed twice", where, relay.URL)
			}
			seen[relay.URL] = true
		}

		if meet.RelayPolicy == PickNearest {
			for i, relay := range meet.Relays {
				if relay.Region == "" {
					return fmt.Errorf(
						"meet.relay_policy is %q, which chooses by region, but meet.relays[%d] "+
							"has none. A relay without one can never be the nearest and would "+
							"only ever be reached by the fallback", PickNearest, i)
				}
			}
		}

	case RoleRelay:
		if len(meet.Relays) > 0 {
			return fmt.Errorf(
				"meet.role is %q and `meet.relays` is set. A relay carries media; choosing "+
					"between relays is the control node's job, and listing them here would do "+
					"nothing", RoleRelay)
		}

		if len(meet.Admins) > 0 {
			return fmt.Errorf(
				"meet.role is %q and administrators are listed. A relay serves no management "+
					"pages, so these would grant nothing — put them on the control node", RoleRelay)
		}
	}

	return nil
}

// checkAdmins refuses an administrator entry that cannot mean what it says.
//
// At startup rather than at the moment somebody tries to sign in, because the
// two failures look nothing alike from the outside: a mistyped signature is a
// door that opens for nobody, and whoever finds that out is standing at it
// wondering whether they have forgotten their own passphrase.
func checkAdmins(admins []Admin) error {
	seen := make(map[string]bool, len(admins))

	for i, admin := range admins {
		where := fmt.Sprintf("admins[%d]", i)
		if admin.Name != "" {
			where = fmt.Sprintf("%s (%s)", where, admin.Name)
		}

		switch {
		case admin.Trip == "":
			return fmt.Errorf("%s has no trip. Run `tomoshibi admin new` to make one", where)

		case len(admin.Trip) != room.TripLength:
			return fmt.Errorf(
				"%s: a trip is %d characters, and this one is %d. The kind prefix and "+
					"the dash that follow it in an identity are not part of it",
				where, room.TripLength, len(admin.Trip))

		case !tripCharacters(admin.Trip):
			return fmt.Errorf(
				"%s: a trip is lowercase letters and the digits 2 to 7. This one holds "+
					"something else", where)

		case seen[admin.Trip]:
			return fmt.Errorf("%s: this trip is listed twice, which can only be a mistake", where)
		}

		for _, capability := range admin.Can {
			if !Known(capability) {
				return fmt.Errorf(
					"%s: %q is not something an administrator can be allowed. The ones there are: %s",
					where, capability, strings.Join(capabilities, ", "))
			}
		}

		seen[admin.Trip] = true
	}

	return nil
}

// Administrator finds the administrator a passphrase belongs to.
//
// The signature is derived exactly as a participant's is, with the same key, so
// an administrator's credential is the one they already have: they type it to
// join a call and it prints beside their name. What is listed here is that
// printed signature and never the passphrase.
//
// Every entry is compared even after one matches. The work is a handful of
// string comparisons, and stopping at the first match would leak, through the
// time taken, how far down the list a signature sits.
func Administrator(admins []Admin, passphrase room.Passphrase, tripKey []byte) (Admin, bool) {
	return NamedAdministrator(admins, "", passphrase, tripKey)
}

// NamedAdministrator is the same question with a name attached.
//
// The management sign-in asks for both, and it asks for a reason: a passphrase
// alone is a single secret that anybody may guess at, and every guess is checked
// against every administrator at once. A list of leaked passphrases run at this
// endpoint would find a match if any one person on the deployment had reused
// one. Requiring the name means a guess has to be aimed at somebody, which turns
// one pool into as many separate ones as there are administrators.
//
// The room join is the other caller and passes no name, because there is nobody
// to name: somebody opening a room proves they hold an administrator's
// passphrase and nothing more is asked of them.
//
// An administrator with no name recorded is matched by passphrase alone, as
// before. Refusing them would lock out any deployment upgrading into this, and
// the fix is to give them a name — which the management pages now do.
func NamedAdministrator(
	admins []Admin,
	name string,
	passphrase room.Passphrase,
	tripKey []byte,
) (Admin, bool) {
	if passphrase.Empty() {
		return Admin{}, false
	}

	trip := []byte(room.Trip(tripKey, strings.TrimSpace(string(passphrase))))
	wanted := strings.ToLower(strings.TrimSpace(name))

	var found Admin
	matched := false

	for _, admin := range admins {
		// Compared in full rather than skipped early, so that the work done is
		// the same whether or not a name was right. A loop that returned as soon
		// as the name missed would answer faster for a name nobody has, which is
		// a way to enumerate who does.
		right := subtle.ConstantTimeCompare([]byte(admin.Trip), trip)

		named := 1
		if wanted != "" && admin.Name != "" {
			named = subtle.ConstantTimeCompare(
				[]byte(strings.ToLower(strings.TrimSpace(admin.Name))),
				[]byte(wanted),
			)
		}

		if right == 1 && named == 1 {
			found = admin
			matched = true
		}
	}

	return found, matched
}

// tripCharacters says whether a signature holds only what one is made of. The
// alphabet lives in the package that makes them; this is the one thing about it
// worth checking here, and checking it here is what turns a mistyped entry into
// a message at startup rather than a door that opens for nobody.
func tripCharacters(trip string) bool {
	for _, r := range trip {
		if (r < 'a' || r > 'z') && (r < '2' || r > '7') {
			return false
		}
	}

	return true
}

// split separates the `meet` section from the rest of the document.
//
// The remainder is re-encoded rather than edited in place, because YAML is not
// a format one can safely cut a section out of with string operations: anchors,
// flow style, and comments all make the textual boundaries of a section
// something only a parser knows.
func split(document []byte) (Meet, []byte, error) {
	meet := defaults

	if len(document) == 0 {
		return meet, nil, nil
	}

	var whole map[string]yaml.Node
	if err := yaml.Unmarshal(document, &whole); err != nil {
		return meet, nil, fmt.Errorf("parse the configuration: %w", err)
	}

	if section, ok := whole["meet"]; ok {
		// Round-tripped through bytes rather than decoded from the node, because
		// only a Decoder can be told to reject unknown fields, and a typo in our
		// half deserves the same error as a typo in theirs.
		raw, err := yaml.Marshal(&section)
		if err != nil {
			return meet, nil, fmt.Errorf("re-encode the meet section: %w", err)
		}

		decoder := yaml.NewDecoder(bytes.NewReader(raw))
		decoder.KnownFields(true)

		if err := decoder.Decode(&meet); err != nil && err != io.EOF {
			return meet, nil, fmt.Errorf("parse the meet section: %w", err)
		}

		delete(whole, "meet")
	}

	rest, err := yaml.Marshal(whole)
	if err != nil {
		return meet, nil, fmt.Errorf("re-encode the configuration: %w", err)
	}

	return meet, rest, nil
}

// credentials pulls the one API key pair out of the resolved config.
//
// Exactly one, because this server signs with it: several would mean choosing,
// and a choice nobody made is a choice that will surprise somebody.
func credentials(lk *livekit.Config) (string, string, error) {
	switch len(lk.Keys) {
	case 0:
		return "", "", fmt.Errorf(
			"no API key: add one under `keys` in the configuration, " +
				"or run `tomoshibi keygen` to generate a pair",
		)
	case 1:
		for key, secret := range lk.Keys {
			return key, secret, nil
		}
	}

	return "", "", fmt.Errorf(
		"%d API keys configured, but this server signs its own tokens and can only use one: "+
			"leave a single entry under `keys`", len(lk.Keys),
	)
}

// Cert and Key are the certificate handed to a new relay.
//
// The listener's own by default. A control node serving TLS directly already
// holds exactly the pair every relay needs, and naming it twice is one more
// place for the two to drift apart.
func (e Enrol) Cert(fallback string) string {
	if e.CertFile != "" {
		return e.CertFile
	}
	return fallback
}

func (e Enrol) Key(fallback string) string {
	if e.KeyFile != "" {
		return e.KeyFile
	}
	return fallback
}
