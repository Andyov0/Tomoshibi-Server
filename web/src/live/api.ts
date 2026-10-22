import { INVITE_KEY } from "./account";
import { t } from "./i18n";
import { scopeOf } from "./names";
import { preferred } from "./relays";
import { keepForTab, recallForTab } from "@/lib/storage";
/*
 * The keys below still say the name this was called before.
 *
 * Deliberate, and not an oversight to tidy. They are what a browser already has
 * written down: a display name, a device choice, a language, an identity that
 * keeps somebody the same person across a reload. Renaming them renames nothing
 * — it abandons all of it, and everybody using this finds themselves nameless
 * and back in English on the morning after a deployment.
 */
const IDENTITY_KEY = "meet-live.identity";
const WAS_IN_KEY = "meet-live.was-in";
const RELAY_KEY = "meet-live.relay";

/**
 * Who may use a name nobody has used before.
 *
 * A property of the deployment and never of the reader. The server will not say
 * whether this particular person may open a room, because that turns on a
 * passphrase they have not typed yet, and an endpoint answering it would be an
 * unauthenticated way to test a guessed administrator's one.
 *
 * So the screen says who rooms are opened by, and the answer about any one
 * person arrives where it always did: on pressing Join.
 */
export type Opening = "anyone" | "signed" | "accounts" | "admins";

/** Who may enter a room that already exists. */
export type Joining = "anyone" | "invited" | "accounts";

/**
 * A join the server turned away, carrying why.
 *
 * The message is the sentence somebody reads and the reason is the code the
 * interface acts on — a screen that wants to offer "ask to be let in" after a
 * refusal has to know it was that refusal, and matching on the sentence would
 * be matching on a translation.
 */
export class Refused extends Error {
	readonly reason: string;

	constructor(reason: string | undefined, said: string) {
		super(said);
		this.name = "Refused";
		this.reason = reason ?? "";
	}
}

/** What the server said about itself. */
export interface Deployment {
	openedBy: Opening;

	/**
	 * Who may enter a room that already exists.
	 *
	 * Here because the join screen was saying the wrong thing without it: under
	 * the middle opening policy it read "anybody can join one that already
	 * exists", which was true of every deployment until there was a setting
	 * that made it false — and it went on saying so to people about to be turned
	 * away.
	 */
	joinedBy: Joining;
	/**
	 * Where the code running here can be read.
	 *
	 * Shown rather than kept, because this is licensed under the AGPL and its
	 * thirteenth section obliges whoever offers a program over a network to
	 * offer its source to the people using it that way. The people using this
	 * one are on this page.
	 */
	source: string;

	/**
	 * The commit the server was built from, empty where it does not know. See
	 * live/freshness.ts for what is done with it.
	 */
	build: string;
}

/** What a deployment that will not say anything is taken to be. */
// What a page reads when the server will not answer.
//
// "anyone" on both halves, which is what every deployment had until each
// setting existed. A page that cannot ask must not invent a restriction — and
// must not promise there is none either, which is why nothing is drawn at all
// until this is reached rather than starting here and correcting itself.
const PLAIN: Deployment = { openedBy: "anyone", joinedBy: "anyone", source: "", build: "" };

/**
 * Ask the server about itself.
 *
 * Falls back to the answer every deployment starts with. A server that will not
 * say should leave the page reading the way it has always read rather than
 * warning about a restriction that may not exist — and if one does exist, the
 * join is still refused by the only thing that decides it.
 */
export async function deployment(): Promise<Deployment> {
	try {
		const response = await fetch("/api/deployment");
		if (!response.ok) return PLAIN;

		const body = (await response.json()) as Partial<Deployment>;

		return {
			// All three, and not two.
			//
			// This narrowed "signed" to "anyone", which quietly disabled the
			// middle setting on the only screen that could act on it: the server
			// went on refusing a new name from anybody without a passphrase, and
			// the page went on saying nothing about it, so somebody who set the
			// policy saw no change and somebody who hit it got a refusal with no
			// warning beforehand. The narrowing was there to keep an unknown
			// value from reaching the interface, which is right — but it has to
			// let through the values that exist.
			openedBy:
				body.openedBy === "admins" ||
				body.openedBy === "signed" ||
				body.openedBy === "accounts"
					? body.openedBy
					: "anyone",
			// Narrowed the same way and to the same end, and the fallback is the
			// closed one: a page that cannot tell what the door is should not
			// promise anybody it is open.
			joinedBy: body.joinedBy === "anyone" || body.joinedBy === "accounts" ? body.joinedBy : "invited",
			source: typeof body.source === "string" ? body.source : "",
			build: typeof body.build === "string" ? body.build : "",
		};
	} catch {
		return PLAIN;
	}
}

