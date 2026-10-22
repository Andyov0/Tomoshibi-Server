package app

import (
	"net/http"

	"tomoshibi/internal/store"
)

/*
A music library, played into a call.

Somebody signed in may search a library this deployment has a gateway to and
play a track into the call as shared sound: losslessly where the track is
lossless, along the path the "share only sound" stream already takes. This file
is the door to the library. It admits signed-in accounts and passes their
requests on to the gateway with the token only this server holds; what the
gateway is and what it reaches is the deployment's business, and the client is
shown five paths and no address.

	sources   which libraries there are, and whether each is signed in
	search    tracks in one of them
	track     what a track's audio is: format, rate, bits, channels
	audio     the audio itself, streamed through, with Range
	link      a playlist or song link as somebody shared it, and its tracks

Signed in, because a library is somebody's subscription, and a path that let
anybody holding the address play from it would be giving that away. And given
the music permission, which every account holds unless somebody took it away:
who has an account on a deployment is a decision somebody made, and so, now, is
which of them may play from the library. Somebody without it still hears what
is played and may still ask for a song at a jukebox somebody else opened —
those travel through the call, as a guest's would.

The query is passed on as it came. The gateway is the party that knows what a
source or a quality is, and it refuses what it does not; reading the parameters
here as well would be two lists of the same thing kept in step by hand.
*/

var musicPaths = map[string]bool{"sources": true, "search": true, "track": true, "audio": true, "link": true}

func (a *App) music(w http.ResponseWriter, r *http.Request) {
	conf := a.conf.Meet.Music
	what := r.PathValue("what")

	// No library here, or no such path: the same answer as for any other path
	// this server does not have, so the client can tell "none" by asking.
	if conf.URL == "" || !musicPaths[what] {
		http.NotFound(w, r)
		return
	}

	if _, ok := a.may(w, r, store.PermMusic); !ok {
		return
	}

	passOn(w, r, gateway{
		name:   "music",
		url:    conf.URL,
		header: "X-Music-Token",
		token:  conf.Token,
		key:    "meet.music.token",
	}, what, what == "audio")
}
