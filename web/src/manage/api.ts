import { linkIs } from "./units";
import { t } from "@/live/i18n";

/**
 * What the management pages ask the server.
 *
 * Nothing here carries a credential. The session is a cookie the browser was
 * given and cannot read, and the token that can actually close a room lives in
 * the server and is spent there — a page holding one would put it a single
 * cross-site script away from somebody who should not have it.
 */

export interface Who {
	trip: string;
	name?: string;
	can: string[];
}

/**
 * One relay, as a control node reads it.
 *
 * Reachable is separate from the counters and has to stay that way: a relay
 * holding no calls and a relay that did not answer are both zeros, and the
 * difference between quiet and down is most of why anybody opens this page.
 */
export interface NodeReading {
	name: string;
	url: string;
	reachable: boolean;
	detail?: string;
	/**
	 * What a person calls the machine, and where it is.
	 *
	 * Sent with the counters rather than joined against the relay list on the
	 * page: the two are fetched on different timers, and a row drawn from one
	 * and labelled from the other is briefly wrong every time either changes.
	 */
	label?: string;
	region?: string;
	/**
	 * How long this relay took to answer the control node, in milliseconds.
	 *
	 * Not what a caller will see. It is one round trip on one path — this
	 * node's — and it is here because it is the only latency this page can
	 * report without inventing it, and because a relay that has become slow to
	 * answer is worth noticing before it stops.
	 */
	tookMs?: number;
	nackPerSec?: number;
	node: string;
	ip: string;
	rooms: number;
	clients: number;
	tracksIn: number;
	tracksOut: number;
	outPerSec: number;
	inPerSec: number;
	/** Since this relay's process started, not since the month began. */
	bytesIn: number;
	bytesOut: number;
	cpus: number;
	load: number;
	startedAt?: string;
}

/**
 * The live reading, in either of the two shapes the server sends.
 *
 * A deployment holding its own media describes one process: it has a node
 * identity and an address it gives to clients. A control node holds none and
 * describes its relays instead — a list of them and a sum across the ones that
 * answered. The shapes differ because the things being described differ, and
 * pretending otherwise is what took this page down: `node` is absent on a
 * control node, and reading `node.id` through an optional chain that only
 * guarded the reading above it threw on a field that was never going to be
 * there.
 *
 * Both halves are optional here so that neither can be read without asking
 * which shape arrived.
 */
export interface Now {
	/** Present on a deployment that holds its own media. */
	node?: { id: string; ip: string };
	/** Present on a control node, along with nodes. */
	fleet?: boolean;
	nodes?: NodeReading[];
	asked?: number;
	answered?: number;
	since: string;
	rooms: number;
	clients: number;
	tracks: { in: number; out: number };
	bytes: { in: number; out: number; inPerSec: number; outPerSec: number; window: number };
	packets: { nackTotal: number; nackPerSec: number };
	cpu: { count: number; load: number };
}

/**
 * One bucket of the trend.
 *
 * The rates are the mean over the bucket and the peaks are the highest single
 * reading inside it, which are different questions and both worth asking: a
 * six-hour mean says what the evening cost and hides the two minutes that hit
 * the ceiling. Rooms and clients are gauges and have no peak, because they move
 * on the timescale of a meeting rather than of a packet — their mean already
 * describes their shape.
 *
 * `n` is how many five-second readings are behind the bucket. A bucket holding
 * one of a possible thirty-six is not wrong, but it is not the same claim as a
 * full one.
 */
export interface Point {
	at: string;
	in: number;
	out: number;
	inPeak: number;
	outPeak: number;
	rooms: number;
	clients: number;
	nack: number;
	nackPeak: number;
	n: number;
}

/**
 * The load over a stretch of time, as the server answers it.
 *
 * The width of a bucket comes with the points and is not inferred from them.
 * The same array is an hour or half a year depending on `step`, and a page that
 * assumed either would label an axis with the wrong day and be believed. The
 * range comes too, because what was asked for is not always what could be
 * answered: a deployment three days old asked for six months has three days.
 */
export interface Trend {
	span: string;
	/** Seconds to a bucket. */
	step: number;
	from: string;
	to: string;
	points: Point[];
}

