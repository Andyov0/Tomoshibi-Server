package config

import (
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"strings"
)

// Turnstile is Cloudflare's human check, asked for at the two sign-in doors: an
// account's, which the front page, the account page and the native apps all use,
// and the management pages'.
//
// Both keys come from one Turnstile widget in Cloudflare's dashboard. The site
// key is public by design and is handed to every page that draws the widget;
// the secret key is what this server sends to Cloudflare to ask whether a token
// a page handed over is genuine, and it is never written anywhere a page, a log
// or the management pages' runtime panel can read it. Like every other secret in
// this file it is a plain string, and kept off the runtime panel by that panel
// naming what it shows rather than by redacting what it does not.
//
// Unset, which is the default, neither door asks for anything and nothing else
// changes: a deployment somebody runs for themselves, and every test in this
// repository, signs in exactly as before.
type Turnstile struct {
	SiteKey   string `yaml:"site_key"`
	SecretKey string `yaml:"secret_key"`

	// Hostnames are the names the sign-in pages are served under, which is
	// where a token has to have been solved to be good here.
	//
	// Cloudflare says, beside every token it vouches for, the hostname of the
	// page the widget was drawn on. One widget can be allowed on several sites
	// at once — this deployment's shares one with another site of the owner's —
	// and a token solved on any of them is as genuine as one solved here; the
	// hostname is the only thing that tells them apart. Named here, the check
	// reads nothing the caller wrote. Left empty, the token's hostname is held
	// to the host the request itself names, read as the rest of this server
	// reads it (X-Forwarded-Host only under trust_proxy), which is right for a
	// browser and is a header a script chooses. So set it on any deployment
	// that shares its widget.
	Hostnames []string `yaml:"hostnames"`

	// ExemptNativeApps lets the native apps sign in to an account without a
	// token, and is on unless it is set to false.
	//
	// By the owner's decision the apps are never asked for a human check, for
	// any account, administrators included. A sign-in from an app is protected
	// instead by the sign-in lockout, which shuts an address and a device out
	// of both sign-ins for half an hour after more than ten failures in five
	// minutes, and by the guessing budget behind it; both count an app's
	// failures as they count a browser's. An app is recognised by its user
	// agent, which anything can send, so whatever sends it meets those two and
	// not the check. The management sign-in is never exempt, whatever this
	// says: the apps never call it, and nothing but a browser opens those
	// pages.
	ExemptNativeApps *bool `yaml:"exempt_native_apps"`

	// ExemptLocal lets a program on this machine sign in at either door
	// without a token, and is on unless it is set to false.
	//
	// For the tools on a control node that sign in at http://127.0.0.1:8080
	// with no browser — a health check, an operations script, a peek tool —
	// which the check would otherwise shut out. A request is such a program's
	// where its connection comes from a loopback address and it carries none
	// of X-Forwarded-For, X-Real-IP and Forwarded, with any value or none
	// (turnstile.FromThisMachine). Only the check is spared; the lockout, the
	// request limit, the guessing budget and the passphrase still apply.
	//
	// A proxy in front of this server MUST always set X-Forwarded-For or
	// X-Real-IP, on every request it passes on. A proxy on the same machine
	// connects from loopback too, and one that sent neither header would have
	// every caller it passes on spared the check. nginx's proxy_set_header
	// X-Forwarded-For $proxy_add_x_forwarded_for, as the example sets, always
	// does.
	//
	// Nothing at startup can see a proxy get this wrong, and a review found
	// the two ways it is easiest to. In nginx, a location that sets any
	// proxy_set_header of its own inherits none from the server block, and a
	// location with proxy_pass alone sends none, so each location passing to
	// this server has to set the header itself. And anything that forwards
	// below HTTP — HAProxy in mode tcp, socat, frp, a port forward in
	// sing-box or xray, ssh -L or -R, DNAT with route_localnet — cannot add a
	// header at all. Through either, a stand-in for a browser outside signed
	// in at both doors with no token, the management door included, and every
	// such caller was counted as 127.0.0.1, so eleven failures through it
	// shut out the tools on the machine that use the same user agent. Where
	// either is needed, this is to be false.
	//
	// Requiring the request's Host to be a loopback name as well was
	// considered, which would stop a forward below HTTP, since that passes on
	// the Host the browser sent. It was not taken: it does nothing for the
	// nginx location that sends no header, which keeps a loopback Host, and a
	// tool that names the public host to this server would lose the
	// exemption it was given.
	ExemptLocal *bool `yaml:"exempt_local"`
}

// Configured reports whether the human check is asked for at all.
func (t Turnstile) Configured() bool {
	return t.SiteKey != "" && t.SecretKey != ""
}

// ExemptsNativeApps reports whether the account door lets the apps through
// without a token. On unless the file turned it off, since the owner decided
// the apps are never asked for one, and turning the check on for them by
// omission would sign every one of them out.
func (t Turnstile) ExemptsNativeApps() bool {
	return t.ExemptNativeApps == nil || *t.ExemptNativeApps
}

// ExemptsLocal reports whether a program on this machine signs in without a
// token. On unless the file turned it off, since the tools on a control node
// that sign in with no browser would otherwise be shut out by turning the
// check on.
func (t Turnstile) ExemptsLocal() bool {
	return t.ExemptLocal == nil || *t.ExemptLocal
}

// testingSecrets are the secret keys Cloudflare publishes for testing, which
// answer the same way whatever token they are asked about. A deployment
// configured with one is a deployment whose human check checks nothing, which
// is worth saying on every start.
var testingSecrets = []string{
	"1x0000000000000000000000000000000AA",
	"2x0000000000000000000000000000000AA",
	"3x0000000000000000000000000000000AA",
}

