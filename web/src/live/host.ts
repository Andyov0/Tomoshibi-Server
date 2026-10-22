import type { Participant, Room } from "livekit-client";
import { RoomEvent, Track } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { roster, tokenFor } from "./room";

/*
What the person running a meeting can do about it.

The powers are ordinary and the authorisation is the interesting part. There are
no sessions for people in a call — a join is stateless and deliberately so — and
sending a passphrase back with every mute would put a credential on the wire for
each press. The token this server signed is the answer: it names one room and one
identity, it cannot be edited, and the server that verifies it is the server that
signed it. So it goes in an Authorization header and nothing here has to hold
anything secret of its own.

None of this is deployment moderation, which lives behind the management pages
and can close any room on any relay. This is the smaller thing every meeting
needs: quiet a microphone somebody left open, remove somebody who will not leave,
and hand the room on when you go.
*/

/**
 * What this browser may do in this room.
 *
 * Two booleans about the reader, and deliberately nothing about anybody else.
 * There was a `host` here carrying the mark the room answers to, which the
 * server stopped sending for a reason it records at length: a mark is somebody's
 * identity in every room on this deployment, and handing it to everybody in the
 * call turns "be the host" into "send back the mark you were shown". The field
 * outlived the value by long enough that anything reading it would have got an
 * empty string rather than a type error.
 */
export interface Standing {
	/** Whether the person reading may act, one way or another. */
	yours: boolean;
	/** And whether by being an administrator, which is worth saying differently. */
	admin: boolean;
}

/**
 * The token this call was authorised with.
 *
 * Kept where the join put it. Not in local storage: a token is a credential for
 * one room for a few hours, and the tab that holds it is exactly as long as it
 * should outlive.
 */
function bearer(room: Room): string {
	// Ours, kept at the join. The SDK has its own copy and it is a private field:
	// private is a compiler's opinion rather than a runtime guarantee, so reading
	// it would work until a minified build renamed it, at which point every host
	// control would stop authorising with nothing anywhere saying why.
	return tokenFor(room);
}

/**
 * Whatever the server said, or a code that stands for it not having said.
 *
 * Every one of the calls below used to throw a fixed string and the panel
 * turned all of them into "That could not be done. Try again." — which for the
 * one that fails most, moving a meeting to a machine that cannot be reached, is
 * advice to try again until morning. The server has always distinguished these:
 * there are separate codes for a relay it does not know, a relay this person
 * may not have, and a media server that did not answer. They were being thrown
 * away one line before they would have been useful.
 */
async function refusal(response: Response, fallback: string): Promise<Error> {
	try {
		const body = (await response.json()) as { error?: unknown };
		if (typeof body.error === "string" && body.error) return new Error(body.error);
	} catch {
		// A refusal with no body, or one from something in front of the server.
	}

	return new Error(fallback);
}

async function ask(room: Room, path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`/api/rooms/${encodeURIComponent(room.name)}${path}`, {
		...init,
		headers: {
			...(init.headers ?? {}),
			"content-type": "application/json",
			Authorization: `Bearer ${bearer(room)}`,
		},
	});
}

/** Whether this browser runs this room, asked again whenever it might change. */
export function useStanding(room: Room): Standing {
	const [standing, setStanding] = useState<Standing>({ yours: false, admin: false });

	const refresh = useCallback(() => {
		void ask(room, "/host", { method: "GET" })
			.then((response) => (response.ok ? (response.json() as Promise<Standing>) : undefined))
			.then((said) => said && setStanding(said))
			.catch(() => {});
	}, [room]);

	useEffect(() => {
		refresh();

		// Somebody leaving is the ordinary reason a room changes hands, and the
		// connection changing state means this client may have missed whatever
		// happened while it was away.
		const events = [RoomEvent.ParticipantDisconnected, RoomEvent.ConnectionStateChanged];

		// And a handover, which is neither of those and used to be caught by
		// neither. The person giving a room away kept a panel full of controls
		// that had all begun answering 403, the person receiving it saw nothing
		// at all, and the two of them found out when an unrelated third person
		// left the call.
		//
		// Only from the server. Every participant may publish data, so a message
		// on this topic from one of them would be a way to make everybody else
		// re-ask — harmless in itself, since the answer comes from the server
		// either way, and refused anyway because the rule that a topic like this
		// is the server's should not have an exception nobody can see the edge
		// of. The media server stamps client packets with the identity it
		// authenticated and the library resolves it against the room, so a
		// participant's packet always arrives with one attached and the room
		// service's never does.
		const told = (_payload: Uint8Array, who: unknown, _kind: unknown, topic?: string) => {
			if (topic === "host" && who === undefined) refresh();
		};

		for (const event of events) room.on(event, refresh);
		room.on(RoomEvent.DataReceived, told);
		// removed

		return () => {
			for (const event of events) room.off(event, refresh);
			room.off(RoomEvent.DataReceived, told);
			room.off(RoomEvent.DataReceived, told);
		};
	}, [room, refresh]);

	return { ...standing, refresh } as Standing & { refresh: () => void };
}

