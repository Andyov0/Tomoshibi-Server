package rtc

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

/*
Handing a relay its renewed certificate.

The certificate every relay serves is a wildcard issued on the control node,
which is the only machine with the credentials to obtain one. Until now it
reached the relays exactly once, in the package a machine is given when it
enrols, and never again — so ninety days later every relay in the fleet was
serving something expired on the same afternoon, and the only remedy was to
re-enrol eleven machines by hand.

Pushed rather than pulled, and that decision is about what already exists. The
control node holds every relay's address and already dials each of them for
their counters; a relay knows nothing about where it enrolled from and would
need to be told, on eleven machines, before it could ask for anything. Pushing
adds an endpoint. Pulling would have added an endpoint, a configuration field,
and a visit to every machine to set it.

What guards this is the deployment secret, which is the same thing that guards
the counters beside it and is already shared with every relay — an enrolment
hands over the secret and the certificate together. It is worth being plain
about what that means: somebody holding the secret can replace what a relay
serves. They could already mint tokens for any room on the deployment, so this
is not a new door into the calls, but it is a new thing to do with the key.
*/

// CertificatePath is where a relay accepts a renewed certificate.
//
// Under /twirp/ with the rest, so that a network which decides what a port is
// by asking it sees one shape of traffic rather than two.
const CertificatePath = "/twirp/relay.certificate"

// Certificate is a keypair in flight.
type Certificate struct {
	Cert string `json:"cert"`
	Key  string `json:"key"`
}

// Expiry is when the certificate stops being good, and an error if the pair is
// not a pair at all.
func (c Certificate) Expiry() (time.Time, error) {
	pair, err := tls.X509KeyPair([]byte(c.Cert), []byte(c.Key))
	if err != nil {
		return time.Time{}, fmt.Errorf("the certificate and key are not a pair: %w", err)
	}

	leaf := pair.Leaf
	if leaf == nil {
		leaf, err = x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return time.Time{}, err
		}
	}

	return leaf.NotAfter, nil
}

// CertificateHandler accepts a renewed certificate and writes it where this
// relay serves from.
//
// It refuses one that expires no later than what is already on disk. A renewal
// only ever moves forward, so anything else is either a mistake or somebody
// replaying an old certificate to bring a relay down on a schedule of their
// choosing — and the check costs one file read.
func CertificateHandler(certPath, keyPath, key, secret string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !authorised(r, key, secret) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}

		var sent Certificate
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&sent); err != nil {
			http.Error(w, "unreadable", http.StatusBadRequest)
			return
		}

		expires, err := sent.Expiry()
		if err != nil {
			slog.Warn("refused a certificate that will not load", "error", err)
			http.Error(w, "not a keypair", http.StatusBadRequest)

			return
		}

		// What is served here now, if anything, and whether the offer is an
		// improvement on it.
		held, err := leafOfFile(certPath)
		if err == nil {
			if kept, why := keeping(held, sent); kept {
				// Not an error. The control node pushes to everybody and does
				// not track who has what, so being told about a certificate
				// already held is the ordinary case rather than a fault.
				w.WriteHeader(http.StatusOK)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"kept": true, "expires": held.NotAfter, "why": why,
				})

				return
			}
		}

		if err := writeBeside(certPath, []byte(sent.Cert), 0o644); err != nil {
			slog.Error("failed to write a renewed certificate", "path", certPath, "error", err)
			http.Error(w, "unwritable", http.StatusInternalServerError)

			return
		}

		// Group-readable, which is not a relaxation. A relay runs under
		// DynamicUser, so the account it runs as is a different one every
		// start, and a key written 0600 by one of them is a key the next
		// cannot read — a relay that takes a certificate happily and then
		// refuses to come back from its next restart. What stays constant is
		// the group the unit names, and the directory carries setgid so a file
		// written here joins it.
		if err := writeBeside(keyPath, []byte(sent.Key), 0o640); err != nil {
			slog.Error("failed to write a renewed key", "path", keyPath, "error", err)
			http.Error(w, "unwritable", http.StatusInternalServerError)

			return
		}

		slog.Info("took a renewed certificate; it will be served on the next handshake "+
			"without restarting", "expires", expires.Format(time.RFC3339))

		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]any{"taken": true, "expires": expires})
	})
}

// leafOfFile reads the certificate being served.
//
// Only the certificate, which is all that carries a date or a name. Reading the
// key as well would make this fail whenever the two are mid-replacement.
func leafOfFile(path string) (*x509.Certificate, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	return leafOf(raw)
}

// keeping says whether what is served stays, and why.
//
// Two rules, and the second exists because the first one alone did real damage.
//
// A renewal never moves the expiry backwards, which is what stops somebody
// replaying an old certificate to choose the hour a relay goes quiet, and what
// makes an hourly push to everybody safe when most of them already hold it.
//
// And a renewal never narrows what the certificate is for. That was missing,
// and the control node's wildcard duly replaced the short-lived certificate two
// relays hold for their own bare addresses — issued by those machines
// themselves, renewed by their own cron, and expiring sooner than a ninety-day
// wildcard precisely because it is short-lived. The rule "later expiry wins"
// read that as a renewal. Both machines went on answering, with a certificate
// naming a domain nobody dials them by, and every client that checks the name
// against the address it dialled stopped being able to reach them.
//
// So a certificate that does not cover everything the current one covers is
// refused, whatever its date. There is no case where a relay wants to be able
// to answer to fewer addresses than it does now.
func keeping(held *x509.Certificate, offered Certificate) (bool, string) {
	fresh, err := leafOf([]byte(offered.Cert))
	if err != nil {
		return true, "the offer could not be read"
	}

	for _, name := range held.DNSNames {
		if fresh.VerifyHostname(name) != nil {
			return true, "the offer does not answer to " + name
		}
	}

	for _, ip := range held.IPAddresses {
		if fresh.VerifyHostname(ip.String()) != nil {
			return true, "the offer does not answer to " + ip.String()
		}
	}

	if !fresh.NotAfter.After(held.NotAfter) {
		return true, "the offer expires no later than what is held"
	}

	return false, ""
}

// leafOf parses the first certificate out of a PEM chain.
func leafOf(chain []byte) (*x509.Certificate, error) {
	for {
		block, rest := pem.Decode(chain)
		if block == nil {
			return nil, errors.New("no certificate in the file")
		}

		if block.Type == "CERTIFICATE" {
			return x509.ParseCertificate(block.Bytes)
		}

		chain = rest
	}
}

// writeBeside writes a file by replacing it, never by truncating it.
//
// A certificate written in place is readable half-written, and the thing
// reading it is a TLS handshake on a machine carrying calls. Written to a
// neighbour and renamed, a reader sees either the old file or the new one.
func writeBeside(path string, content []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)

	temporary, err := os.CreateTemp(dir, filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	defer os.Remove(temporary.Name())

	// Chmod rather than a mode on creation, because CreateTemp makes the file
	// 0600 and the group bit is the part that matters here. The group itself is
	// inherited from the directory, which is setgid for that reason.
	if err := temporary.Chmod(mode); err != nil {
		temporary.Close()
		return err
	}

	if _, err := temporary.Write(content); err != nil {
		temporary.Close()
		return err
	}

	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}

	if err := temporary.Close(); err != nil {
		return err
	}

	return os.Rename(temporary.Name(), path)
}
