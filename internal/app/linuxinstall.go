package app

import (
	_ "embed"
	"io"
	"net/http"
	"regexp"
	"strings"
)

/*
The Linux app installed with one command pasted into a terminal:

	curl -fsSL https://<deployment>/linux.sh | sh

For somebody who does not know whether their computer has an x86-64 or an ARM
processor, which the download page cannot tell them either (Chrome says x86_64
on every Linux machine, shelves.tsx), and who would otherwise download the
wrong one or give up choosing. The script (linux.sh beside this) checks that
the machine has a desktop before anything is downloaded, picks the build from
uname, checks the C library, takes the build from the same place the app
updates itself from (updates.go, latest), checks its size and SHA-256 against
the line, and puts it in the person's home folder with a launcher and the
desktop entry the app itself writes, so that its first start does not ask
whether to add it. It never runs sudo.

Public, like the relay's install script (admin.PublicInstall): what it serves
is a shell script and the address of this deployment, and the builds it
fetches are already given to anything that says it is the app. Served only
where the shelves are, since without them there is nothing for it to fetch.

The address written into it is this deployment's as the request reached it,
as the pages see their own: the scheme a trusted proxy says it terminated, and
the host it says it was asked for, or the request's own. A host is written in
only when it looks like a host. It is pasted into a script that is run, and a
Host header with a quote or a line break in it would otherwise be a command in
somebody's shell. The scheme is one of two words chosen here, never copied.
*/

//go:embed linux.sh
var linuxInstaller string

// A host and an optional port: a name, or an IPv6 address in brackets.
var installHost = regexp.MustCompile(`^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(:[0-9]{1,5})?$`)

func (a *App) linuxInstall(w http.ResponseWriter, r *http.Request) {
	if a.store == nil || a.apps == nil {
		fail(w, http.StatusNotFound, reasonNoBuild)
		return
	}

	base, ok := a.installBase(r)
	if !ok {
		fail(w, http.StatusBadRequest, reasonUnreadable)
		return
	}

	w.Header().Set("Content-Type", "text/x-shellscript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.WriteString(w, strings.ReplaceAll(linuxInstaller, "@BASE@", base))
}

// installBase is this deployment's address as the request reached it, or false
// where the host does not look like one.
func (a *App) installBase(r *http.Request) (string, bool) {
	scheme := "http"
	if r.TLS != nil || forwardedProto(r, a.conf.Meet.TrustProxy) == "https" {
		scheme = "https"
	}

	host := r.Host
	if a.conf.Meet.TrustProxy {
		// The last one, which the proxy nearest this server wrote; a proxy that
		// appends rather than replaces leaves whatever the caller sent first.
		if forwarded := r.Header.Get("X-Forwarded-Host"); forwarded != "" {
			parts := strings.Split(forwarded, ",")
			host = strings.TrimSpace(parts[len(parts)-1])
		}
	}

	if !installHost.MatchString(host) {
		return "", false
	}

	return scheme + "://" + host, true
}
