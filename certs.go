package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"
)

/*
A certificate that can be replaced without stopping the server.

ServeTLS reads the certificate and key once, when it is called, and holds what
it read for the life of the process. That is fine for a server somebody restarts
freely and wrong for this one: a restart drops every call in progress, and the
certificate here is renewed automatically every ninety days on a fleet of eleven
machines. Left as it was, keeping the fleet dialable meant dropping every
meeting on it four times a year, at a time chosen by a cron job.

So the certificate is read through a callback instead, and the callback notices
when the file underneath it has changed. Renewal becomes a file copy: the next
handshake picks up the new certificate and the calls already up are not touched,
because a TLS certificate is presented when a connection is opened and never
consulted again for the life of that connection.

Checked by modification time and size rather than by content, which is enough to
notice a replacement and cheap enough to do on a handshake. A certificate that
is rewritten byte-identically does not need to be noticed.
*/

// keypair holds a certificate and reloads it when the files change.
type keypair struct {
	certPath string
	keyPath  string

	mu   sync.RWMutex
	held *tls.Certificate
	// What the files looked like when held was loaded.
	stamp string
}

// newKeypair loads the certificate once, so that a bad path or a key that does
// not match its certificate is a message at startup rather than a handshake
// that fails later for reasons nobody can see from the outside.
func newKeypair(certPath, keyPath string) (*keypair, error) {
	pair := &keypair{certPath: certPath, keyPath: keyPath}

	if err := pair.reload(); err != nil {
		return nil, err
	}

	return pair, nil
}

// mark describes the files, well enough to tell a replacement from the same one.
func (k *keypair) mark() string {
	cert, err := os.Stat(k.certPath)
	if err != nil {
		return ""
	}

	key, err := os.Stat(k.keyPath)
	if err != nil {
		return ""
	}

	return fmt.Sprintf("%d:%d:%d:%d",
		cert.ModTime().UnixNano(), cert.Size(), key.ModTime().UnixNano(), key.Size())
}

func (k *keypair) reload() error {
	stamp := k.mark()

	loaded, err := tls.LoadX509KeyPair(k.certPath, k.keyPath)
	if err != nil {
		return fmt.Errorf("load the certificate from %s: %w", k.certPath, err)
	}

	k.mu.Lock()
	defer k.mu.Unlock()

	k.held = &loaded
	k.stamp = stamp

	return nil
}

// certificate is what the TLS stack asks for on every handshake.
//
// A failed reload keeps the certificate already held rather than failing the
// handshake. Half-written files exist — a copy in progress is one — and the old
// certificate is valid for another thirty days at the moment the new one
// arrives, so serving it for a few seconds longer costs nothing, while refusing
// connections costs the calls.
func (k *keypair) certificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	k.mu.RLock()
	held, stamp := k.held, k.stamp
	k.mu.RUnlock()

	now := k.mark()
	if now == stamp || now == "" {
		return held, nil
	}

	if err := k.reload(); err != nil {
		slog.Error("the certificate on disk changed and could not be loaded; "+
			"serving the one already held", "cert", k.certPath, "error", err)

		// Remembered as seen, so a file that stays broken is reported once
		// rather than on every handshake.
		k.mu.Lock()
		k.stamp = now
		k.mu.Unlock()

		return held, nil
	}

	k.mu.RLock()
	defer k.mu.RUnlock()

	if k.held != nil && len(k.held.Certificate) > 0 {
		if parsed, err := leafOf(k.held); err == nil {
			slog.Info("loaded a renewed certificate without restarting",
				"cert", k.certPath, "expires", parsed.NotAfter.Format(time.RFC3339))
		}
	}

	return k.held, nil
}

// leafOf parses the certificate being served, for the expiry in the log line.
func leafOf(cert *tls.Certificate) (*x509.Certificate, error) {
	if cert.Leaf != nil {
		return cert.Leaf, nil
	}

	return x509.ParseCertificate(cert.Certificate[0])
}
