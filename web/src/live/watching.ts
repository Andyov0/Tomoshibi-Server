import type { Participant, Room } from "livekit-client";
import { RoomEvent } from "livekit-client";
import { useEffect, useState } from "react";
import { roster } from "./room";

/*
Who is looking at a screen share.

The media server tells a publisher nothing about who has subscribed to their
track. That is reasonable — a track is published once and fanned out, and the
publisher's connection is the same whether one person is watching or twelve —
and it means the only way somebody sharing their screen can be shown who is
looking is for the people looking to say so.

Said as an attribute rather than as a message, which matters for three reasons.
It is state, so there is no heartbeat to keep up and nothing to expire; it
arrives with the roster, so somebody who joins mid-share sees the list already
filled in rather than waiting for the next round of announcements; and it goes
away with the participant who set it, so a browser that was closed rather than
left does not linger in the list. A data message with a timeout behind it fails
every one of those, and fails them quietly.

What it is not is proof. Somebody can have the picture on screen and be looking
out of the window, and somebody who paged away is no longer sending it. It says
whose screen is on whose screen, which is the question that was actually asked.
*/

/** The attribute key. Short, because it is sent with every roster update. */
const key = "watching";

/**
 * Say whose share is on this screen, or that none is.
 *
 * Written only when it changes. Attributes are broadcast to the whole room, so
 * setting the same value on every render would be a message to everybody per
 * frame — which is the shape of bug that shows up as a call that gets slower the
 * longer it runs.
 */
export function useWatching(room: Room, sharer: string | undefined) {
	useEffect(() => {
		const already = room.localParticipant.attributes[key] ?? "";
		const wanted = sharer ?? "";

		if (already === wanted) return;

		// Rejected where the grant does not allow it, which is the case on a
		// token minted by an older server. Ignored rather than surfaced: a
		// missing watching list is a decoration, and a notice about a permission
		// is not something the person in the call can do anything about.
		void room.localParticipant.setAttributes({ [key]: wanted }).catch(() => {});
	}, [room, sharer]);
}

/**
 * Everybody who says they are looking at ours.
 *
 * Recomputed on the roster events as well as on the attribute one: somebody who
 * leaves stops watching, and nothing sends an attribute update to say so.
 */
export function useWatchers(room: Room, sharing: boolean): Participant[] {
	const [watchers, setWatchers] = useState<Participant[]>([]);

	useEffect(() => {
		if (!sharing) {
			setWatchers([]);
			return;
		}

		const gather = () => {
			const me = room.localParticipant.identity;

			setWatchers(
				roster(room).filter(
					(one) => one.identity !== me && one.attributes[key] === me,
				),
			);
		};

		gather();

		const events = [
			RoomEvent.ParticipantAttributesChanged,
			RoomEvent.ParticipantConnected,
			RoomEvent.ParticipantDisconnected,
			RoomEvent.ConnectionStateChanged,
		];

		for (const event of events) room.on(event, gather);

		return () => {
			for (const event of events) room.off(event, gather);
		};
	}, [room, sharing]);

	return watchers;
}
