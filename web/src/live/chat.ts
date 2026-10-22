import type { ChatMessage, Participant } from "livekit-client";

/** One thing somebody said. */
export interface Said {
	id: string;
	/** Who said it, as the identity their token was signed with. */
	from: string;
	/** What they are called, resolved when it arrived. */
	name: string;
	body: string;
	at: number;
	mine: boolean;
}

/**
 * How long a message stays on somebody's picture.
 *
 * Longer than a notice, because "Sable joined" is read at a glance and a
 * sentence is not. A message that disappears before it has been read is worse
 * than one that was never shown.
 */
export const SAID_FOR = 6000;

/**
 * How many messages are kept.
 *
 * Nothing is persisted, but a long call still accumulates and every message
 * stays mounted in the panel. Five hundred is past what anybody scrolls back
 * through and small enough that the list never becomes the reason the interface
 * feels slow.
 */
export const KEEP = 500;

/**
 * Turn an arriving message into something the interface can hold.
 *
 * The identity is kept as a plain key rather than the participant object, so a
 * message can be matched against a tile without holding a reference to somebody
 * who may already have left.
 */
export function received(
	message: ChatMessage,
	from: Participant | undefined,
	localIdentity: string,
): Said {
	const identity = from?.identity ?? localIdentity;

	return {
		id: message.id,
		from: identity,
		name: from?.name || identity,
		body: message.message,
		at: message.timestamp,
		mine: identity === localIdentity,
	};
}