/** Quieten somebody's microphone, from the server rather than by asking them. */
export async function silence(room: Room, person: Participant): Promise<void> {
	const microphone = person.getTrackPublication(Track.Source.Microphone);

	if (!microphone) return;

	const response = await ask(room, "/mute", {
		method: "POST",
		body: JSON.stringify({ identity: person.identity, track: microphone.trackSid }),
	});

	if (!response.ok) throw await refusal(response, "mute_failed");
}

/** Remove somebody from the room. */
export async function turnOut(room: Room, person: Participant): Promise<void> {
	const response = await ask(
		room,
		`/people/${encodeURIComponent(person.identity)}`,
		{ method: "DELETE" },
	);

	if (!response.ok) throw await refusal(response, "remove_failed");
}

/**
 * End the meeting for everybody.
 *
 * The one control that is not about a person. A host who leaves a room they
 * cannot close leaves a meeting that goes on without them, under a name they
 * will use again next week — and because a room here is a name, whoever stayed
 * is sitting in next week's meeting.
 */
export async function dissolve(room: Room): Promise<void> {
	const response = await ask(room, "/close", { method: "POST" });

	if (!response.ok) throw await refusal(response, "close_failed");
}

/**
 * Put the meeting on another machine, without ending it.
 *
 * Everybody is told the room is moving and then it is taken down; their clients
 * hear the first, treat the second as a move rather than an ending, and come
 * straight back to the machine chosen here.
 *
 * A relay reserved for administrators is refused by the server, not merely left
 * off the list offered here. A list is a courtesy and a check is a rule.
 */
export async function moveRoom(room: Room, relay: string): Promise<void> {
	const response = await ask(room, "/relay", {
		method: "PUT",
		body: JSON.stringify({ relay }),
	});

	if (!response.ok) throw await refusal(response, "move_failed");
}

/** Hand the room to somebody else. */
export async function handOver(room: Room, person: Participant): Promise<void> {
	const response = await ask(room, "/host", {
		method: "POST",
		body: JSON.stringify({ to: person.identity }),
	});

	if (!response.ok) throw await refusal(response, "handover_failed");
}

/**
 * A link that lets one person in, once, without a passphrase.
 *
 * Returned as a whole address rather than a token, because what somebody does
 * next is paste it. Built from the address bar rather than assembled from parts,
 * which is right until the first deployment behind a path or a different port.
 */
export async function invite(room: Room): Promise<string> {
	const response = await ask(room, "/invites", { method: "POST" });

	if (!response.ok) throw await refusal(response, "invite_failed");

	const made = (await response.json()) as { token: string };

	const url = new URL(window.location.href);
	url.search = `?invite=${encodeURIComponent(made.token)}`;
	url.hash = `#/${room.name}`;

	return url.toString();
}

/**
 * Stop every link to this room working, without ending the meeting.
 *
 * The other way a link dies is the room being closed, which is a far bigger
 * thing than anybody wants to do about a link pasted into the wrong window.
 */
export async function revoke(room: Room): Promise<number> {
	const response = await ask(room, "/invites", { method: "DELETE" });

	if (!response.ok) throw await refusal(response, "revoke_failed");

	// How many stopped working. The server has always answered with it and the
	// caller threw it away, so pressing the button told somebody nothing about
	// what they had just done — and the whole reason to press it is having lost
	// track of where a link went.
	const said = (await response.json().catch(() => ({}))) as { revoked?: number };

	return typeof said.revoked === "number" ? said.revoked : 0;
}

/** Everybody else in the call, for a list that acts on them. */
export function useOthers(room: Room): Participant[] {
	const [others, setOthers] = useState<Participant[]>([]);

	useEffect(() => {
		const gather = () =>
			setOthers(roster(room).filter((one) => one.identity !== room.localParticipant.identity));

		gather();

		const events = [
			RoomEvent.ParticipantConnected,
			RoomEvent.ParticipantDisconnected,
			RoomEvent.TrackMuted,
			RoomEvent.TrackUnmuted,
			RoomEvent.TrackPublished,
			RoomEvent.TrackUnpublished,
		];

		for (const event of events) room.on(event, gather);

		return () => {
			for (const event of events) room.off(event, gather);
		};
	}, [room]);

	return others;
}
