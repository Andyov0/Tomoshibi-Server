// Command tomoshibi is a video meeting server: the media server, the join
// endpoint, and the client, in one binary.
//
// The media server is embedded rather than run alongside. Folding the two
// together means the token is signed with the same credentials, in the same
// process, that verify it, and that deploying this is copying one file.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime/debug"
	"strings"
	"syscall"
	"text/tabwriter"
	"time"

	"tomoshibi/internal/admin"
	"tomoshibi/internal/app"
	"tomoshibi/internal/config"
	"tomoshibi/internal/dns"
	"tomoshibi/internal/room"
	"tomoshibi/internal/rtc"
	"tomoshibi/internal/store"
)

// The built client.
//
// `all:` so that files beginning with a dot or an underscore are kept, which
// some build outputs rely on and which is also what keeps the tracked marker
// file inside this directory from being skipped. The directory has to exist at
// compile time even when nothing has been built into it, so the repository
// carries that marker and ignores everything else here.
//
//go:embed all:web/dist
var bundled embed.FS

// What to serve when nothing was built.
//
// Kept as its own file rather than as a document inside the client's output
// directory, so that building the client cannot overwrite it and leave a
// spurious change behind in the working tree.
//
//go:embed placeholder.html
var placeholder []byte

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	command, rest := split(args)

	switch command {
	case "serve":
		return serve(rest)
	case "keygen":
		return keygen()
	case "rooms":
		return listRooms(rest)
	case "admin":
		return adminCommand(rest)
	case "version", "-v", "--version":
		fmt.Println(version())
		return nil
	case "help", "-h", "--help":
		usage(os.Stdout)
		return nil
	default:
		usage(os.Stderr)
		return fmt.Errorf("unknown command %q", command)
	}
}

// split separates the command from its arguments, defaulting to serve.
//
// Defaulting rather than requiring it, because running the binary with no
// arguments should start a server: that is what somebody trying it out means,
// and a usage message would be a worse answer than a working default.
func split(args []string) (string, []string) {
	if len(args) == 0 {
		return "serve", nil
	}

	switch args[0] {
	case "serve", "keygen", "rooms", "admin", "version", "-v", "--version", "help", "-h", "--help":
		return args[0], args[1:]
	default:
		// Anything else is taken as the configuration file, so
		// `tomoshibi meet.yaml` works without the ceremony.
		return "serve", args
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `tomoshibi: a video meeting server in one binary

  tomoshibi [serve] [config.yaml]   Serve the client, the API, and the media
  tomoshibi version                 Print which build this is
  tomoshibi keygen                  Print a fresh API key and secret
  tomoshibi rooms <database>        List the rooms a store has seen
  tomoshibi admin new [config.yaml] Make an administrator's passphrase and trip
  tomoshibi admin trip [config.yaml] <passphrase>
                                    Work out the trip an existing passphrase gives

Running with no arguments serves with built-in defaults.
`)
}

