/**
 * Asking to be let into a meeting that refused you.
 *
 * The door turns away somebody with no invite, no account and no claim on the
 * room, and that is right for a stranger who guessed a name. It is wrong for
 * somebody who was told "we're on at four" and never got the link, which is
 * most of the people who will ever see the refusal — the meeting is real, they
 * are expected, and the only thing missing is a URL nobody sent.
 *
 * So the refusal offers a way to ask. What being let in produces is an ordinary
 * invite, which the ordinary join then uses: there is one way through the door
 * and this arranges to be given it, rather than being a second way.
 */

/** What the door said about somebody standing at it. */
export type AtTheDoor = "knocking" | "admitted" | "refused";

/** How often to ask whether anybody has answered. */
export const ASK_EVERY = 3000;

/**
 * A backstop, and nothing more.
 *
 * What ends the waiting is the door: a knock the server has stopped holding
 * answers "refused", which is the same thing from out here as being turned
 * away, and the poll stops on it. So this is not the length of the wait — it is
 * the length of time a browser goes on asking a server that never answers at
 * all, which is the only case the door cannot end.
 *
 * It used to be the wait itself, at two and a half minutes against the five the
 * server holds a knock for. Between those two numbers the host still saw
 * somebody at the door and could still let them in, and the person had stopped
 * listening — so the admission worked, the invitation was minted, and nobody
 * arrived. From inside it read as somebody being let in and not coming.
 *
 * Twice the longest the server will hold anything, so it can only ever be the
 * dead-network case rather than a second opinion about who is still waiting.
 */
export const GIVE_UP_AFTER = 600_000;

async function ask<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});

	if (!response.ok) throw new Error(String(response.status));

	return (await response.json()) as T;
}

/** Knock, and get back the token to ask about it with. */
export function knock(room: string, name: string): Promise<{ token: string }> {
	return ask(`/api/rooms/${encodeURIComponent(room)}/knock`, {
		method: "POST",
		body: JSON.stringify({ name }),
	});
}

/**
 * Ask whether anybody has answered.
 *
 * A knock nobody answered and one that was refused come back the same, because
 * they are the same thing from outside the door — and telling them apart would
 * say whether the room exists.
 */
export function atTheDoor(
	room: string,
	token: string,
): Promise<{ state: AtTheDoor; invite?: string }> {
	return ask(`/api/rooms/${encodeURIComponent(room)}/knock/${encodeURIComponent(token)}`);
}

/** One person waiting, as the room sees them. */
export interface Knocking {
	id: string;
	name: string;
	address: string;
	at: string;
}

/** Who is at the door, for somebody inside who can answer. */
export function knocking(room: string, token: string): Promise<{ knocking: Knocking[] }> {
	return ask(`/api/rooms/${encodeURIComponent(room)}/knocks`, {
		headers: { Authorization: `Bearer ${token}` },
	});
}

/** Let somebody in, or do not. */
export function answer(
	room: string,
	id: string,
	token: string,
	admit: boolean,
): Promise<{ state: AtTheDoor }> {
	return ask(`/api/rooms/${encodeURIComponent(room)}/knocks/${encodeURIComponent(id)}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
		body: JSON.stringify({ admit }),
	});
}
