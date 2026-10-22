// What the store actually recorded about one room.
//
// The join response says where a client was sent and where the room is held,
// and when those disagree with what somebody expected, the question is which of
// the two is wrong. This reads the record itself.
//
// It answered one such question: a room opened on Hong Kong showed up as held
// on Guangzhou, which looked like the holder being overwritten by whoever
// joined last. It was not. A join that arrives while nobody is connected finds
// no meeting to confirm the note against, releases it, and the next person
// picks afresh — correct, and indistinguishable from the bug it resembles
// without reading the record between the two joins.
//
// Needs the service stopped, or a copy of the file: bolt admits one writer.
package main

import (
	"fmt"
	"os"

	"tomoshibi/internal/store"
)

func main() {
	kept, err := store.Open(os.Args[1])
	if err != nil {
		fmt.Println("open:", err)
		os.Exit(1)
	}
	defer kept.Close()

	name := os.Args[2]
	relay, placed := kept.HeldOn(name)
	fmt.Printf("HeldOn(%q) = relay=%q placed=%v\n", name, relay, placed)
	fmt.Printf("HostOf(%q) = %q\n", name, kept.HostOf(name))
}
