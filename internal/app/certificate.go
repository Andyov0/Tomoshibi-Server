package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"time"

	"tomoshibi/internal/rtc"
)

/*
Keeping the fleet's certificate the same as the control node's.

The relays serve a wildcard the control node obtains, because the control node
is the only machine holding the credentials to obtain one. It reached them once,
in the package a machine is handed when it enrols, and after that nothing moved
it — so the renewal that arrives automatically every ninety days arrived only on
the machine that does not serve it, and eleven relays went on presenting a
certificate that would expire on a date nobody had written down.

This watches the file and hands out what it finds. It is deliberately dull: no
record of who holds what, no schedule tied to expiry, no retry queue. The far
end compares dates and keeps the newer one, so sending the same certificate
twice costs a request and changes nothing, and a relay that was unreachable this
hour is simply sent it again next hour. A renewal has about thirty days of
overlap; an hourly loop that forgets everything has seven hundred chances.
*/

// carryingEvery is how often the certificate on disk is looked at.
//
// The same hour as the sweeper and for a related reason: it is not chosen for
// timeliness — nothing here is urgent to the minute — but so that a deployment
// restarted nightly and one running for a year behave alike.
const carryingEvery = time.Hour

// How little is left on a certificate before it is worth saying so.
//
// Two days. The certificates this warns about renew every two, so anything
// under that is a renewal that did not happen rather than one that has not
// happened yet — and the ninety-day wildcard is thirty days from expiry when it
// renews, so it never comes near this.
const shortly = 48 * time.Hour

// carrying hands every relay the certificate this node serves, whenever it
// changes, and once at startup.
//
// Once at startup because a machine restarted often would otherwise never reach
// the first tick, and because a relay enrolled while an older certificate was
// current is behind from the moment it comes up.
func (a *App) carrying() {
	ticker := time.NewTicker(carryingEvery)
	defer ticker.Stop()

	var sent string

	for {
		if mark, ok := a.carry(sent); ok {
			sent = mark
		}

		select {
		case <-a.stop:
			return
		case <-ticker.C:
		}
	}
}

// carry reads the certificate and offers it to every relay, unless what is on
// disk is what was offered last time.
//
// The mark is of the content rather than of the file's timestamp, because
// acme.sh rewrites these files on a schedule of its own and most of those
// rewrites are the same bytes. A digest keeps the ordinary hour silent.
func (a *App) carry(last string) (string, bool) {
	if a.cluster == nil || a.conf.Meet.Enrol.Cert(a.conf.Meet.TLSCert) == "" {
		return "", false
	}

	certPath := a.conf.Meet.Enrol.Cert(a.conf.Meet.TLSCert)
	keyPath := a.conf.Meet.Enrol.Key(a.conf.Meet.TLSKey)

	cert, err := os.ReadFile(certPath)
	if err != nil {
		slog.Error("cannot read the certificate to give the relays", "path", certPath, "error", err)
		return "", false
	}

	key, err := os.ReadFile(keyPath)
	if err != nil {
		slog.Error("cannot read the key to give the relays", "path", keyPath, "error", err)
		return "", false
	}

	sum := sha256.Sum256(append(append([]byte(nil), cert...), key...))
	mark := hex.EncodeToString(sum[:])

	// The digest decides how loudly this hour is reported. It used to decide
	// whether the hour happened at all, and that was the whole watchdog undone:
	// everything below — reading back what each relay is actually serving, and
	// the warning about the ones this node cannot renew — sat behind a return
	// taken whenever the certificate had not changed. This node's certificate
	// changes about every ninety days. The relays it was meant to be watching
	// hold six-day certificates. A two-day warning window inside a ninety-day
	// check is not a window.
	//
	// Offering it again costs nothing: a relay handed the certificate it is
	// already serving keeps what it has and says so, without writing a file.
	renewed := mark != last

	carried := rtc.Certificate{Cert: string(cert), Key: string(key)}

	expires, err := carried.Expiry()
	if err != nil {
		slog.Error("the certificate on this node will not load, so it was not offered to the "+
			"relays", "path", certPath, "error", err)

		return "", false
	}

	relays, err := a.store.Relays()
	if err != nil {
		slog.Error("cannot list the relays to give them the certificate", "error", err)
		return "", false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var taken, refused int

	// Relays holding a certificate this node did not send, and when theirs runs
	// out. Said every round rather than only when it is nearly too late: a
	// watchdog whose only output is an alarm is one nobody can tell from a
	// watchdog that has stopped, and these are the machines whose certificate
	// depends on a cron job somewhere else.
	own := map[string]time.Time{}

	for _, relay := range relays {
		serving, err := a.cluster.SendCertificate(ctx, relay.URL, carried)
		if err != nil {
			// Not fatal and not retried here. The next hour offers it again,
			// and a certificate arrives with about thirty days to spare.
			slog.Warn("a relay would not take the certificate; it will be offered again",
				"relay", relay.Name, "error", err)

			refused++

			continue
		}

		taken++

		// What it is actually serving, which is not always what was sent.
		//
		// A relay may hold a certificate this node has no copy of and cannot
		// renew: two here have one for their own bare address, because the name
		// they used to answer to is filtered on the path that reaches them.
		// Those are six-day certificates renewed by a cron job on the machine
		// itself, and until now nothing anywhere would have noticed that job
		// stopping — the relay would have gone on answering perfectly until the
		// morning it did not.
		//
		// Warned about rather than fixed, because it cannot be fixed from here.
		// Two days is enough warning for a certificate that renews every two.
		if !serving.IsZero() && !serving.Equal(expires) {
			own[relay.Name] = serving
		}

		if !serving.IsZero() && time.Until(serving) < shortly {
			slog.Warn("a relay is serving a certificate that expires soon, and it is not one "+
				"this node can renew: look at the acme client on that machine",
				"relay", relay.Name, "expires", serving.Format(time.RFC3339),
				"in", time.Until(serving).Round(time.Hour).String())
		}
	}

	// Only the hour the certificate actually changed says so. The rest is the
	// round having happened, which matters to anybody wondering whether the
	// warnings above are absent or merely never looked for — and which is worth
	// a line at debug rather than an hourly one at info.
	if renewed {
		slog.Info("offered the renewed certificate to the relays",
			"expires", expires.Format(time.RFC3339), "answered", taken, "unreachable", refused)
	} else {
		slog.Debug("checked what the relays are serving",
			"expires", expires.Format(time.RFC3339), "answered", taken, "unreachable", refused)
	}

	// A round where nothing answered is not a quiet round. The certificate this
	// node holds is fine and every relay is unreachable from it, which is worth
	// hearing about at the hour it starts rather than at the expiry it ends in.
	if taken == 0 && refused > 0 {
		slog.Warn("no relay would take the certificate this hour, so nothing here knows what any "+
			"of them are serving", "unreachable", refused)
	}

	for name, when := range own {
		slog.Info("a relay is serving its own certificate, which this node cannot renew",
			"relay", name, "expires", when.Format(time.RFC3339),
			"in", time.Until(when).Round(time.Hour).String())
	}

	return mark, true
}