// adminCommand turns a passphrase into the signature a configuration file
// lists, in both directions.
//
// It needs the configuration because a signature is only meaningful against one
// deployment's key: the same passphrase on two servers produces two different
// marks, which is what stops one deployment's signatures being worth anything on
// another.
func adminCommand(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("admin needs `new` or `trip`")
	}

	action, rest := args[0], args[1:]

	// A configuration file, if one was named.
	//
	// Recognised by being a file that exists rather than by its extension. The
	// test used to be a ".yaml" suffix, so `admin trip control.yml <passphrase>`
	// silently took the filename as the passphrase and fell back to the built-in
	// defaults — which name a different tripcode key, so the trip printed was
	// derived from the wrong secret and valid on no deployment. It is ten
	// characters of the right shape either way; nothing about it says which.
	//
	// `serve` has never cared about the extension, so this was also a difference
	// between two commands in the same binary for no reason anybody could see.
	path := ""
	if len(rest) > 0 {
		if _, err := os.Stat(rest[0]); err == nil {
			path, rest = rest[0], rest[1:]
		} else if strings.ContainsAny(rest[0], "/\\") || strings.HasSuffix(rest[0], ".yaml") ||
			strings.HasSuffix(rest[0], ".yml") {
			// Named something that is plainly meant to be a file and is not one.
			// Refused rather than taken as a passphrase: somebody who mistypes a
			// path should be told, and the alternative is a trip they will paste
			// into a configuration file and wonder about.
			return fmt.Errorf("%s: %w", rest[0], err)
		}
	}

	conf, err := config.Load(path)
	if err != nil {
		return err
	}

	key, err := room.LoadTripKey(conf.Meet.TripcodeKey)
	if err != nil {
		return err
	}

	switch action {
	case "new":
		// Generated, never chosen. A signature cannot be attacked offline
		// without this deployment's key, so the only way at one is through the
		// join endpoint — where the limiter stands. But the limiter counts per
		// address and an attacker picks how many addresses to be, and against a
		// passphrase somebody thought of that is about a quarter of an hour.
		passphrase := room.NewPassphrase()

		fmt.Printf("passphrase  %s\n", passphrase)
		fmt.Printf("trip        %s\n\n", room.Trip(key, passphrase))
		fmt.Print("Put the trip in the configuration and the passphrase in a password manager.\n" +
			"The passphrase is not stored here and cannot be recovered; the trip is public and\n" +
			"is printed beside its owner's name in every room they join.\n")

		return nil

	case "trip":
		if len(rest) == 0 {
			return fmt.Errorf("admin trip needs a passphrase")
		}

		fmt.Println(room.Trip(key, strings.TrimSpace(strings.Join(rest, " "))))
		return nil

	default:
		return fmt.Errorf("admin has no %q; the two are `new` and `trip`", action)
	}
}

