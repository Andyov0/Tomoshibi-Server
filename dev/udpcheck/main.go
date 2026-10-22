// Whether a relay's UDP answers, from wherever this is run.
//
// The control node checks relays by opening a TCP connection, which is the
// right check for the thing it decides — whether to offer a relay at all — and
// says nothing about the part that carries the call. Media is UDP, and UDP has
// no handshake: a port that is filtered and a port that is open both return
// silence. So silence has to be read against something that would have spoken,
// which is what the STUN probe port is for.
//
// Run it from more than one place, and expect the answers to differ. That is
// not noise; it is the measurement. This deployment has a relay whose UDP
// answers four times out of four from Singapore and zero times out of twelve
// from the control node — same port, same relay, same minute. The control node
// reaches the world through a NAT it shares with other machines, and that one
// path drops it. A fleet-wide conclusion drawn from one vantage point would
// have called that relay broken, and it is not: everybody who actually calls
// through it reaches it.
//
//	go run ./dev/udpcheck shct.example:39218 hk.example:39218
package main

import (
	"crypto/rand"
	"flag"
	"fmt"
	"net"
	"os"
	"time"
)

// binding is a STUN request, which is one packet and asks for one back.
func binding() []byte {
	packet := make([]byte, 20)

	// A binding request, and the magic cookie that tells STUN from anything
	// else that happens to arrive on the port.
	packet[0], packet[1] = 0x00, 0x01
	packet[4], packet[5], packet[6], packet[7] = 0x21, 0x12, 0xa4, 0x42
	_, _ = rand.Read(packet[8:])

	return packet
}

func main() {
	tries := flag.Int("tries", 4, "packets per address")
	wait := flag.Duration("wait", 2*time.Second, "how long to wait for each answer")
	flag.Parse()

	if flag.NArg() == 0 {
		fmt.Fprintln(os.Stderr, "usage: udpcheck [-tries n] host:port [host:port...]")
		os.Exit(2)
	}

	worst := 0

	for _, address := range flag.Args() {
		answered := 0

		for range *tries {
			answered += ask(address, *wait)
		}

		mark := "ok"
		if answered == 0 {
			mark = "SILENT"
			worst = 1
		} else if answered < *tries {
			mark = "lossy"
		}

		fmt.Printf("%-34s %-7s %d/%d\n", address, mark, answered, *tries)
	}

	// Non-zero when something answered nothing at all, so this can be the
	// condition in a script rather than something a person reads.
	os.Exit(worst)
}

// ask sends one request and says whether an answer came back.
func ask(address string, wait time.Duration) int {
	conn, err := net.DialTimeout("udp", address, wait)
	if err != nil {
		return 0
	}
	defer conn.Close()

	_ = conn.SetDeadline(time.Now().Add(wait))

	if _, err := conn.Write(binding()); err != nil {
		return 0
	}

	reply := make([]byte, 128)

	n, err := conn.Read(reply)
	if err != nil || n < 20 {
		return 0
	}

	// A binding response, rather than whatever else may arrive on a port that
	// something is listening to.
	if reply[0] != 0x01 || reply[1] != 0x01 {
		return 0
	}

	return 1
}