export interface LiveRoom {
	name: string;
	sid: string;
	participants: number;
	publishers: number;
	createdAt: string;
	/**
	 * Which relay the meeting is on.
	 *
	 * From this deployment's own record and not from the media server, which
	 * reports a room from whichever node was asked — every node answers for the
	 * whole cluster, so the field that looks like it should hold this holds the
	 * machine that answered.
	 */
	relay?: string;
	/**
	 * Whether somebody chose that machine, or a join left it behind.
	 *
	 * A placement stands until it is cleared: it does not expire and is not
	 * spent by being obeyed. That is what makes it worth showing — one that went
	 * away on its own could be left unmentioned, and one that does not would
	 * otherwise be a room quietly ignoring every later choice with nothing on
	 * any page to say why.
	 */
	placed?: boolean;
}

export interface KnownRoom {
	name: string;
	firstSeen: string;
	lastSeen: string;
	/**
	 * Where the next meeting of this name will be held, where somebody has said.
	 *
	 * Only ever set for a placement — a name nobody is using has no meeting to
	 * be anywhere, so the guess a join leaves behind is not worth showing. This
	 * is the pin that gets forgotten: nothing is happening in the room, so
	 * nobody is looking at it, and it is still waiting to decide where the next
	 * one goes.
	 */
	relay?: string;
	placed?: boolean;
}

/** One join, as the history reads it. */
/**
 * What somebody joined from, as their request named it at the door: a
 * browser and the system under it, or one of the apps and its version.
 * Taken on the request's word (internal/app/device.go).
 */
export interface Client {
	/** web, iphone, ipad, mac, android, windows, app (too old to say which), or other. */
	kind: string;
	/** The app's version, for an app that says it. */
	app?: string;
	/** The browser and its major version, such as "Chrome 155". */
	browser?: string;
	/** The system, as far as the request tells it. */
	system?: string;
	/** The model, where an app says it. */
	device?: string;
	/** The user agent as sent, cut short. */
	agent?: string;
}

export interface Visit {
	identity: string;
	at: string;
	/** What they typed, which is the one thing on the row anybody could invent. */
	name?: string;
	/**
	 * Who this deployment knows the mark belongs to.
	 *
	 * Resolved on the server against the accounts and the administrators, so it
	 * is present for somebody this deployment has heard of and absent for a
	 * guest — and present for rows written before the typed name was recorded,
	 * which is every row that existed before this was built.
	 */
	account?: string;
	/** The mark itself, without the prefix saying what kind it is. */
	trip?: string;
	/** account, passphrase, or guest. */
	kind?: string;
	/** Where the request came from, as this deployment resolved it. */
	address?: string;
	/** The machine they were sent to: the door, not necessarily the room. */
	relay?: string;
	/** The machine the meeting was on, where that was a different one. */
	holding?: string;
	forwarded?: boolean;
	/** What they joined from, for joins recorded since that was kept. */
	client?: Client;
}

export interface Layer {
	quality: string;
	width: number;
	height: number;
	bitrate: number;
}

export interface Track {
	sid: string;
	source: string;
	kind: string;
	muted: boolean;
	width: number;
	height: number;
	mime: string;
	simulcast: boolean;
	layers: Layer[];
}

export interface Participant {
	identity: string;
	name: string;
	sid: string;
	state: string;
	joinedAt: string;
	publisher: boolean;
	trip: { mark: string; proven: boolean; account?: boolean };
	tracks: Track[];
	/**
	 * Where they came from, as this deployment resolved it at the join.
	 *
	 * The media server cannot say: it sees each participant over a signalling
	 * socket from a relay, so the address it holds is the relay's.
	 */
	address?: string;
	/** The relay they came in through, which is not always the one holding the room. */
	relay?: string;
	/** The relay holding the room, sent only where it is a different machine. */
	holding?: string;
	/** Their media is being forwarded through `relay` to `holding`. */
	forwarded?: boolean;
	/** What they joined from, for joins recorded since that was kept. */
	client?: Client;
}