func serve(args []string) error {
	path := ""
	if len(args) > 0 {
		path = args[0]
	}

	conf, err := config.Load(path)
	if err != nil {
		return err
	}

	logging(conf.LiveKit.Logging.Level)

	// What this process is made of follows from its role. A relay carries media
	// and keeps nothing; a control node keeps everything and carries none.
	var (
		web     http.Handler
		st      *store.Store
		tripKey []byte
		media   *rtc.Server
	)

	if conf.Meet.Role != config.RoleRelay {
		var err error

		if web, err = client(conf.Meet.WebRoot); err != nil {
			return err
		}

		if st, err = store.Open(conf.Meet.Database); err != nil {
			return err
		}
		defer st.Close()

		// Before anything is adopted into it, because adopting writes. A store
		// that has lost everything and one being started for the first time look
		// identical to bolt — a file truncated to nothing opens without an error
		// and reports no buckets — and the adoption is what makes the second
		// indistinguishable from the first by filling it back in from the
		// configuration file. Asked here, it is still possible to tell.
		emptied(st, conf)

		// The administrators first, because the opening asks how many there
		// are: a policy of "only administrators may open a room" with nobody
		// listed is a rule nothing could satisfy, and it says so.
		//
		// This used to be the other way round, under a comment giving this
		// same reason for the opposite order. The reason was not true then --
		// the opening counted the configuration file, which is written before
		// any of this runs -- so the order did not matter and nothing noticed
		// it was backwards. It counts the store now, which is what actually
		// decides the policy, so the order is load-bearing and this is the
		// direction it has to be.
		if err := adoptAdmins(st, conf); err != nil {
			return err
		}

		if err := adoptOpening(st, conf); err != nil {
			return err
		}

		if err := adoptRelays(st, conf); err != nil {
			return err
		}

		if tripKey, err = room.LoadTripKey(conf.Meet.TripcodeKey); err != nil {
			return err
		}
	}

	// A control node starts none: the meetings it authorises are held on the
	// relays it lists, and a media server here would sit idle holding a UDP
	// port open on a machine nobody was ever told to dial.
	if conf.Meet.Role != config.RoleControl {
		var err error
		// A UDP echo a client can time. Started beside the media server because
		// it describes the same path: what it measures is the round trip a call
		// will actually have, rather than the three that opening a TLS socket
		// costs.
		probe, err := rtc.Listen(conf.Meet.ProbePort)
		if err != nil {
			return fmt.Errorf("listen for stun on udp %d: %w", conf.Meet.ProbePort, err)
		}

		if probe != nil {
			defer probe.Close()
			probe.Announce()
		}

		if media, err = rtc.Start(conf.LiveKit); err != nil {
			return err
		}
	}

	announceRole(conf)

	application := app.New(conf, st, media, web, tripKey)
	defer application.Close()

	// A control node has no media server of its own, so the management pages
	// would have nothing to ask about rooms or participants. Pointed at the
	// relays instead, they work as a full deployment's do: the questions go to
	// whichever relay answers, and redis makes any one of them speak for all.
	if conf.Meet.Role == config.RoleControl {
		application.UseCluster(rtc.NewCluster(
			func() []string { return application.RelayURLs() },
			conf.Key, conf.Secret,
			conf.Meet.PublicAddresses...,
		))

		if enrolment := enrolFrom(conf); enrolment != nil {
			application.UseEnrolment(enrolment)
			slog.Info("relays can enrol themselves",
				"domain", enrolment.Domain, "port", enrolment.ListenPort,
				"names DNS", enrolment.Naming != nil)
		}
	}

	// After everything above, because the sampler reads what those assigned.
	// Started during construction it raced them, which the race detector found
	// in a test doing exactly what these lines do.
	application.Watching()

	server := &http.Server{
		Addr:    conf.Meet.Listen,
		Handler: application.Handler(),

		// HTTP/2 off, and this is not a preference.
		//
		// ServeTLS turns it on by advertising h2 in ALPN, and a WebSocket
		// cannot be opened over an HTTP/2 connection by anything here: the
		// upgrade this server performs is the HTTP/1.1 one, and the extension
		// that carries it over h2 is implemented by neither the standard
		// library nor the media server's client. A browser negotiates h2,
		// asks for the signalling path, and is answered 404 by a router whose
		// upgrade handler was never reached.
		//
		// Which is exactly what happened the first time a relay was given a
		// certificate: plaintext worked, TLS returned 404, and the difference
		// was ALPN. An empty map is how the standard library is told not to
		// offer it.
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){},
		// Absent on purpose: a signalling WebSocket is meant to stay open for
		// the length of a meeting, and a write timeout would cut it. Read
		// headers are still bounded, which is what protects against a client
		// that connects and says nothing.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Read before anything is opened, so a missing file or a key that does not
	// match its certificate is a sentence at startup rather than a listener
	// that comes up and refuses every handshake.
	var pair *keypair
	if conf.Meet.TLSCert != "" {
		pair, err = newKeypair(conf.Meet.TLSCert, conf.Meet.TLSKey)
		if err != nil {
			return err
		}
	}

	listener, err := net.Listen("tcp", conf.Meet.Listen)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", conf.Meet.Listen, err)
	}

	announce(listener.Addr(), conf.Meet.TLSCert != "")

	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)

	failed := make(chan error, 1)
	go func() {
		// Configured certificate wins. Checked at load, so a file that is
		// missing or does not match its key has already been a message rather
		// than a listener that quietly never came up — or worse, one that came
		// up plaintext on a deployment that believed otherwise.
		var err error
		if conf.Meet.TLSCert != "" {
			// Through a callback rather than by handing ServeTLS the paths,
			// so that a renewal is a file copy rather than a restart. See
			// certs.go: a restart here drops every call on the machine, and
			// the fleet renews four times a year.
			server.TLSConfig = &tls.Config{GetCertificate: pair.certificate}

			err = server.ServeTLS(listener, "", "")
		} else {
			err = server.Serve(listener)
		}

		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			failed <- err
		}
	}()

	select {
	case err := <-failed:
		if media != nil {
			media.Stop(true)
		}
		return err
	case <-stopping:
		slog.Info("shutting down")
	}

	// Sessions first, then the listener: draining the media server while the
	// door is still open lets a participant finish their sentence, where the
	// other order would drop them and then wait politely for nothing.
	//
	// A control node has none to drain.
	if media != nil {
		drain(media, stopping)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	return server.Shutdown(ctx)
}

// How long a shutdown waits for meetings to end on their own.
//
// The media server's own drain has no deadline: it looks every five seconds for
// anybody still connected and returns when there is nobody, which on a busy
// relay is when the last meeting of the day ends. Asked to stop by systemd --
// which is how every relay is upgraded -- the process sat there until the
// manager gave up at ninety seconds and killed it, which ends every call just the
// same and skips the rest of the shutdown on the way. Under those ninety, so
// that what ends the calls is this rather than that, and short enough that an
// upgrade across the fleet is not an hour and a half of waiting.
const drainFor = 30 * time.Second