/** What the server hands back for one room. */
export interface Join {
	url: string;
	token: string;
	identity: string;
	room: string;
	/** What to call the machine this call was sent to. */
	relay?: string;
	/**
	 * The deployment's region for the relay this browser chose, where it was
	 * given that relay — not the one the join sent it to instead, nor the one
	 * holding the meeting. Absent where the choice was not this browser's, and
	 * absent means unknown, not abroad. See internal/app/app.go.
	 */
	region?: string;
	/**
	 * What to call the machine the meeting is actually on, where that is not the
	 * one that was dialled.
	 *
	 * Said by the server, which picked both. It used to be worked out here by
	 * comparing the relay against the region the media server reports for the
	 * node holding the room — which only ever differed on a deployment that had
	 * set a region on every relay, and none had, so a forwarded call looked
	 * exactly like a direct one.
	 */
	holding?: string;
	/**
	 * Where to send media, when that is not the machine holding the room.
	 *
	 * A meeting lives on one server, so somebody joining a room that is already
	 * running would otherwise have their media go straight past the relay they
	 * picked — the choice would be theirs to make and would change nothing. When
	 * this is present the picked relay forwards instead: one extra hop, in
	 * exchange for the call entering the country the caller is in.
	 *
	 * Absent whenever the two are the same machine, which is most calls, and
	 * absent when the picked relay does not forward. Both mean: connect
	 * directly, as before.
	 */
	forward?: { url: string; username: string; credential: string };
}

/**
 * Ask the server to authorise us for a room.
 *
 * The identity from a previous join is sent back so a reload keeps the same one.
 * Without it a refresh would appear to everybody else as a second participant
 * arriving while the first is still being cleaned up.
 *
 * A passphrase, when given, is what turns the display name into one nobody else
 * can wear: the server derives a signature from it and puts that in the
 * identity, which the media server enforces. It is sent on every join rather
 * than once, so changing or dropping it takes effect immediately.
 *
 * The display name goes with the request rather than being set after
 * connecting, so it is signed into the token: nobody can rename themselves to
 * somebody else mid-call, and the name is there in the first roster update
 * rather than replacing a raw identity a moment later.
 *
 * Kept in session storage rather than local storage, because the identity
 * belongs to the tab and not to the browser. Local storage is shared across
 * every tab on the origin, so two of them would claim one identity and the
 * second would evict the first from the room.
 */
export async function join(
	room: string,
	name: string,
	passphrase = "",
	chosen = "",
	invite = "",
): Promise<Join> {
	const previous = recallForTab(IDENTITY_KEY) ?? undefined;

	// Which relay answered fastest, on a deployment that spreads its media over
	// several. Empty everywhere else, and empty here if measuring failed: the
	// server treats it as a preference and falls back to keeping the room
	// together, so a call still happens either way.
	//
	// Unless somebody said which one, in which case no measurement is taken at
	// all. Not because it would be wrong, but because it would be a second and
	// a half of waiting to produce an answer already overruled — and because
	// somebody who picks a relay by hand usually does so precisely when the
	// measurement is telling them the wrong thing.
	const relay = chosen || (await preferred());

	// The invite goes in the query and the passphrase does not, which looks
	// inconsistent and is not. A passphrase is a secret and a query parameter
	// reaches the access log, the history and any Referer sent onward. An invite
	// is a link somebody was sent — it is already in all three, by design, and
	// the server reads it from the same place whether it arrives on the join or
	// on the page.
	const url = `/api/rooms/${encodeURIComponent(room)}/join${
		invite ? `?invite=${encodeURIComponent(invite)}` : ""
	}`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		// The passphrase goes in the body and nowhere else. A query parameter
		// would reach the access log, the browser history, and any Referer sent
		// onward, and none of those are places a secret can be taken back from.
		body: JSON.stringify({ identity: previous, name, passphrase, relay }),
	});

	if (!response.ok) {
		const reason = await response
			.json()
			.then((body) => (body as { error?: string }).error)
			.catch(() => undefined);

		throw new Refused(reason, explain(reason, room));
	}

	const result = (await response.json()) as Join;
	keepForTab(IDENTITY_KEY, result.identity);

	// Which room this tab was in, so a reload can tell "I was just in a call" from
	// "somebody pasted a link". They look identical in the address bar and want
	// opposite answers: one should put you straight back, and the other should
	// let you look at your camera first.
	//
	// Session storage rather than local: it is about this tab. A second window
	// on the same machine is a second person as far as any of this is concerned,
	// and one of them reloading must not drag the other into a call.
	keepForTab(WAS_IN_KEY, room);

	// The invite comes out of the address bar now that it has been used.
	//
	// It belongs in a link — that is what an invite is, and the comment above
	// says so about the query, the history and any Referer. What it does not
	// belong in is the address bar of somebody in a video call, which is the one
	// place this application puts its users that a link normally never reaches:
	// people share their screen, and the token is a working key to the meeting
	// for the rest of the day.
	//
	// Kept in this tab rather than thrown away. The server has put it in a
	// cookie, but that cookie is HttpOnly and cannot be checked from here, and a
	// browser that declined it would otherwise be one where a reload loses the
	// call. Session storage is per tab, which is the same scope as being in this
	// call, and is a great deal less exposed than the address bar.
	if (invite) {
		keepForTab(INVITE_KEY, invite);

		const clean = new URL(window.location.href);
		if (clean.searchParams.has("invite")) {
			clean.searchParams.delete("invite");
			window.history.replaceState(null, "", clean.toString());
		}
	}

	return result;
}

