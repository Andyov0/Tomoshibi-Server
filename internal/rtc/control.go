package rtc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Control asks the media server about its rooms, and occasionally tells it
// something.
//
// The media server already enforces every one of these against the grants in a
// token — a participant's token is refused here, which was checked rather than
// assumed. So nothing is reimplemented: a token carrying the administrative
// grants is minted for the length of one call and spent on the server's own
// API.
//
// That token never leaves this process. It can close any room on this
// deployment, and handing it to a browser would put it one cross-site script
// away from somebody who should not have it. The management pages call this
// server, and this server calls the media server.
type Control struct {
	client   *http.Client
	upstream string
	key      string
	secret   string
}

// Manage returns a client for the media server's own API.
func (s *Server) Manage(key, secret string) *Control {
	return &Control{
		// A short timeout: this is loopback, and a management page that hangs
		// is worse than one that says it could not find out.
		client:   &http.Client{Timeout: 5 * time.Second},
		upstream: s.upstream,
		key:      key,
		secret:   secret,
	}
}

// Each of these carries the grant its own method wants, and no more.
//
// The media server does not accept one key for everything, and the shapes are
// not what they look like: listing rooms wants the listing grant, closing one
// wants the grant for making them, and everything about a participant wants the
// administrative grant *named for a particular room*. A token holding all three
// with no room on it is refused by three of the five.
//
// Minted this narrowly on purpose as well as by necessity. A request to mute
// one person carries authority over exactly the room they are in, so a mistake
// in the code below cannot reach past it.
func (c *Control) Rooms(ctx context.Context) ([]*livekit.Room, error) {
	var out livekit.ListRoomsResponse
	grant := &auth.VideoGrant{RoomList: true}

	if err := c.call(ctx, "ListRooms", grant, &livekit.ListRoomsRequest{}, &out); err != nil {
		return nil, err
	}

	return out.GetRooms(), nil
}

// Participants lists who is in one room, and what each of them is sending.
func (c *Control) Participants(ctx context.Context, room string) ([]*livekit.ParticipantInfo, error) {
	var out livekit.ListParticipantsResponse
	grant := &auth.VideoGrant{RoomAdmin: true, Room: room}

	if err := c.call(ctx, "ListParticipants", grant, &livekit.ListParticipantsRequest{Room: room}, &out); err != nil {
		return nil, err
	}

	return out.GetParticipants(), nil
}

// Remove puts somebody out of a room. They may come back; this is not a ban,
// and there is nothing here that could be one.
func (c *Control) Remove(ctx context.Context, room, identity string) error {
	return c.call(ctx, "RemoveParticipant",
		&auth.VideoGrant{RoomAdmin: true, Room: room},
		&livekit.RoomParticipantIdentity{Room: room, Identity: identity},
		&livekit.RemoveParticipantResponse{})
}

// Mute silences one track. The person keeps their place and can turn it back
// on, which is the difference between this and removing them.
func (c *Control) Mute(ctx context.Context, room, identity, track string) error {
	return c.call(ctx, "MutePublishedTrack",
		&auth.VideoGrant{RoomAdmin: true, Room: room},
		&livekit.MuteRoomTrackRequest{Room: room, Identity: identity, TrackSid: track, Muted: true},
		&livekit.MuteRoomTrackResponse{})
}

// Close ends a room and disconnects everybody in it.
//
// Wants the grant for creating rooms rather than the one for administering
// them, which reads backwards until one notices that both are the power to
// decide a room exists.
func (c *Control) Close(ctx context.Context, room string) error {
	return c.call(ctx, "DeleteRoom",
		&auth.VideoGrant{RoomCreate: true},
		&livekit.DeleteRoomRequest{Room: room},
		&livekit.DeleteRoomResponse{})
}

// Hold creates a room on one named node, so that it is already there when
// people arrive.
//
// Rooms here are never created deliberately: the first person to connect makes
// one, on whichever node the media server's own selector picks for the machine
// they dialled. That is right for an ordinary meeting and it is why moving a
// room did not move it.
//
// A move closes the room and everybody reconnects, so the room is created
// afresh by whoever gets back first — on their entry's node, not on the one the
// operator chose. The record said the new machine and the meeting was wherever
// the race landed. An operator watching that would say the control does
// nothing, and for the thing they were trying to do it did nothing.
//
// Creating it first settles the race before it starts. Everybody who reconnects
// finds a room that already exists and joins it, wherever they came in.
func (c *Control) Hold(ctx context.Context, room, node string) error {
	return c.call(ctx, "CreateRoom",
		&auth.VideoGrant{RoomCreate: true},
		&livekit.CreateRoomRequest{Name: room, NodeId: node},
		&livekit.Room{})
}