// drain lets meetings finish, for a while.
//
// Ended early by a second signal, which is somebody at a terminal saying they
// meant it. The first signal used to be the only one heard: the channel was
// never read again, so pressing Ctrl-C twice did nothing the second time.
func drain(media *rtc.Server, stopping <-chan os.Signal) {
	drained := make(chan struct{})
	go func() {
		media.Stop(false)
		close(drained)
	}()

	select {
	case <-drained:
	case <-time.After(drainFor):
		slog.Warn("meetings were still going after the shutdown's allowance, ending them", "waited", drainFor)
		media.Stop(true)
	case <-stopping:
		slog.Warn("asked to stop again, ending every meeting now")
		media.Stop(true)
	}
}

// client picks where the client is served from.
//
// A configured directory wins, so that a running server can be pointed at a
// fresh build without recompiling. Otherwise it is the copy inside the binary,
// which is what a deployment uses and why there is only one file to copy.
func client(root string) (http.Handler, error) {
	if root != "" {
		files, err := app.Dir(root)
		if err != nil {
			return nil, fmt.Errorf("serve the client from %s: %w", root, err)
		}

		slog.Info("serving the client from disk", "path", root)
		return app.Web(files), nil
	}

	files, err := fs.Sub(bundled, "web/dist")
	if err != nil {
		return nil, fmt.Errorf("read the bundled client: %w", err)
	}

	// Nothing was built into this binary. Answering 404 for every path would be
	// accurate and useless; one page saying which command to run is what this
	// situation actually needs.
	if _, err := fs.Stat(files, "index.html"); err != nil {
		slog.Warn("no client was built into this binary, serving instructions instead")
		return app.Placeholder(placeholder), nil
	}

	return app.Web(files), nil
}

// keygen prints a fresh credential pair.
//
// Printed rather than written, because where it belongs is a question only the
// operator can answer: a configuration file, a secret store, or an environment
// variable in a deployment system.
func keygen() error {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return fmt.Errorf("read random bytes: %w", err)
	}

	name := make([]byte, 6)
	if _, err := rand.Read(name); err != nil {
		return fmt.Errorf("read random bytes: %w", err)
	}

	fmt.Printf("keys:\n  API%s: %s\n", hex.EncodeToString(name), hex.EncodeToString(secret))
	return nil
}

// listRooms prints every room a store has seen, most recent first.
func listRooms(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("which store? pass the path to the database file")
	}

	st, err := store.Open(args[0])
	if err != nil {
		return err
	}
	defer st.Close()

	rooms, err := st.Rooms()
	if err != nil {
		return err
	}

	if len(rooms) == 0 {
		fmt.Printf("no rooms recorded in %s\n", args[0])
		return nil
	}

	out := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(out, "ROOM\tJOINS\tLAST SEEN")
	for _, named := range rooms {
		fmt.Fprintf(out, "%s\t%d\t%s\n",
			named.Name, named.Room.Joins, named.Room.Seen.Format(time.RFC3339))
	}

	return out.Flush()
}

// enrolFrom builds what a new relay is told, or nothing where enrolment was not
// configured.
//
// Certificate paths come from the listener's own, because a relay is handed the
// certificate this deployment already uses: a control node behind a proxy has
// none of its own, and one serving TLS directly has exactly the pair every
// relay needs.
func enrolFrom(conf *config.Config) *admin.Enrolment {
	if conf.Meet.Enrol.Secret == "" || conf.Meet.Enrol.Domain == "" {
		return nil
	}

	enrolment := &admin.Enrolment{
		Secret:        conf.Meet.Enrol.Secret,
		Domain:        conf.Meet.Enrol.Domain,
		PublicURL:     conf.Meet.Enrol.PublicURL,
		RedisAddr:     relayRedis(conf),
		RedisPassword: conf.LiveKit.Redis.Password,
		CertPath:      conf.Meet.Enrol.Cert(conf.Meet.TLSCert),
		KeyPath:       conf.Meet.Enrol.Key(conf.Meet.TLSKey),
		ListenPort:    conf.Meet.Enrol.ListenPort,
		UDPPort:       conf.Meet.Enrol.UDPPort,
		TCPPort:       conf.Meet.Enrol.TCPPort,
		ProbePort:     conf.Meet.Enrol.ProbePort,
	}

	if cf := dns.NewCloudflare(conf.Meet.Enrol.CloudflareToken, conf.Meet.Enrol.CloudflareZone); cf.Configured() {
		enrolment.Naming = cf
	} else {
		slog.Warn("no cloudflare credentials for enrolment: a relay will install itself and " +
			"then wait for somebody to point its name at it")
	}

	return enrolment
}