/** One administrator, as the management pages see them. */
export interface Administrator {
	trip: string;
	name: string;
	/**
	 * Every capability they hold, moderate's four included.
	 *
	 * What to read to ask whether they may do something. Not what to edit: a
	 * moderator's list names all four finer capabilities and was given none of
	 * them by name, so a page that sent it back would be writing four grants
	 * nobody chose.
	 */
	can: string[];
	/** What is written against them, which is what the role control edits. */
	granted?: string[];
	added?: string;
	/** Whoever is reading, so a page can say so and guard their own way back in. */
	self?: boolean;
	/** Every permission and whether they hold it. Only the Emby grant can differ. */
	effective?: Record<string, boolean>;
	/** What the Emby relay has carried on their behalf since the server started. */
	embySpent?: number;
}

/** Somebody who was given a way in. */
export interface Account {
	name: string;
	trip: string;
	/** Whether they have chosen a picture. The picture itself is fetched by URL. */
	avatar?: boolean;
	created?: string;
	lastSeen?: string;
	blocked?: boolean;
	note?: string;
	/** The groups they belong to, each a name a room may be held under after an `@`. */
	scopes?: string[];
	/**
	 * Every permission and whether they hold it.
	 *
	 * Drawn from rather than the stored overrides the server also keeps, so
	 * that the page never has to know a default: one changed on the server
	 * would otherwise be drawn wrongly on every account that never moved it.
	 */
	effective?: Record<string, boolean>;
	/** What the Emby relay has carried on their behalf since the server started. */
	embySpent?: number;
}

/**
 * Watching together, and what the deployment relays of it.
 *
 * Three facts rather than one switch, because the switch means something only
 * where the other two say it can: without a gateway there is nothing to relay,
 * and where the configuration file relays everything already the switch is
 * holding nothing back.
 */
export interface Watching {
	/** Whether there is a gateway at all. */
	configured: boolean;
	/** The file's meet.watch.direct_only: relay nothing unless the switch says. */
	directOnly: boolean;
	/** The switch kept in the store: relay films picked by people granted Emby. */
	embyRelay: boolean;
	/**
	 * The other switch kept in the store: relay YouTube for every viewer who
	 * cannot reach it. Absent from a server older than the switch, which read
	 * as off, because that is what such a server does.
	 */
	youtubeRelay?: boolean;
	/** What the YouTube relay has carried, in bytes, since the server started. */
	youtubeSpent?: number;
	/**
	 * The third switch kept in the store: relay Bilibili's bangumi for every
	 * viewer. On until somebody turns it off; absent from a server older than
	 * the switch, which relays no bangumi, and read as off for that reason.
	 */
	bangumiRelay?: boolean;
	/** What the bangumi relay has carried, in bytes, since the server started. */
	bangumiSpent?: number;
}

/** Who may use a name nobody has used before. */
export type Opening = "anyone" | "signed" | "accounts" | "admins";

/**
 * Who may enter a room that already exists.
 *
 * The other half of the door, and the half that had no setting: a room here is
 * a name, so knowing the name was the whole of the check. "anyone" is what the
 * deployment did before this existed.
 */
export type Joining = "anyone" | "invited" | "accounts";

/**
 * The policy, in the three forms worth telling apart.
 *
 * One value would be enough to draw a switch and not enough to explain it.
 * These separate the choice somebody made from the file it started in and from
 * what the deployment can actually carry out, which is how the two ways this
 * goes quietly wrong become something a page can point at.
 */
export interface Policy {
	/** What the server is doing. */
	openedBy: Opening;
	/** What was last set, before it was reconciled against who exists. */
	chosen: Opening;
	/** The configuration file's value, which is the starting one and no more. */
	configured: Opening;

	/** Who may enter a room that already exists, in the same three forms. */
	joinedBy: Joining;
	chosenJoin: Joining;
	configuredJoin: Joining;
	/**
	 * How long a name stays used after the last join, in seconds, or nought
	 * where names are kept for ever.
	 *
	 * The other half of the same sentence as the switch above it: that says who
	 * may open a room and this says how long one stays open. Reading either
	 * without the other is reading half a rule.
	 */
	remember: number;
}

export interface Runtime {
	meet: Record<string, unknown>;
	rtc: Record<string, unknown>;
	rooms: Policy;
	credentials: { key: string };
	codecs: string[];
}