// Announce sends one message to everybody in a room.
//
// Used to say that a room is about to be taken down and put up somewhere else,
// which is a thing a client cannot work out for itself: being disconnected
// because the meeting is over and being disconnected because it is moving look
// identical from the far end, and they want opposite answers — go back to the
// front, or come straight back in.
//
// Lossy, and told to be. A reliable message would be retried into a room that is
// about to stop existing, and the retry would outlive the thing it is about. One
// that does not arrive costs somebody a press on a button, which is what the
// whole fleet did before this existed.
func (c *Control) Announce(ctx context.Context, room, topic string, data []byte) error {
	return c.call(ctx, "SendData",
		&auth.VideoGrant{RoomAdmin: true, Room: room},
		&livekit.SendDataRequest{
			Room: room, Data: data, Kind: livekit.DataPacket_LOSSY, Topic: &topic,
		},
		&livekit.SendDataResponse{})
}

// Tell is Announce to one person rather than to the room.
//
// Addressed rather than broadcast and then filtered, because the two are not
// the same thing where the message is a warning that a call is about to end. A
// broadcast one arms every tab in the room to rejoin, and the next legitimate
// closure -- a host ending the meeting -- is then read by all of them as
// something to come back from. Filtering in the client leaves that arming in
// place and only hides it.
//
// Reliable, unlike Announce, because the reason Announce is lossy does not
// hold here: the room goes on, and a retry has somebody to arrive at until the
// moment they are let go of. Lossy, the warning to one person placed on another
// relay went missing on a phone twice in nine tries (Chrome on Android, against
// a local deployment, 2026-10-19), and that person landed on the join page
// reading "You were removed from this room" rather than coming back.
func (c *Control) Tell(ctx context.Context, room, identity, topic string, data []byte) error {
	return c.call(ctx, "SendData",
		&auth.VideoGrant{RoomAdmin: true, Room: room},
		&livekit.SendDataRequest{
			Room: room, Data: data, Kind: livekit.DataPacket_RELIABLE, Topic: &topic,
			DestinationIdentities: []string{identity},
		},
		&livekit.SendDataResponse{})
}

// call spends one token on one request.
//
// Minted per call and valid for a minute. A long-lived administrative token
// would have to be held somewhere, and the only thing holding it would buy is
// not doing this, which costs a signature.
func (c *Control) call(
	ctx context.Context,
	method string,
	grant *auth.VideoGrant,
	in, out proto.Message,
) error {
	token, err := auth.NewAccessToken(c.key, c.secret).
		SetIdentity("tomoshibi").
		SetVideoGrant(grant).
		SetValidFor(time.Minute).
		ToJWT()
	if err != nil {
		return fmt.Errorf("mint a token for %s: %w", method, err)
	}

	body, err := marshal(in)
	if err != nil {
		return fmt.Errorf("encode the request for %s: %w", method, err)
	}

	url := c.upstream + "/twirp/livekit.RoomService/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build the request for %s: %w", method, err)
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)

	response, err := c.client.Do(request)
	if err != nil {
		return fmt.Errorf("ask the media server to %s: %w", method, err)
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("read the answer to %s: %w", method, err)
	}

	if response.StatusCode != http.StatusOK {
		if missing(raw) {
			return ErrNoSuchRoom
		}

		return fmt.Errorf("%s was refused: %s", method, twirpReason(raw, response.StatusCode))
	}

	return unmarshal(raw, out)
}

// marshal and unmarshal go through protojson rather than the standard encoder.
//
// These are generated protocol messages, and their JSON names are not their Go
// field names. Encoded the ordinary way the request would be syntactically
// valid and semantically empty, which the media server would answer by doing
// nothing to a room called "".
func marshal(in proto.Message) ([]byte, error) {
	return protojson.Marshal(in)
}

func unmarshal(raw []byte, out proto.Message) error {
	// Unknown fields are the upstream having grown something this build does
	// not read yet, which is not a reason to refuse the rest of the answer.
	return protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(raw, out)
}

// ErrNoSuchRoom is a room that is not there.
//
// Distinguished from every other refusal because it is not a fault. A room
// exists while somebody is in it and stops existing when the last person
// leaves, so asking about one that has ended is the ordinary result of watching
// a page for a minute — and answering it the same way as a media server that
// has stopped responding would send somebody looking for a problem that is not
// there.
var ErrNoSuchRoom = errors.New("no such room")

// twirpReason pulls the sentence out of an error body, falling back to the
// status when there is nothing to pull.
// missing reads whether the refusal was a room that has ended.
func missing(raw []byte) bool {
	var body struct {
		Code    string `json:"code"`
		Message string `json:"msg"`
	}

	if err := json.Unmarshal(raw, &body); err != nil {
		return false
	}

	return body.Code == "not_found" || strings.Contains(body.Message, "does not exist")
}

func twirpReason(raw []byte, status int) string {
	var body struct {
		Code    string `json:"code"`
		Message string `json:"msg"`
	}

	if err := json.Unmarshal(raw, &body); err == nil && body.Message != "" {
		return body.Message
	}

	return fmt.Sprintf("HTTP %d", status)
}
