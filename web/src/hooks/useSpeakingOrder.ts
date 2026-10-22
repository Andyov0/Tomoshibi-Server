import type { Participant } from "livekit-client";
import { useMemo, useRef } from "react";

/**
 * Order people so that whoever has spoken recently is near the front.
 *
 * Only matters once there are more people than fit on a page: somebody talking
 * from the second page is somebody nobody can see, which is the one thing
 * pagination gets wrong. Below that threshold the order is left alone, because a
 * grid that rearranges itself every time somebody speaks is worse than one that
 * simply holds still.
 *
 * Ordered by when each person was last heard rather than by whether they are
 * speaking now. Speech is full of gaps, and sorting on the instantaneous flag
 * would drop somebody down the grid between two words of a sentence.
 */
export function useSpeakingOrder(participants: Participant[], enabled: boolean): Participant[] {
	// Identity to the moment they were last heard. Held in a ref because it is a
	// record of what has happened rather than something rendered directly.
	const heard = useRef(new Map<string, number>());

	return useMemo(() => {
		// Written down here, in the same pass that sorts, rather than in an
		// effect after it. An effect runs after the render that used the map, so
		// the sort always read the room as it was one change earlier: somebody
		// who started talking from the second page was moved forward only on the
		// next change to the roster, which was usually them stopping — exactly
		// the moment it stopped mattering. Updating a ref during render is safe
		// here because doing it twice for one render records the same thing.
		const now = Date.now();

		for (const participant of participants) {
			if (participant.isSpeaking) heard.current.set(participant.identity, now);
		}

		// Somebody who left should not keep a place in the order they would take
		// if they came back under the same identity.
		const present = new Set(participants.map((participant) => participant.identity));
		for (const identity of heard.current.keys()) {
			if (!present.has(identity)) heard.current.delete(identity);
		}

		if (!enabled) return participants;

		return [...participants].sort((a, b) => {
			const spokeA = heard.current.get(a.identity) ?? 0;
			const spokeB = heard.current.get(b.identity) ?? 0;

			// Ties keep the order they arrived in, so a room where nobody has
			// said anything looks exactly as it did before this ran.
			return spokeB - spokeA;
		});
	}, [participants, enabled]);
}