// relayRedis is the address a relay should use, which is not always the one
// this node uses.
//
// A control node with redis beside it reaches it on loopback, and handing that
// to another machine points it at its own — where there is nothing. The failure
// is loud but misleading: the relay says it cannot reach redis and names an
// address nobody configured for it.
func relayRedis(conf *config.Config) string {
	if configured := conf.Meet.Enrol.RedisAddr; configured != "" {
		return configured
	}

	address := conf.LiveKit.Redis.Address

	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return address
	}

	// Only the addresses that mean "this machine" are a problem. Anything else
	// is a name or address that means the same thing everywhere, and is what a
	// relay should use too.
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() || host == "localhost" {
		slog.Warn("redis is configured on loopback, which no relay can reach. Set "+
			"meet.enrol.redis_addr to the address relays should use",
			"configured", address, "port", port)
	}

	return address
}

// adoptRelays writes the configured relays into the store the first time this
// runs, and says what is in effect.
//
// The file is the starting value and only that, exactly as the opening policy
// is: after the first start the management pages are what change this, and a
// file that no longer matches is the likeliest reason somebody is looking at a
// relay list that is not the one they edited.
func adoptRelays(st *store.Store, conf *config.Config) error {
	configured := make([]store.Relay, 0, len(conf.Meet.Relays))
	for _, relay := range conf.Meet.Relays {
		configured = append(configured, store.Relay{
			Name: relay.Name, URL: relay.URL, Region: relay.Region, Enabled: true,
		})
	}

	adopted, err := st.AdoptRelays(configured)
	if err != nil {
		return err
	}

	live, err := st.Relays()
	if err != nil {
		return err
	}

	if adopted && len(configured) > 0 {
		slog.Info("adopted the relays from the configuration file; the management pages "+
			"are what change them from here", "relays", len(configured))
	}

	if !adopted && len(conf.Meet.Relays) > 0 {
		slog.Warn("meet.relays in the configuration file is the starting value only, and this "+
			"deployment already has its own list. Edit the relays from the management pages",
			"configured", len(conf.Meet.Relays), "in effect", len(live))
	}

	for _, relay := range live {
		slog.Info("relay", "name", relay.Name, "url", relay.URL,
			"region", relay.Region, "enabled", relay.Enabled)
	}

	return nil
}

// adoptAdmins writes the configured administrators in, the first time this runs.
//
// After that the management pages are what change them, and the file is the way
// back in: somebody who can edit it on the host and restart is put back on a
// deployment whose store was lost. That is deliberate. The alternative is a
// deployment that has locked out the person who owns the machine.
func adoptAdmins(st *store.Store, conf *config.Config) error {
	adopted, err := st.AdoptAdmins(conf.Meet.Admins)
	if err != nil {
		return err
	}

	live, err := st.Admins()
	if err != nil {
		return err
	}

	if adopted && len(conf.Meet.Admins) > 0 {
		slog.Info("adopted the administrators from the configuration file; the management "+
			"pages are what change them from here", "administrators", len(conf.Meet.Admins))
	}

	if !adopted && len(conf.Meet.Admins) > 0 && len(live) != len(conf.Meet.Admins) {
		slog.Warn("meet.admins in the configuration file is the starting value only, and this "+
			"deployment already has its own list. Edit the administrators from the "+
			"management pages",
			"configured", len(conf.Meet.Admins), "in effect", len(live))
	}

	for _, admin := range live {
		slog.Info("administrator", "name", admin.Name, "trip", admin.Trip, "can", admin.Can)
	}

	return nil
}

