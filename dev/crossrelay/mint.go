package main

import (
	"fmt"
	"os"
	"time"

	"github.com/livekit/protocol/auth"
)

// A join token for one room and one identity, signed with the deployment's own
// key.
//
// What the join endpoint would have produced minus everything it decides: no
// relay chosen, no forwarding credentials, no record of who holds the room. For
// connecting a browser straight at a relay to see what happens without any of
// that — see the README, which is mostly about not mistaking the answer for how
// the product behaves.
func main() {
	key, secret, room, identity := os.Args[1], os.Args[2], os.Args[3], os.Args[4]

	yes := true
	token, err := auth.NewAccessToken(key, secret).
		SetIdentity(identity).
		SetName(identity).
		SetVideoGrant(&auth.VideoGrant{
			Room: room, RoomJoin: true,
			CanPublish: &yes, CanSubscribe: &yes,
		}).
		SetValidFor(30 * time.Minute).
		ToJWT()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	fmt.Println(token)
}