// checkTurnstile refuses a human check that cannot work, and writes the
// hostnames the way they will be compared.
//
// Half a widget is refused rather than let through as off. Somebody who wrote
// down one key meant the doors to ask for a check, and a deployment that quietly
// asked for none would read, to them, as one that does. A site key pasted into
// both places is the commonest way to get there and is said separately, since a
// secret that is the public key refuses every token with a reason nobody would
// connect to the file.
func checkTurnstile(meet *Meet) error {
	// Ignored on a relay, which has no sign-in to put it in front of, for the
	// reason the apps section is: relays are often made from one file.
	if meet.Role == RoleRelay {
		return nil
	}

	human := &meet.Turnstile
	human.SiteKey = strings.TrimSpace(human.SiteKey)
	human.SecretKey = strings.TrimSpace(human.SecretKey)

	const wayOut = "or remove meet.turnstile to sign in without one"

	switch {
	case human.SiteKey == "" && human.SecretKey == "":
		if len(human.Hostnames) > 0 || human.ExemptNativeApps != nil || human.ExemptLocal != nil {
			slog.Warn("meet.turnstile names hostnames or an exemption but no keys, so " +
				"neither sign-in asks for a human check")
		}

		return nil
	case human.SiteKey == "":
		return fmt.Errorf("meet.turnstile.secret_key is set and meet.turnstile.site_key is not; "+
			"the page needs the site key to draw the widget, so copy it from the same widget "+
			"in Cloudflare's dashboard, %s", wayOut)
	case human.SecretKey == "":
		return fmt.Errorf("meet.turnstile.site_key is set and meet.turnstile.secret_key is not; "+
			"this server needs the secret key to ask Cloudflare whether a token is genuine, so "+
			"copy it from the same widget in Cloudflare's dashboard, %s", wayOut)
	case human.SiteKey == human.SecretKey:
		return fmt.Errorf("meet.turnstile.site_key and meet.turnstile.secret_key are the same; "+
			"Cloudflare shows a widget's two keys one above the other, and the secret is the "+
			"second, %s", wayOut)
	}

	for i, name := range human.Hostnames {
		bare, ok := Hostname(name)
		if !ok {
			return fmt.Errorf("meet.turnstile.hostnames[%d]: %q is not a hostname. Each is the name "+
				"a sign-in page is served under, as the address bar shows it without the scheme, "+
				"port or path, such as meet.example.com; correct it, or remove hostnames to hold a "+
				"token to the host each request names", i, name)
		}

		human.Hostnames[i] = bare
	}

	for _, testing := range testingSecrets {
		if human.SecretKey == testing {
			// The hostname is said too, because it is the first thing anybody
			// trying the testing keys runs into: the always-pass secret reports
			// every token as solved on example.com, and a sign-in on any other
			// name is refused for it, which reads as the keys not working.
			slog.Warn("meet.turnstile.secret_key is one of the keys Cloudflare publishes for " +
				"testing, which answers the same whatever a page sends, so the sign-in's human " +
				"check checks nothing. Use the secret key of a real widget. Cloudflare reports " +
				"every token it passes under this key as solved on example.com, so a sign-in is " +
				"refused unless meet.turnstile.hostnames names example.com or the page was reached " +
				"under that name")
		}
	}

	if len(human.Hostnames) == 0 {
		slog.Warn("meet.turnstile.hostnames is empty, so a token is held to the host each request " +
			"names, which a script writes for itself; name the hostnames the sign-in pages are " +
			"served under to hold it to those")
	}

	// Said rather than refused, because it is not wrong. Behind a proxy, the
	// local exemption rests on the proxy always writing a forwarding header;
	// a server that also takes connections on another address is reached
	// there by callers whose peer is not loopback, and those are asked for a
	// token whatever they send. Worth a line at start all the same, so that
	// whoever reads it knows which callers are spared and what the proxy must
	// do for that to stay true.
	if meet.TrustProxy && human.ExemptsLocal() && !loopbackOnly(meet.Listen) {
		slog.Warn("meet.turnstile.exempt_local spares the human check for a program on this machine "+
			"that connects over loopback and sends none of X-Forwarded-For, X-Real-IP and Forwarded. "+
			"This server also listens on addresses that are not loopback; a caller reaching it there "+
			"directly is not on loopback and is still asked for a token. The proxy in front must "+
			"always set X-Forwarded-For or X-Real-IP, or every caller it passes on is spared",
			"listen", meet.Listen)
	}

	return nil
}

// loopbackOnly is whether a listen address takes connections on loopback and
// nowhere else. An empty host is every address, and a name other than
// localhost may resolve anywhere, so neither is.
func loopbackOnly(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	if err != nil {
		host = listen
	}

	if strings.EqualFold(host, "localhost") {
		return true
	}

	addr, err := netip.ParseAddr(strings.Trim(host, "[]"))
	return err == nil && addr.IsLoopback()
}

// Hostname is a name written the way a hostname is compared here: in lower
// case, without the trailing dot a fully qualified name may carry, and only
// where it is a bare name or address with nothing else around it. False for
// anything with a scheme, a port, a path or a space in it.
//
// Exported because the human check compares the hostname Cloudflare reports
// against a request's host, and the two have to be written the same way for
// the comparison to mean anything.
func Hostname(name string) (string, bool) {
	bare := strings.TrimSuffix(strings.ToLower(strings.TrimSpace(name)), ".")
	if bare == "" || strings.ContainsAny(bare, "/:@ ?#[]\\") {
		// An IPv6 address carries colons and is the one bare name that may.
		if ip := net.ParseIP(strings.Trim(bare, "[]")); ip != nil && ip.To4() == nil {
			return ip.String(), true
		}

		return "", false
	}

	return bare, true
}