// adoptOpening settles who may open a room, and says so.
//
// The configuration file is the starting value and only that: it is written into
// the store the first time this runs, and after that the management pages are
// what change it. Said out loud on every start because there is no other way to
// find out — a file that no longer matches is the likeliest reason somebody is
// standing in front of this wondering why a room will not open.
func adoptOpening(st *store.Store, conf *config.Config) error {
	chosen, err := st.AdoptOpening(conf.Meet.Rooms.OpenedBy)
	if err != nil {
		return err
	}

	// Counted from the store rather than from the file, because the store is
	// what decides it at runtime and the file is only what the store adopted on
	// a first start. A deployment whose administrators were all added through
	// the management pages has an empty list in its file and a full one in its
	// store, and this warned at every start that nobody was configured and that
	// anybody could open a room -- while the policy it was warning about was
	// working correctly. An operator following that warning is following it to
	// nothing.
	listed, err := st.Admins()
	if err != nil {
		return err
	}

	if opening := chosen.InEffect(len(listed)); opening != chosen {
		slog.Warn(
			"rooms are set to be opened by an administrator, and nobody is configured as one. "+
				"Nothing could satisfy that, so anybody may open one until somebody is listed",
			"chosen", chosen, "in effect", opening)

		return nil
	}

	if chosen != conf.Meet.Rooms.OpenedBy {
		slog.Warn(
			"who may open a room was changed from the management pages and no longer matches "+
				"the configuration file, which is only ever the starting value",
			"configured", conf.Meet.Rooms.OpenedBy, "in effect", chosen)

		return nil
	}

	slog.Info("rooms", "opened by", chosen, "administrators", len(listed))

	return nil
}

// announceRole says which half of a deployment this process is, and what that
// means for the ports it is about to open.
//
// Said out loud because the roles fail quietly when confused. A relay nobody
// realises is a relay looks like a broken server: the address serves no client
// and answers 404 for everything a browser asks for, which is correct and looks
// exactly like a deployment gone wrong.
func announceRole(conf *config.Config) {
	switch conf.Meet.Role {
	case config.RoleRelay:
		slog.Info("relay: media and signalling only, no client and no join endpoint",
			"udp", conf.LiveKit.RTC.UDPPort, "tcp", conf.LiveKit.RTC.TCPPort)

		// A relay's whole purpose is being dialled from elsewhere, and the
		// address it advertises comes from this. Left false it hands out an
		// address only the machine itself can reach, and every connection to it
		// fails after appearing to succeed.
		if !conf.LiveKit.RTC.UseExternalIP {
			slog.Warn("rtc.use_external_ip is false on a relay: clients will be handed an " +
				"address only this machine can reach. Set it unless a proxy rewrites candidates")
		}

		if conf.LiveKit.Redis.Address == "" {
			slog.Warn("no redis is configured: this relay cannot join others in a cluster, so " +
				"a meeting split across relays will not be able to hear itself")
		}

	case config.RoleControl:
		slog.Info("control: client, joins and management; media is held on the relays below",
			"relays", len(conf.Meet.Relays), "policy", conf.Meet.RelayPolicy)

		for _, relay := range conf.Meet.Relays {
			slog.Info("relay", "name", relay.Name, "url", relay.URL, "region", relay.Region)
		}

		if conf.LiveKit.Redis.Address == "" {
			slog.Warn("no redis is configured: the relays cannot route between themselves, so " +
				"everybody in one meeting must land on one relay. The sticky policy does that")
		}

	default:
		slog.Info("serving the client, the joins and the media from this one process")
	}

	announceSettings(conf)
}