/** Raised when the session has gone, so a caller can send somebody to sign in. */
export class SignedOut extends Error {
	constructor() {
		super("signed out");
	}
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/admin${path}`, {
		...init,
		headers: { "content-type": "application/json", ...init?.headers },
	});

	if (response.status === 401) throw new SignedOut();

	if (!response.ok) {
		const reason = await response
			.json()
			.then((body: { error?: string }) => body.error)
			.catch(() => undefined);

		throw new Error(explain(reason, response.status));
	}

	if (response.status === 204) return undefined as T;

	return (await response.json()) as T;
}

/**
 * The server sends a code. The sentence belongs here, with the rest of the
 * words.
 *
 * There were nine of these and the server sends forty-two, so a new account
 * with a name somebody already had said "HTTP 409", and a passphrase two
 * characters short said "HTTP 400". Every one of them now has a sentence, and
 * every sentence goes through the dictionary like the rest of the interface —
 * which it did not, because this file had no import at all.
 */
function explain(reason: string | undefined, status: number): string {
	switch (reason) {
		case "too_many_attempts":
			return t("Too many attempts. Wait a minute and try again.");
		case "refused":
			return t("That passphrase is not an administrator's.");
		case "wrong_passphrase":
			return t("That passphrase is not an administrator's.");
		// Said about the role rather than about watching, which is what this
		// used to say. With the acting half cut four ways, somebody refused here
		// may well change accounts all day and simply not relays, and being told
		// they may only watch is being told something untrue.
		case "not_allowed":
			return t("Your administrator role does not cover this.");
		// A capability the server does not know is a page newer than the server
		// behind it, which is the useful thing to say; it was mapped to the
		// sentence above, which blamed the reader for a version mismatch.
		case "unknown_capability":
			return t("That is not a role this server knows. It may be running an older version.");
		case "unknown_permission":
			return t("That is not a permission this server knows. It may be running an older version.");
		// The one box on the accounts page that the accounts capability cannot
		// tick, and the passphrase of anybody it is ticked for, which is the
		// same decision by another door. Said as who can, because the person
		// reading it has no other way to learn why a press beside six that work
		// did not.
		case "emby_needs_moderate":
			return t("Only an administrator who can manage everything can give or take away Emby, or set the passphrase of somebody who has it.");
		case "signed_out":
			return t("That session has ended. Sign in again.");
		case "no_such_room":
			return t("That room has ended.");
		case "media_server_unreachable":
			return t("The media server did not answer.");
		case "no_media_here":
			return t("This node holds no media, so there is nothing to ask it.");
		case "no_track":
			return t("No track was named.");
		case "no_such_span":
			return t("That is not a stretch of time this server can answer for.");
		case "no_such_policy":
			return t("Rooms are opened either by anyone or by administrators, and that was neither.");
		// Said as a thing to do next rather than as a refusal, because there is
		// one and it is short: close the room, then forget it.
		case "room_in_use":
			return t("Somebody is in that room. Close it first, then forget it.");
		case "media_server_unreachable":
			return t("The media servers are not answering, so this could not be checked. Nothing was changed.");
		case "store_unwritable":
			return t("The change could not be written down, so nothing was changed.");
		case "store_unavailable":
			return t("The store is not answering, so nothing was changed.");
		case "name_taken":
			return t("That name is already taken.");
		case "name_too_long":
			return t("That name is too long.");
		case "bad_name":
			return t("That name cannot be used.");
		case "no_such_account":
			return t("There is no account by that name.");
		case "no_passphrase":
			return t("A passphrase is needed.");
		case "passphrase_too_short":
			return t("That passphrase is too short.");
		case "passphrase_in_use":
			return t("That passphrase is already somebody else's.");
		case "passphrase_unchanged":
			return t("That is the passphrase already in use.");
		case "already_an_administrator":
			return t("They are an administrator already.");
		case "no_such_administrator":
			return t("There is no administrator by that signature.");
		case "last_moderator":
			return t("That is the last administrator who can change anything, so it stays.");
		case "not_a_signature":
			return t("That is not a signature.");
		case "relay_exists":
			return t("A relay by that name is already here.");
		case "no_such_relay":
		case "signal_via_unknown":
			return t("There is no relay by that name.");
		case "signal_via_itself":
			return t("A relay cannot signal through itself.");
		case "signal_via_chained":
			return t("That relay signals through another one itself.");
		case "relay_signalled_through":
			return t("Other relays signal through this one. Point them at another first.");
		case "relay_no_name":
			return t("A relay needs a name.");
		case "relay_long_name":
			return t("That relay name is too long.");
		case "relay_long_label":
			return t("That label is too long.");
		case "relay_no_url":
			return t("A relay needs an address.");
		case "relay_bad_url":
			return t("That is not an address a client can dial.");
		case "relay_long_region":
			return t("That region name is too long.");
		case "relay_refused":
			return t("The relay refused.");
		case "no_relay_list":
			return t("This deployment keeps no relay list.");
		case "bad_address":
			return t("That is not an address.");
		case "bad_prefix":
			return t("That prefix cannot be used.");
		case "no_enrolment":
			return t("This deployment does not let machines enrol themselves.");
		case "wrong_secret":
			return t("That is not the enrolment secret.");
		case "no_certificate":
			return t("There is no certificate to hand out.");
		// Both, because the server says both: unreadable_request from some
		// handlers and plain unreadable from the accounts and the roster. Only
		// the first was here, so a malformed change to an account read as a bare
		// HTTP 400.
		case "unreadable_request":
		case "unreadable":
			return t("The request could not be read.");
		case "avatar_too_large":
			return t("That picture is too large.");
		case "bad_scope":
			return t("A scope uses lowercase letters, numbers and dashes, at most 32 of them.");
		case "under_score":
			return t("A name cannot start with an underscore.");
		default:
			// A code this build has no sentence for. Better a status than the
			// code itself: media_server_unreachable on a screen is an internal
			// name escaping, and it escapes untranslated.
			return t("The server refused the request.") + ` (HTTP ${status})`;
	}
}

/** One media server, as the management pages see it. */
export interface Relay {
	name: string;
	url: string;
	region?: string;
	/** What people are shown instead of the name, which is a key and not a word. */
	label?: string;
	/** Held back for when nothing else can be reached. */
	fallback?: boolean;
	/** Not offered to, or usable by, anybody who is not an administrator. */
	adminOnly?: boolean;
	/** Where it answers STUN binding requests, as host:port. */
	probe?: string;
	/** host:port of its TURN server, where it can forward a room it is not holding. */
	turn?: string;
	/** Whether it may carry a call held on another machine. */
	forwards?: boolean;
	/**
	 * Relays this one must not forward with, by name.
	 *
	 * In either direction: if either of a pair lists the other, the pair does not
	 * forward. Reachability between two machines is a fact about the networks
	 * between them and nothing can derive it — two relays can both be fast, both
	 * be in the same country, and still carry nothing usable between each other.
	 */
	apart?: string[];
	/**
	 * Whether this relay may stand in for one that cannot reach a room.
	 *
	 * For a fleet with machines on both sides of a border: somebody who lands on
	 * a pair that carries nothing is sent here instead, which is the one way
	 * their call can go rather than not going at all.
	 */
	bridge?: boolean;
	/**
	 * The relay this one's signalling goes through, for a machine no TLS
	 * handshake reaches.
	 *
	 * The mainland providers intercept TLS to a server without an ICP filing,
	 * by name or by bare IP, while UDP passes. Such a relay carries the media
	 * and its TURN, and clients open their signalling to the relay named here
	 * instead; the room is still held on this one. Empty is a relay that
	 * signals for itself.
	 */
	signalVia?: string;
	/**
	 * Where the machine is, in degrees.
	 *
	 * Two things read it and both were dead until it could be set. The globe on
	 * the join screen draws a point per relay and filters out any without a
	 * place, so it drew nothing at all; and the enrolment writes a distance-aware
	 * node selector only where at least two relays have one, so every machine
	 * brought up by the script fell back to picking a media node at random --
	 * which is the fault recorded in internal/store/relays.go as having put
	 * people into meetings on machines they could not reach.
	 *
	 * The server has accepted these since the field existed. Nothing sent them:
	 * the panel had no box and the type did not name them, so the only way to
	 * set one was curl.
	 */
	lat?: number;
	lon?: number;
	enabled: boolean;
	added?: string;
	/** Whether it answered when this page was drawn, from the control node. */
	reachable: boolean;
	latencyMs?: number;
	/** Why it did not answer, when it did not. A code is not sent for this one:
	 * it is a transport failure summarised by the server, and there is no fixed
	 * set of them to translate. */
	detail?: string;
}

export const api = {
	whoami: () => call<Who>("/session"),
	/**
	 * Both, always.
	 *
	 * A passphrase alone is checked against every administrator at once, so a
	 * list of leaked passphrases run at this endpoint succeeds if any one person
	 * on the deployment has ever reused one. The name makes a guess have to be
	 * aimed at somebody.
	 */
	signIn: (name: string, passphrase: string) =>
		call<Who>("/session", { method: "POST", body: JSON.stringify({ name, passphrase }) }),
	signOut: () => call<void>("/session", { method: "DELETE" }),

	now: () => call<Now>("/now"),

	/**
	 * The trend, over a named span or between two moments.
	 *
	 * The span is a key rather than a number of seconds, so that the page and
	 * the server agree on what a month is without either of them saying it in a
	 * query string. A pair of moments is the only way to ask about a window
	 * that has already passed: every named span ends now.
	 */
	history: (span: string, range?: { from: string; to: string }) =>
		call<Trend>(
			`/history?${new URLSearchParams(range ? { from: range.from, to: range.to } : { span })}`,
		),
	rooms: () =>
		call<{ live: LiveRoom[]; known: KnownRoom[] | null; liveUnavailable?: boolean }>("/rooms"),
	/**
	 * Every join recorded against a room, newest first.
	 *
	 * Answers for a room nobody is in, which is the whole point: participants
	 * asks the media server, and the media server has nothing to say about a
	 * meeting that ended.
	 */
	visits: (room: string) =>
		call<{ room: string; visits: Visit[]; total?: number }>(
			`/rooms/${encodeURIComponent(room)}/visits`,
		),

	participants: (room: string) =>
		call<Participant[]>(`/rooms/${encodeURIComponent(room)}/participants`),
	/**
	 * The settings this deployment is running under.
	 *
	 * Also where the pages learn what the network link is thought to carry, which
	 * three of them draw against. Told here rather than threaded down through
	 * three components at three depths: the figure belongs to the deployment
	 * rather than to any of them, and every page that draws a bandwidth bar has
	 * already asked for this.
	 */
	runtime: async () => {
		const said = await call<Runtime>("/runtime");
		linkIs(said.meet?.linkMbits as number | undefined);

		return said;
	},
	policy: () => call<Policy>("/policy"),

	/**
	 * Where a room is held.
	 *
	 * A meeting lives on one machine and the media server has no migration, so
	 * `now` is the difference between two genuinely different actions: without
	 * it the change waits for the next call under that name, and with it the
	 * call in progress is ended so everybody comes back to the new machine.
	 */
	placeRoom: (room: string, relay: string, now: boolean) =>
		call<{ room: string; relay: string; moved: boolean }>(
			`/rooms/${encodeURIComponent(room)}/relay`,
			{ method: "PUT", body: JSON.stringify({ relay, now }) },
		),

	/**
	 * Hand a room back to whatever would have chosen for it.
	 *
	 * The only thing that undoes a placement — not a timer, not the join that
	 * carries it out, not the call ending. Nothing moves: the meeting in
	 * progress stays where it is, and this is about where the next one goes.
	 */
	/**
	 * Remove a name and everything written against it.
	 *
	 * Distinct from closing a room, which ends a meeting and leaves the name, and
	 * from freeRoom, which clears where it is held and leaves the name. This is
	 * for a name that should not be in the list — and the placement is what makes
	 * that worth doing, since one now stands until somebody says otherwise.
	 *
	 * Refused with 409 while somebody is in the room: the record is what says the
	 * name has been used, and removing it turns the next arrival into somebody
	 * opening a room that is already full of people.
	 */
	forgetRoom: (room: string) =>
		call<{ room: string; forgotten: boolean }>(`/rooms/${encodeURIComponent(room)}/record`, {
			method: "DELETE",
		}),

	freeRoom: (room: string) =>
		call<{ room: string; relay: string; moved: boolean }>(
			`/rooms/${encodeURIComponent(room)}/relay`,
			{ method: "DELETE" },
		),

	/**
	 * Which relay one person comes in through.
	 *
	 * Takes effect on their next join and then goes away, so it moves somebody
	 * once rather than overruling their own choice for ever. They are removed
	 * from the call as part of it, because a browser holds its connection to the
	 * machine it dialled and nothing in the protocol asks it to move.
	 */
	placePerson: (room: string, identity: string, relay: string) =>
		call<{ relay: string }>(
			`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}/relay`,
			{ method: "PUT", body: JSON.stringify({ relay }) },
		),

	/** Whether the deployment relays the films people granted Emby pick, YouTube, and bangumi. */
	settings: () => call<Watching>("/settings"),

	/**
	 * Turn that relay on or off for everybody at once.
	 *
	 * On relays nothing by itself: every grant starts unticked, so the switch is
	 * the one place all of it can be stopped without finding each person.
	 */
	setEmbyRelay: (on: boolean) =>
		call<Watching>("/settings", { method: "PUT", body: JSON.stringify({ embyRelay: on }) }),

	/**
	 * Turn the YouTube relay on or off for everybody at once.
	 *
	 * Sent on its own, as the Emby switch is: the server changes only the
	 * switch a request names, so moving one never resets the other.
	 */
	setYouTubeRelay: (on: boolean) =>
		call<Watching>("/settings", { method: "PUT", body: JSON.stringify({ youtubeRelay: on }) }),

	/**
	 * Turn the bangumi relay on or off for everybody at once. Sent on its own,
	 * as the other two are.
	 */
	setBangumiRelay: (on: boolean) =>
		call<Watching>("/settings", { method: "PUT", body: JSON.stringify({ bangumiRelay: on }) }),

	setPolicy: (openedBy: Opening) =>
		call<Policy>("/policy", { method: "PUT", body: JSON.stringify({ openedBy }) }),

	/**
	 * Sent on its own, so that changing one door does not quietly reset the
	 * other — the server takes whichever half the request carries.
	 */
	setJoining: (joinedBy: Joining) =>
		call<Policy>("/policy", { method: "PUT", body: JSON.stringify({ joinedBy }) }),

	relays: () => call<{ relays: Relay[] }>("/relays"),

	/**
	 * Ask one relay whether it is there.
	 *
	 * Reading the list measures every relay, which is what drawing the page
	 * needs and is not what a button on one row means. It used to be both: the
	 * row's button re-read the list, so asking after the machine somebody had
	 * just restarted dialled the whole fleet and took as long as the slowest
	 * one — which, where a relay is genuinely down, is its full timeout, on
	 * every press, about a machine that is not the one in question.
	 *
	 * The reply is a row in the shape the list sends, so what comes back can go
	 * where the old reading was rather than being reconciled with it.
	 */
	checkRelay: (name: string) => call<Relay>(`/relays/${encodeURIComponent(name)}/check`),

	addRelay: (relay: { name: string; url: string; region?: string; enabled?: boolean }) =>
		call<{ added: string }>("/relays", { method: "POST", body: JSON.stringify(relay) }),

	editRelay: (
		name: string,
		change: {
			name?: string;
			url?: string;
			region?: string;
			enabled?: boolean;
			label?: string;
			probe?: string;
			turn?: string;
			forwards?: boolean;
			apart?: string[];
			bridge?: boolean;
			signalVia?: string;
			fallback?: boolean;
			adminOnly?: boolean;
			lat?: number;
			lon?: number;
		},
	) =>
		call<{ updated: string }>(`/relays/${encodeURIComponent(name)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),

	// Text rather than JSON: it is a shell script, and it carries the enrolment
	// secret, which is why it is behind the same session as everything else here.
	relayScript: async (): Promise<string> => {
		const response = await fetch("/api/admin/relays/script", { credentials: "same-origin" });
		if (!response.ok) throw new Error(String(response.status));
		return response.text();
	},

	/**
	 * The one line to type on the new machine.
	 *
	 * Separate from the script rather than derived from it in the page, because
	 * the address and the secret are the server's to know: composing the command
	 * here would mean the client holding a second, quietly diverging idea of
	 * where this deployment lives.
	 */
	/**
	 * Everybody who may open these pages.
	 *
	 * The signature is the key and the whole of the identity. No passphrase
	 * travels here in either direction: this server is never told one, which is
	 * what makes a signature safe to send over a chat message.
	 */
	admins: () => call<Administrator[]>("/admins"),

	addAdmin: (admin: {
		trip: string;
		name: string;
		can: string[];
		perms?: Record<string, boolean>;
	}) => call<{ added: string }>("/admins", { method: "POST", body: JSON.stringify(admin) }),

	/**
	 * Change whichever was sent.
	 *
	 * Each is optional and the server leaves an absent one alone. It used to
	 * take the name and the role together and rebuild the record from them, so
	 * a page renaming somebody had to send their role back — the expanded list,
	 * which named four capabilities nobody had granted.
	 *
	 * `can` is the whole role, written as sent: what the role control means.
	 * `caps` and `perms` are boxes, each laid over what the server holds, so a
	 * box pressed on a page drawn a minute ago changes that box and nothing the
	 * page drew beside it.
	 */
	changeAdmin: (
		trip: string,
		change: {
			name?: string;
			can?: string[];
			caps?: Record<string, boolean>;
			perms?: Record<string, boolean>;
		},
	) =>
		call<{ changed: string }>(`/admins/${encodeURIComponent(trip)}`, {
			method: "PATCH",
			body: JSON.stringify(change),
		}),

	/**
	 * Change your own passphrase.
	 *
	 * The current one is sent as well as the new one, even though the session
	 * already says who this is. A session proves somebody signed in; this asks
	 * whether the person at the keyboard now is that person, which is exactly
	 * the question an unattended laptop raises.
	 */
	changePassphrase: (current: string, next: string) =>
		call<{ trip: string }>("/admins/me/passphrase", {
			method: "POST",
			body: JSON.stringify({ current, next }),
		}),

	dropAdmin: (trip: string) =>
		call<{ removed: string }>(`/admins/${encodeURIComponent(trip)}`, { method: "DELETE" }),

	/**
	 * Put the relays in a chosen order.
	 *
	 * The whole list rather than one move at a time: two administrators each
	 * pressing an arrow would otherwise interleave into an order neither chose.
	 */
	reorderRelays: (names: string[]) =>
		call<{ ordered: number }>("/relays/order", {
			method: "PUT",
			body: JSON.stringify({ names }),
		}),

	/** Everybody who has an account here. */
	accounts: () => call<Account[]>("/accounts"),

	/**
	 * Make one.
	 *
	 * The passphrase goes up and is turned into a signature there; it is not
	 * stored and cannot be read back, which is why the page shows it once and
	 * says so.
	 */
	addAccount: (name: string, passphrase: string, perms?: Record<string, boolean>) =>
		call<{ name: string; trip: string }>("/accounts", {
			method: "POST",
			body: JSON.stringify({ name, passphrase, perms }),
		}),

	/**
	 * Change part of an account.
	 *
	 * Permissions go as the boxes that were pressed, and the server lays them
	 * over what it holds; one not named is left as it is. Scopes go whole and
	 * replace what was there, since they are edited as one line.
	 */
	changeAccount: (
		name: string,
		change: {
			name?: string;
			passphrase?: string;
			blocked?: boolean;
			note?: string;
			scopes?: string[];
			perms?: Record<string, boolean>;
		},
	) =>
		call<{ name: string; trip: string; effective?: Record<string, boolean> }>(
			`/accounts/${encodeURIComponent(name)}`,
			{
				method: "PATCH",
				body: JSON.stringify(change),
			},
		),

	dropAccount: (name: string) =>
		call<{ removed: string }>(`/accounts/${encodeURIComponent(name)}`, { method: "DELETE" }),

	relayCommand: () => call<{ command: string; domain: string; port: number }>("/relays/command"),

	dropRelay: (name: string) =>
		call<{ removed: string }>(`/relays/${encodeURIComponent(name)}`, { method: "DELETE" }),

	closeRoom: (room: string) => call<void>(`/rooms/${encodeURIComponent(room)}`, { method: "DELETE" }),
	remove: (room: string, identity: string) =>
		call<void>(`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}`, {
			method: "DELETE",
		}),
	mute: (room: string, identity: string, track: string) =>
		call<void>(
			`/rooms/${encodeURIComponent(room)}/participants/${encodeURIComponent(identity)}/mute`,
			{ method: "POST", body: JSON.stringify({ track }) },
		),
};