/**
 * Turn what the server refused into something a person can read.
 *
 * The server sends a code and nothing else, so that the words live in one place
 * and one language at a time. A code this build does not recognise falls back to
 * the general failure rather than being shown raw: `rate_limited` on screen is
 * an implementation detail escaping, and it would escape untranslated.
 */
function explain(reason: string | undefined, room: string): string {
	switch (reason) {
		case "rate_limited":
			return t("Too many attempts. Try again in a moment.");
		case "invalid_room":
			return t("Room names can only use lowercase letters, numbers and dashes.");
		// Said as a fact about the room and never as a fact about the person
		// reading it. They were not judged and nothing about them was found
		// wanting: the name has simply never been used, and on this deployment
		// that is not something they can change.
		case "room_not_open":
			return t("{room} isn't open. Ask the organiser for the link.", {
				room,
			});
		// Said as a fact about the meeting, and without telling them whether
		// this name is in use — which is the one thing somebody guessing names
		// would learn from the difference between this and the sentence above.
		// Both point at the same way in: ask whoever is holding it.
		case "not_invited":
			return t("{room} is by invitation. Ask the organiser for a link.", {
				room,
			});
		// Said as who the room is for, which is written in its name already, so
		// nothing is given away that the person reading it did not type.
		case "not_in_scope":
			return t("Only members of {scope} can join {room}.", { room, scope: scopeOf(room) });
		// Said plainly, and about the passphrase rather than about the person.
		// It is the only thing this server recognises anybody by, and somebody
		// who is reading this may well not know why — telling them to ask is
		// more use than an apology.
		// Named rather than swapped, so somebody who picked a server they may not
		// use finds out they picked it, instead of ending up somewhere else and
		// wondering whether the picker did anything.
		case "relay_not_allowed":
			return t("Access denied. That server is for administrators.");
		case "blocked":
			return t("This passphrase cannot join. Ask the organiser.");
		case "server_error":
			return t("Something went wrong. Try again.");
		default:
			return t("Could not join {room}.", { room });
	}
}


/**
 * The room this tab was in when it was last in one.
 *
 * The signal a reload needs and the address bar cannot give: a URL naming a room
 * is equally what somebody was just in and what somebody has just been sent, and
 * only one of those should be walked straight into.
 */
export function wasIn(): string {
	return recallForTab(WAS_IN_KEY) ?? "";
}

/** Forgotten on a deliberate leave, so leaving and reloading is not rejoining. */
export function leftRoom(): void {
	keepForTab(WAS_IN_KEY, undefined);
}

/**
 * Which relay somebody last chose, and where that is written down.
 *
 * Here rather than in the page that first set it, because two screens choose a
 * relay and only one of them was remembering. Somebody would pick a machine in
 * the lobby, arrive at the device screen to find the picker showing "whichever
 * is fastest" instead of what they had just chosen, change it back, and lose
 * that too on the next reload — which is the shape of asking a person the same
 * question twice and ignoring both answers.
 *
 * Session storage rather than local: a choice of machine belongs to the sitting
 * somebody is in. Next week is a different network and the fastest machine is
 * probably a different one.
 */
export function chosenRelay(): string {
	return recallForTab(RELAY_KEY) ?? "";
}

export function rememberRelay(relay: string): void {
	if (relay) {
		keepForTab(RELAY_KEY, relay);

		return;
	}

	// Empty is a choice too — it means whichever measures fastest — and it has
	// to be able to replace a name, or a machine picked once could never be
	// unpicked.
	keepForTab(RELAY_KEY, undefined);
}