// announceSettings writes the configuration this process is actually running
// with, once, at startup.
//
// It duplicates the management pages' runtime panel, and that is the point. The
// panel answers "is this process using what I edited", which is a good question
// and one that can only be asked of a process that is answering requests — so
// the answer is available exactly when nobody needs it and gone when they do.
// Written here it survives a restart, is readable over ssh with the service
// stopped, and is the first thing in the log above whatever went wrong next.
//
// The key is said and the secret is not, which is the same rule the panel keeps
// and for the same reason: the key identifies a deployment and the secret is the
// deployment. Anybody who can read this log can already read the file it came
// from, but a log is the thing that gets pasted into a chat window.
func announceSettings(conf *config.Config) {
	// Said once, and not fatal.
	//
	// Section 13 of the licence obliges whoever offers this over a network to
	// offer its source to the people using it that way, and the link on the join
	// page is how that is discharged. Where nothing is configured the client
	// draws no link -- an offer of somebody else's source looks discharged and
	// is not -- so the only place this can be noticed is here.
	//
	// The default used to be the upstream repository, which made every
	// deployment that never set this quietly point its visitors at code it was
	// not running.
	//
	// Not on a relay, which serves no join page and therefore offers nobody
	// anything. The obligation belongs to whoever offers the program over a
	// network, and on this deployment that is the control node; a relay carries
	// media for it. Warning on every relay would be nine machines reporting a
	// duty that is not theirs, which is how a real one gets scrolled past.
	if conf.Meet.SourceURL == "" && conf.Meet.Role != config.RoleRelay {
		slog.Warn("meet.source_url is not set, so the join page offers nobody the source of what "+
			"is running here: the licence asks for that of anybody offering this over a network",
			"set it to", "wherever this deployment's code can be read")
	}

	// The build, beside the settings, because the two questions asked when a
	// deployment behaves unexpectedly are what it is configured to do and which
	// binary is doing it, and only one of them had an answer.
	slog.Info("settings: this deployment",
		"build", version(),
		"listen", conf.Meet.Listen,
		"public url", conf.Meet.PublicURL,
		"token ttl", conf.Meet.TokenTTL.String(),
		"join rate", conf.Meet.JoinRate,
		"join burst", conf.Meet.JoinBurst,
		"trust proxy", conf.Meet.TrustProxy,
		"proxies", conf.Meet.Hops(),
		"database", conf.Meet.Database,
		"api key", conf.Key)

	codecs := make([]string, 0, len(conf.LiveKit.Room.EnabledCodecs))
	for _, codec := range conf.LiveKit.Room.EnabledCodecs {
		codecs = append(codecs, codec.Mime)
	}

	slog.Info("settings: what clients are told to dial",
		"node ip", conf.LiveKit.RTC.NodeIP.V4,
		"use external ip", conf.LiveKit.RTC.UseExternalIP,
		"udp", conf.LiveKit.RTC.UDPPort.Start,
		"tcp", conf.LiveKit.RTC.TCPPort,
		"bind", conf.LiveKit.BindAddresses,
		"http", conf.LiveKit.Port,
		"codecs", codecs)

	// How each viewer's share of the media is decided, said wherever media is
	// held. A relay brought up before these settings existed gets them added
	// to its file by hand, and the strict loader only proves that what was
	// added is spelled right: not that it went into the file the service
	// reads, nor that the process answering is one started since. A relay on
	// the receive-side estimate looks exactly like one on the sender-side
	// estimate until somebody's screen share freezes, so the difference is
	// written where a restart leaves it to be read. RELAY.md has the numbers
	// behind both settings.
	//
	// Not on a control node, which holds no media and would be reporting
	// defaults that govern nothing.
	if conf.Meet.Role != config.RoleControl {
		slog.Info(mediaSettingsSaid, mediaSettings(conf)...)
	}
}

// mediaSettingsSaid is what a relay starts that line with.
//
// The words of that line are not this file's to change alone. The release
// script for running relays and RELAY.md's own steps find it by "how each
// viewer" and read "send side bwe" and "video nack window" off it, and a key
// renamed here would have every relay on release day report that the process
// answering did not read its settings — and an operator roll back a relay that
// had been changed correctly. TestMediaSettingsLine renders it through the media
// server's own logger, in both of its formats, and matches it the way they do.
const mediaSettingsSaid = "settings: how each viewer's media is chosen"

// mediaSettings is the rest of that line.
func mediaSettings(conf *config.Config) []any {
	cc := conf.LiveKit.RTC.CongestionControl
	return []any{
		"congestion control", cc.Enabled,
		"send side bwe", cc.UseSendSideBWE,
		"pacer", cc.SendSideBWEPacer,
		"video nack window", conf.LiveKit.RTC.PacketBufferSizeVideo,
	}
}

// announce prints where to open the client.
//
// The address on the network comes with a warning rather than on its own,
// because over plain HTTP it is a link that loads and then cannot open a camera:
// browsers withhold devices outside a secure context, and only localhost is
// exempt. Printing it unqualified would be an invitation into that dead end.
func announce(addr net.Addr, secure bool) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		slog.Info("listening", "addr", addr.String())
		return
	}

	scheme := "http"
	if secure {
		scheme = "https"
	}

	slog.Info("client", "url", fmt.Sprintf("%s://localhost:%d/", scheme, tcp.Port))

	for _, ip := range outward() {
		if secure {
			slog.Info("reachable on the network", "url", fmt.Sprintf("https://%s:%d/", ip, tcp.Port))
			continue
		}

		slog.Warn(
			"reachable on the network, but cameras need a secure page: put this behind HTTPS "+
				"before using it from another machine",
			"url", fmt.Sprintf("http://%s:%d/", ip, tcp.Port),
		)
	}
}

