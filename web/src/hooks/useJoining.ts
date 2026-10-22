import { type Joining, deployment } from "@/live/api";
import { scopeOf } from "@/live/names";
import { useEffect, useState } from "react";

/**
 * Who may enter a room that already exists, asked once for the whole page.
 *
 * Three places need this and all three need it for the same reason: a plain
 * link to a room is only a way in where anybody may use one. Where the door
 * asks for an invitation, copying the address and sending it to somebody is
 * handing them a door they cannot open — and the button that offers to do it
 * reads as an invitation, which is the one thing it is not.
 *
 * Cached in a promise rather than re-fetched per component, because the answer
 * is a property of the deployment and three requests for it on one screen is
 * three chances to draw two different things.
 *
 * Undefined until it is known. Nothing decides anything on a guess here: a
 * button drawn and then taken away is worse than one that arrives a moment
 * late, and this one is about who can be let into a meeting.
 */
let asked: Promise<Joining | undefined> | undefined;

/**
 * Ask again next time.
 *
 * The cache is the point of this module, and it is also why a test can only
 * ever see one deployment: the answer is kept for the life of the page, and a
 * test file is one page. The same escape hatch as live/relays, and for the same
 * reason.
 */
export function forget(): void {
	asked = undefined;
}

export function useJoining(): Joining | undefined {
	const [joining, setJoining] = useState<Joining>();

	useEffect(() => {
		let live = true;

		asked ??= deployment().then((said) => said.joinedBy);

		void asked.then((said) => {
			if (live && said) setJoining(said);
		});

		return () => {
			live = false;
		};
	}, []);

	return joining;
}

/**
 * Whether a plain link to this room is a way into it.
 *
 * False until the answer is in, so a button that should not exist is never
 * drawn and then taken away. That costs nothing: deployment() answers from the
 * network or falls back to what every deployment starts with, so the wait is
 * one request and never an indefinite one.
 */
export function useLinkWorks(room: string): boolean {
	const joining = useJoining();

	// Not for a room held under a scope. It opens for its members whatever the
	// deployment says about plain names, and its members can already say its
	// name — so a copy of the address reaches nobody it would let in, and the
	// people it would be sent to need an invitation instead, exactly as under
	// the invitation-only door.
	if (scopeOf(room)) return false;

	return joining === "anyone";
}
