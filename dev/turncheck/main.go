// Whether a relay will actually allocate for us, from outside.
//
// The unit tests prove the credential format is one the relay's own auth
// handler accepts. They cannot prove the packets arrive: a security group, a
// host firewall, or a relay port range nobody opened all look exactly like a
// working configuration from here, and exactly like a call that never connects
// from a browser.
package main

import (
	"fmt"
	"net"
	"os"
	"time"

	"github.com/pion/turn/v5"
	"tomoshibi/internal/rtc"
)

func main() {
	if len(os.Args) < 4 {
		fmt.Println("usage: turncheck host:port key secret [peer:port | -self]")
		fmt.Println("  no fourth argument: whether an allocation is granted at all")
		fmt.Println("  -self:              whether anything sent to the allocation arrives,")
		fmt.Println("                      answered without needing a second machine")
		fmt.Println("  peer:port:          the same, waiting for that peer to send")
		os.Exit(2)
	}

	address, key, secret := os.Args[1], os.Args[2], os.Args[3]

	// Four arguments means the harder question: not whether an allocation is
	// granted, but whether anything sent to it comes out the other side.
	if len(os.Args) > 4 {
		if os.Args[4] == "-self" {
			// Sends to its own allocation, so silence means the range is not
			// carrying rather than that nobody spoke. The other form cannot
			// tell those apart and has been read as if it could.
			through(address, key, secret, 40000)
			return
		}

		relayThrough(address, key, secret, os.Args[4])

		return
	}

	forward, err := rtc.Forward(address, key, secret)
	if err != nil {
		fmt.Println("mint:", err)
		os.Exit(1)
	}

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: address,
		TURNServerAddr: address,
		Conn:           conn,
		Username:       forward.Username,
		Password:       forward.Credential,
		Realm:          "livekit",
	})
	if err != nil {
		fmt.Println("client:", err)
		os.Exit(1)
	}
	defer client.Close()

	if err := client.Listen(); err != nil {
		fmt.Println("listen:", err)
		os.Exit(1)
	}

	started := time.Now()

	relayed, err := client.Allocate()
	if err != nil {
		fmt.Printf("REFUSED %s: %v\n", address, err)
		os.Exit(1)
	}
	defer relayed.Close()

	fmt.Printf("OK %s -> relays at %s in %dms\n",
		address, relayed.LocalAddr(), time.Since(started).Milliseconds())
}