// outward returns the address this host would use to reach the wider network.
//
// Connecting a UDP socket sends nothing; it asks the routing table which local
// address would carry a packet outward, which is the one worth printing.
func outward() []net.IP {
	conn, err := net.Dial("udp4", "203.0.113.1:80")
	if err != nil {
		return nil
	}
	defer conn.Close()

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok || addr.IP.IsLoopback() {
		return nil
	}

	return []net.IP{addr.IP}
}

// logging installs a handler at the level the configuration asked for.
func logging(level string) {
	var parsed slog.Level

	err := parsed.UnmarshalText([]byte(level))
	if err != nil {
		parsed = slog.LevelInfo
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: parsed})))

	// Said after the handler is in place, because before it there is nothing to
	// say it with.
	//
	// A level that does not parse fell back to info and told nobody, and the
	// thing somebody types when they mean warn is "warning" — which is not a
	// level. So a deployment set to be quiet was as loud as the default and the
	// only evidence was the volume of its own log, which is exactly what
	// somebody had decided not to read.
	//
	// Not fatal. A log level nobody can parse should not stop a server that
	// otherwise starts, and info is the safe direction: it says more rather than
	// less.
	if err != nil && strings.TrimSpace(level) != "" {
		slog.Warn("that is not a log level, so this is running at info",
			"asked for", level, "levels", "debug, info, warn, error")
	}
}

// emptied says so when the store holds nothing but has held something before.
//
// A first start and a store truncated to nothing are the same thing to bolt: it
// opens both without complaint and reports no buckets in either. They call for
// opposite reactions, and the only thing that tells them apart is whether there
// are copies beside it — a first start has none.
//
// Called before the configuration file is adopted into the store, which is the
// only moment this can be asked. Adopting writes, so a second later the store
// has buckets and looks like a working deployment that has merely forgotten its
// relays' addresses, its accounts and every measurement anybody made by hand.
func emptied(st *store.Store, conf *config.Config) {
	empty, err := st.Empty()
	if err != nil {
		slog.Warn("could not look at the store to see whether it holds anything", "error", err)
		return
	}

	if !empty {
		return
	}

	copies, err := store.Copies(conf.Meet.Database)
	if err != nil || len(copies) == 0 {
		// Nothing to compare against, so nothing can be said. A deployment being
		// started for the first time lands here and is right to hear nothing.
		return
	}

	slog.Error("the store is empty and there are copies of it beside it, so this deployment held "+
		"something and no longer does: the relay addresses, the accounts and the administrators "+
		"live only here, and a truncated store opens without an error",
		"store", conf.Meet.Database, "newest copy", copies[0], "copies", len(copies))
}

// version says which build this is.
//
// There was no way to ask. A fleet is upgraded by re-enrolling each relay
// against a control node that serves its own running binary, so "which build is
// that machine on" is the first question of every upgrade and of every report
// that something behaves differently on one relay -- and the only answer
// available was to rebuild a commit and compare hashes, which needs the right
// commit guessed first.
//
// Read out of the build itself rather than stamped in by a linker flag, so it
// is right without anybody having to remember to pass one. A working tree with
// uncommitted changes says so, because a revision that names a commit the
// binary was not built from is worse than no revision.
func version() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown (built without module information)"
	}

	var revision, when string
	modified := false

	for _, setting := range info.Settings {
		switch setting.Key {
		case "vcs.revision":
			revision = setting.Value
		case "vcs.time":
			when = setting.Value
		case "vcs.modified":
			modified = setting.Value == "true"
		}
	}

	if revision == "" {
		return "unknown (built outside a repository)"
	}

	if len(revision) > 12 {
		revision = revision[:12]
	}

	if modified {
		revision += "+changes"
	}

	if when != "" {
		return revision + " " + when
	}

	return revision
}
