// Whether a name is what a network is filtering on.
//
// Some paths into this deployment refuse a relay by the name in the TLS
// handshake rather than by its address, its port, or anything in the traffic
// after it. That is a specific claim and it is easy to make loosely — "the
// domain is blocked" — when what is meant could be the address, the port, the
// route, or nothing at all. It is also easy to check, because SNI is chosen by
// the client and everything else can be held still: dial the same address on
// the same port, change only the name offered in the handshake, and see which
// handshakes finish.
//
// Two relays here are dialled by bare address for this reason, which costs them
// something real — a certificate for an address is short-lived where a wildcard
// is not, and no client that checks a name against what it dialled can use one.
// Whether that trade is worth making is a decision, and this is the measurement
// it should be made on rather than on a memory of something failing once.
//
// Repeats on purpose. The filtering measured here is intermittent: over six
// rounds one name was refused every time, another two thirds of the time, and
// an unused name never. A single attempt would have found any of those three
// answers and reported it as the whole truth.
//
//	go run ./dev/snicheck 203.0.113.25:39217 old.example.com new.example.com
//
// An empty name is written as "-", which offers no SNI at all and is what a
// client dialling a bare address does.
package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"time"
)

func main() {
	rounds := flag.Int("rounds", 6, "how many times to try each name")
	wait := flag.Duration("timeout", 8*time.Second, "how long one handshake may take")
	flag.Parse()

	if flag.NArg() < 2 {
		fmt.Fprintln(os.Stderr,
			"usage: snicheck [-rounds n] host:port name [name...]   (\"-\" means no name)")
		os.Exit(2)
	}

	address, names := flag.Arg(0), flag.Args()[1:]

	type tally struct {
		ok, refused int
		why         string
	}

	got := map[string]*tally{}
	for _, name := range names {
		got[name] = &tally{}
	}

	for range *rounds {
		for _, name := range names {
			server := name
			if name == "-" {
				server = ""
			}

			conn, err := tls.DialWithDialer(
				&net.Dialer{Timeout: *wait}, "tcp", address,
				// The certificate is not the question. Whether the handshake
				// completes at all is, and refusing here on a name mismatch
				// would report a filtered path and an unfiltered one with the
				// wrong certificate as the same answer.
				&tls.Config{ServerName: server, InsecureSkipVerify: true}, //nolint:gosec
			)

			if err != nil {
				got[name].refused++
				got[name].why = summarise(err)

				continue
			}

			got[name].ok++
			_ = conn.Close()
		}
	}

	fmt.Printf("%s, %d rounds each\n\n", address, *rounds)
	fmt.Printf("%-34s %-9s %s\n", "name offered", "finished", "how it failed")

	sort.Strings(names)
	for _, name := range names {
		shown := name
		if name == "-" {
			shown = "(none)"
		}

		fmt.Printf("%-34s %-9s %s\n", shown,
			fmt.Sprintf("%d/%d", got[name].ok, *rounds), got[name].why)
	}
}

// summarise keeps the part of an error that distinguishes one refusal from
// another. A reset is a middlebox; a timeout is a black hole; anything else is
// usually this end.
func summarise(err error) string {
	text := err.Error()

	switch {
	case strings.Contains(text, "reset by peer"):
		return "connection reset"
	case strings.Contains(text, "timeout"), strings.Contains(text, "deadline"):
		return "timed out"
	case strings.Contains(text, "EOF"):
		return "closed without answering"
	}

	if at := strings.LastIndex(text, ": "); at >= 0 {
		return text[at+2:]
	}

	return text
}
