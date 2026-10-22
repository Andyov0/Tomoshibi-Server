import { keepForTab, recallForTab } from "@/lib/storage";
/**
 * Who is signed in, from the front page's point of view.
 *
 * The account pages are a separate document with their own bundle; this is the
 * little the join page needs to know — whether there is a session, and what to
 * call the person holding it. Deliberately not the account pages' own client:
 * the join page should not carry the code for changing a passphrase, and the two
 * would drift the moment either changed.
 */
export interface Me {
	name: string;
	trip: string;
	avatar?: string;
	/**
	 * Whether this person also runs the deployment.
	 *
	 * Told to them so the page can offer the way to the management pages, and
	 * for nothing else. Nothing here is authorised by it: those pages ask the
	 * administrator list themselves, on every request, and would refuse a
	 * browser that had been told otherwise.
	 */
	admin?: boolean;
	/**
	 * The scopes this account carries, for offering them where a room name is
	 * typed. Like `admin`, it authorises nothing: the join asks the store.
	 */
	scopes?: string[];
	/**
	 * What this account may use — watching together, the music library, and
	 * the rest (store/perms.go). Said so a page can leave out what would be
	 * refused, and like the two above it authorises nothing: every endpoint
	 * asks for itself. Absent only from a server older than permissions.
	 */
	can?: string[];
}

/** The account this browser is signed in to, if any. */
export async function me(): Promise<Me | undefined> {
	try {
		const response = await fetch("/api/account/me", { credentials: "same-origin" });

		return response.ok ? ((await response.json()) as Me) : undefined;
	} catch {
		// A deployment with no accounts answers 404 and a broken one answers
		// nothing. Both mean the same thing here: nobody is signed in, carry on
		// as the page did before accounts existed.
		return undefined;
	}
}

/** Sign in, or say that the pair does not go together. */
export async function signIn(name: string, passphrase: string): Promise<Me> {
	const response = await fetch("/api/account/session", {
		method: "POST",
		headers: { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify({ name, passphrase }),
	});

	if (!response.ok) throw new Error("not_yours");

	return (await response.json()) as Me;
}

export async function signOut(): Promise<void> {
	await fetch("/api/account/session", { method: "DELETE", credentials: "same-origin" });
}

/**
 * The invite this page was opened with, if it was opened with one.
 *
 * From the query rather than the hash, because the hash is where the room name
 * lives and because a link somebody pastes into a chat client has its query
 * preserved by every one of them and its fragment by fewer.
 */
/** Where a spent invite is kept for this tab, so a reload is not a refusal. */
export const INVITE_KEY = "meet-live.invite";

/**
 * Keep an invite this tab was given rather than arrived with.
 *
 * Being let in through the waiting room produces one, and the alternative was
 * to put it in the address bar and reload — which works, and costs the whole
 * page, and lands somebody who has already waited two minutes back on a form
 * they have already filled in, to press a button they have already pressed.
 */
export function keepInvite(token: string): void {
	try {
		keepForTab(INVITE_KEY, token);
	} catch {
		// A tab that will not keep it can still use it: the join that follows
		// reads this and then asks the server, and only a reload needs the copy.
	}
}

export function inviteToken(): string {
	const said = new URLSearchParams(window.location.search).get("invite");
	if (said) return said;

	// Then what this tab kept when it took the token out of the address bar. A
	// reload after joining has no query left to read, and the cookie the server
	// set for exactly this cannot be seen from here.
	try {
		return recallForTab(INVITE_KEY) ?? "";
	} catch {
		return "";
	}
}

/**
 * What an invite says about itself: the room, and for a room held under a
 * scope, whose name it lets somebody wear and when it works.
 *
 * Times are instants as the server wrote them, and are turned into the reader's
 * own clock only where they are shown.
 */
export interface Invitation {
	room?: string;
	/** The name the guest will be called, where whoever made the link chose one. */
	name?: string;
	/** When it begins to work. Also sent with a refusal for a link used too early. */
	from?: string;
	/** When it stops, or absent for a link that lasts until it is revoked. */
	until?: string;
	error?: string;
}

/** What room an invite is for, or why it is no good. */
export async function invited(token: string): Promise<Invitation> {
	try {
		const response = await fetch(`/api/invites/${encodeURIComponent(token)}`);
		const body = (await response.json().catch(() => ({}))) as {
			room?: string;
			name?: string;
			from?: string;
			expires?: string;
			error?: string;
		};

		if (response.ok) return { room: body.room, name: body.name, from: body.from, until: body.expires };

		return { error: body.error ?? "no_such_invite", from: body.from };
	} catch {
		return { error: "no_such_invite" };
	}
}

/**
 * Whether a meeting is happening under this name.
 *
 * Asked before somebody is taken any further, in both directions: starting a
 * meeting under a name already in use would put them in somebody else's call,
 * and joining one that is not there takes them to a camera preview for a room
 * that does not exist — which reads as the name being wrong only if they
 * remember typing it, and as the site being broken otherwise.
 *
 * Answered only to somebody signed in. A room here is a name and nothing else,
 * so this would otherwise be a way to find meetings by guessing at them.
 */
export async function meeting(room: string): Promise<boolean | undefined> {
	try {
		const response = await fetch(`/api/rooms/${encodeURIComponent(room)}/live`, {
			credentials: "same-origin",
		});

		if (!response.ok) return undefined;

		return ((await response.json()) as { live: boolean }).live;
	} catch {
		// Unknown rather than either. A check that cannot be made must not become
		// a refusal: the join itself is the authority and says so properly.
		return undefined;
	}
}
