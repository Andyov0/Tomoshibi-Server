import type { Participant, Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { useCallback, useEffect, useState } from "react";
import { roster } from "./room";

/*
Two things people do in a meeting without interrupting it.

They are not the same thing and are not sent the same way, which is the whole
of the design here.

A raised hand is a *state*. It is true until the person lowers it, it has to be
visible to somebody who joins ten minutes later, and it has to go away by
itself when that person's browser is closed rather than left. That is an
attribute: it travels with the roster, it needs no heartbeat and nothing to
expire it, and it disappears with the participant who set it. The same
reasoning as `watching`, for the same reasons.

A reaction is an *event*. It happened, it is seen, and it is gone — nobody
joining afterwards should see a thumbs-up from before they arrived, and
somebody who reacts twice has reacted twice rather than having a reaction that
is still true. Sent as data, which is the shape of a thing that happened.

Getting these the wrong way round is a real mistake rather than a stylistic
one. A hand sent as an event is invisible to late arrivals and has to be
re-announced on a timer; a reaction held as state is a thumbs-up stuck to
somebody's tile for the rest of the call.
*/

/** The attribute a raised hand is kept in. Short: it goes with every roster. */
const RAISED = "hand";

/** The data topic reactions travel on. */
const REACTION = "reaction";

/**
 * The reactions this deployment offers.
 *
 * A short list rather than a picker. Every one of these is legible at the size
 * of a tile badge and means the same thing everywhere it is read; an open
 * emoji field is a way to put anything at all on somebody else's screen.
 */
export const REACTIONS = ["👍", "👏", "😂", "🎉", "❤️", "😮"] as const;

export type Reaction = (typeof REACTIONS)[number];

/** How long a reaction stays on screen. */
export const REACTION_FOR = 4000;

/** One reaction, as the interface holds it. */
export interface Reacted {
	id: string;
	/** Whose it is, as the identity their token was signed with. */
	from: string;
	what: Reaction;
	at: number;
}

/**
 * Whose hands are up, and how to put yours up or down.
 *
 * Read off the roster rather than accumulated from messages, so it is correct
 * for somebody who has just arrived and correct again after a reconnect,
 * without either being a special case.
 */
export function useHands(room: Room | undefined) {
	const [raised, setRaised] = useState<string[]>([]);

	useEffect(() => {
		if (!room) return;

		const read = () => {
			const up = roster(room)
				.filter((one) => one.attributes?.[RAISED] === "up")
				.map((one) => one.identity);

			// Compared before it is set, because this runs on every roster event
			// in a call and a new array every time is a re-render of every tile.
			setRaised((was) =>
				was.length === up.length && was.every((who, at) => who === up[at]) ? was : up,
			);
		};

		read();

		room.on(RoomEvent.ParticipantAttributesChanged, read);
		room.on(RoomEvent.ParticipantConnected, read);
		room.on(RoomEvent.ParticipantDisconnected, read);

		return () => {
			room.off(RoomEvent.ParticipantAttributesChanged, read);
			room.off(RoomEvent.ParticipantConnected, read);
			room.off(RoomEvent.ParticipantDisconnected, read);
		};
	}, [room]);

	const raise = useCallback(
		(up: boolean) => {
			if (!room) return;

			// Only when it changes: an attribute is broadcast to everybody, and
			// writing the same value again is a message to the whole room saying
			// nothing.
			const already = room.localParticipant.attributes?.[RAISED] === "up";
			if (already === up) return;

			void room.localParticipant.setAttributes({ [RAISED]: up ? "up" : "" }).catch(() => {});
		},
		[room],
	);

	const mine = room ? raised.includes(room.localParticipant.identity) : false;

	return { raised, mine, raise };
}

/**
 * Reactions, arriving and leaving.
 *
 * Each is dropped after REACTION_FOR by the timer that put it there rather than
 * by a sweep over the list: the list is short, the lifetime is fixed, and a
 * sweep would be a second thing to keep correct.
 */
export function useReactions(room: Room | undefined) {
	const [shown, setShown] = useState<Reacted[]>([]);

	useEffect(() => {
		if (!room) return;

		const timers: number[] = [];

		const onData = (payload: Uint8Array, from?: Participant, _kind?: unknown, topic?: string) => {
			if (topic !== REACTION || !from) return;

			let what: string;
			try {
				what = new TextDecoder().decode(payload);
			} catch {
				return;
			}

			// Checked against the list rather than shown as it arrived. What is
			// on the wire is whatever the far end sent, and a tile is not a place
			// to render arbitrary text from somebody else's browser.
			if (!(REACTIONS as readonly string[]).includes(what)) return;

			const one: Reacted = {
				id: `${from.identity}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				from: from.identity,
				what: what as Reaction,
				at: Date.now(),
			};

			setShown((was) => [...was, one]);

			timers.push(
				window.setTimeout(() => {
					setShown((was) => was.filter((each) => each.id !== one.id));
				}, REACTION_FOR),
			);
		};

		room.on(RoomEvent.DataReceived, onData);

		return () => {
			room.off(RoomEvent.DataReceived, onData);
			for (const timer of timers) window.clearTimeout(timer);
		};
	}, [room]);

	const react = useCallback(
		(what: Reaction) => {
			if (!room) return;

			const payload = new TextEncoder().encode(what);

			// Data does not come back to the browser that sent it, so the
			// person reacting is shown their own straight away rather than
			// waiting for a round trip that will never arrive.
			void room.localParticipant
				.publishData(payload, { reliable: true, topic: REACTION })
				.catch(() => {});

			const one: Reacted = {
				id: `me-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
				from: room.localParticipant.identity,
				what,
				at: Date.now(),
			};

			setShown((was) => [...was, one]);
			window.setTimeout(() => {
				setShown((was) => was.filter((each) => each.id !== one.id));
			}, REACTION_FOR);
		},
		[room],
	);

	return { shown, react };
}
