/**
 * The watch gateway, as the client sees it: whether there is one, and what a
 * pasted link plays.
 *
 * Served by the server at /api/watch/*, which passes the request on to a
 * gateway the deployment runs; see internal/app/watch.go. A deployment without
 * one answers 404, which reads here as "no watching together".
 */

/** How a video plays from where it is. */
export interface Playable {
	/**
	 * A file a video element plays, an HLS playlist, a YouTube video by its id,
	 * or nothing but the relay: a media server's film, whose every address
	 * carries the deployment's account, which no viewer is given; or one of
	 * Bilibili's bangumi episodes, whose whole -- and anything above 720p --
	 * Bilibili hands only to a request carrying its own Referer, which no page
	 * can send.
	 */
	kind: "file" | "hls" | "youtube" | "relay" | "bangumi";
	url?: string;
	id?: string;
}

/**
 * Whether a video plays only through the relay: from nowhere a viewer could
 * reach it themselves, so with no relay it plays nowhere, and with one every
 * viewer plays it there from the start rather than falling back to it.
 */
export const relayOnly = (play: Playable) => play.kind === "relay" || play.kind === "bangumi";

/** What a link plays, as the gateway read it. */
export interface Resolved {
	/**
	 * The name the gateway filed it under, and the only thing about it a call
	 * passes around: everybody turns it back into the rest by asking the
	 * server (see videoInfo), so nobody in the call can tell everybody else's
	 * browser to fetch an address of their own.
	 */
	ticket: string;
	title: string;
	/** Seconds; nought where nobody could tell, or for something live. */
	duration: number;
	cover: string;
	/** The link as it was understood, for anybody who wants to open it themselves. */
	link: string;
	live: boolean;
	/**
	 * Played through the relay from the start, and from where it is only if the
	 * relay fails: for a video whose better qualities come only that way -- a
	 * site that hands them only to its own pages -- the relayed copy is the one
	 * worth watching, and the one from where it is a lower quality to fall back on.
	 */
	relay: boolean;
	/** Played from where it is, by whoever can reach it. */
	play: Playable;
	/**
	 * The same, relayed by the deployment, for whoever cannot. Same origin.
	 * None on a deployment that relays nothing: there, a viewer who cannot
	 * reach the video does not see it.
	 */
	proxy?: { kind: "file" | "hls"; url: string };
	/**
	 * Whose grant a media server's film is relayed under, by signature, as the
	 * server says it (X-Watch-Grantor, internal/app/watch.go). Absent for
	 * anything else. What the holder of a show checks a handed-over ticket
	 * against; see Theatre.addTicket.
	 */
	grantor?: string;
}

/**
 * What an answer says about a video this deployment will not relay; see
 * internal/app/watch.go. Read off each answer rather than once for the page,
 * because on a deployment that relays nothing else it is still left off one
 * kind of answer: a film from a media server that somebody given the grant
 * chose, which plays only through the relay.
 */
const relaysNothing = (response: Response) => response.headers.get("X-Watch-Relay") === "off";

/**
 * The grantor an answer names, laid onto what was read from it.
 *
 * Kept as said, within reason, rather than checked for the shape of a
 * signature: it is compared, never shown or fetched, and one that did not look
 * like a signature and were dropped for it would leave a relayed film with no
 * grantor to check — which is the shape of a film anybody may hand over.
 */
function withGrantor(read: Resolved, response: Response): Resolved {
	const grantor = response.headers.get("X-Watch-Grantor")?.trim().slice(0, 64);
	return grantor ? { ...read, grantor } : read;
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Whether this deployment can watch together, for this person. */
export async function watchReady(): Promise<boolean> {
	try {
		const response = await fetch("/api/watch/ready", { credentials: "same-origin" });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Read a resolved video defensively: it came from a gateway the client never
 * sees. Without `relays`, what the deployment would have relayed is left out --
 * the relayed copy, and a poster that comes only through the relay -- and a
 * source that plays only through it is nothing at all.
 */
export function readResolved(body: Record<string, unknown>, relays = true): Resolved | undefined {
	const play = (body.play ?? {}) as Record<string, unknown>;
	const proxy = (body.proxy ?? {}) as Record<string, unknown>;
	const kind = text(play.kind);
	const proxyKind = text(proxy.kind);

	if (kind !== "file" && kind !== "hls" && kind !== "youtube" && kind !== "relay" && kind !== "bangumi") return undefined;
	if (proxyKind !== "file" && proxyKind !== "hls") return undefined;
	const ticket = text(body.ticket);
	if (!TICKET.test(ticket)) return undefined;
	// The ticket's own relay on this server and nothing else: an address the
	// gateway named anywhere would be one this page fetched for it.
	if (text(proxy.url) !== `media?t=${ticket}`) return undefined;
	if (kind === "youtube" && !/^[\w-]{11}$/.test(text(play.id))) return undefined;
	if ((kind === "file" || kind === "hls") && !/^https?:\/\//.test(text(play.url))) return undefined;
	if (relayOnly({ kind }) && !relays) return undefined;
	// A picture from the relay -- a media server's poster, fetched with the
	// deployment's account -- or one on the open web; nothing else.
	const cover = text(body.cover);
	const relayedCover = relays && RELAYED.test(cover) ? `/api/watch/${cover}` : "";

	return {
		ticket,
		title: text(body.title).slice(0, 300),
		duration: count(body.duration),
		cover: relayedCover || (/^https:\/\//.test(cover) ? cover : ""),
		link: text(body.link),
		live: body.live === true,
		relay: relays && body.relay === true,
		play: kind === "youtube" ? { kind, id: text(play.id) } : relayOnly({ kind }) ? { kind } : { kind, url: text(play.url) },
		proxy: relays ? { kind: proxyKind, url: `/api/watch/media?t=${ticket}` } : undefined,
	};
}

/** What a ticket looks like: what the gateway issues, and nothing longer. */
export const TICKET = /^[\w-]{16,64}$/;

/** A relayed address, relative to /api/watch/: a ticket's media, and nothing else. */
const RELAYED = /^media\?t=[\w-]{16,64}$/;

/*
 * The media servers the deployment has an account on: browsed and searched by
 * somebody given them, choosing what everybody will watch.
 */

export interface MediaServer {
	key: string;
	name: string;
}

export interface MediaItem {
	id: string;
	name: string;
	type: string;
	/** Something to open: a library, a folder, a series, a season. */
	folder: boolean;
	/** Something to watch. */
	playable: boolean;
	year: number;
	duration: number;
	/** The poster, from this server, or "". */
	image: string;
}

const IMAGE = /^library\?op=image&server=[\w-]+&id=[0-9a-fA-F]+&tag=[\w-]*$/;

function readItem(value: Record<string, unknown>): MediaItem | undefined {
	const id = text(value.id);
	if (!/^[0-9a-fA-F]{1,64}$/.test(id)) return undefined;
	const image = text(value.image);
	return {
		id,
		name: text(value.name).slice(0, 300),
		type: text(value.type),
		folder: value.folder === true,
		playable: value.playable === true,
		year: count(value.year),
		duration: count(value.duration),
		image: IMAGE.test(image) ? `/api/watch/${image}` : "",
	};
}

async function library(params: Record<string, string>): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await fetch(`/api/watch/library?${new URLSearchParams(params)}`, { credentials: "same-origin" });
		return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The media servers there are, for this person; none where there are none,
 * nobody is signed in, or this person was not given them -- the server answers
 * all three the same way as far as this page is concerned, with something that
 * is not a list.
 */
export async function mediaServers(): Promise<MediaServer[]> {
	const found = await library({ op: "servers" });
	if (!Array.isArray(found?.servers)) return [];
	return found.servers
		.map((one: Record<string, unknown>) => ({ key: text(one.key), name: text(one.name) }))
		.filter((one) => /^[\w-]+$/.test(one.key));
}

/** A server's libraries, or what is inside one of them; undefined where the server did not answer. */
export async function browseMedia(server: string, parent?: string): Promise<MediaItem[] | undefined> {
	const found = await library(parent ? { op: "items", server, parent } : { op: "views", server });
	if (!Array.isArray(found?.items)) return undefined;
	return found.items.map(readItem).filter((one): one is MediaItem => one !== undefined);
}

export async function searchMedia(server: string, words: string): Promise<MediaItem[] | undefined> {
	const found = await library({ op: "search", server, q: words.slice(0, 100) });
	if (!Array.isArray(found?.items)) return undefined;
	return found.items.map(readItem).filter((one): one is MediaItem => one !== undefined);
}

/** What to resolve to play one item from one server. */
export function mediaLink(server: string, item: string): string {
	return `library:${server}/${item}`;
}

/*
 * What each ticket plays, as this page has learned it: asked of the server once
 * per ticket and kept for the life of the page, and filled straight in for the
 * person who resolved it.
 */

/**
 * A ticket that read as nothing: "failed" where it could not be read at all --
 * expired, refused, not a ticket -- and "unavailable" where it was read and
 * plays only through a relay the server said this deployment will not run for
 * it (X-Watch-Relay: off on a media server's film or a bangumi episode). Told
 * apart because they are different things to say: "could not be read, try
 * again" sent somebody retrying a video that the switch on the management pages
 * had turned off, and that no retry would play.
 */
export type Unread = "failed" | "unavailable";

const infos = new Map<string, Resolved | Unread>();
const asking = new Set<string>();
const infoListeners = new Set<() => void>();

function infoChanged(): void {
	for (const listener of infoListeners) listener();
}

export function subscribeInfo(listener: () => void): () => void {
	infoListeners.add(listener);
	return () => infoListeners.delete(listener);
}

/** What a ticket plays, if this page knows yet; asks the server once if not. */
export function videoInfo(ticket: string): Resolved | Unread | undefined {
	const known = infos.get(ticket);
	if (known !== undefined || asking.has(ticket) || !TICKET.test(ticket)) return known;

	asking.add(ticket);
	void readInfo(ticket)
		.then((found) => infos.set(ticket, found))
		.finally(() => {
			asking.delete(ticket);
			infoChanged();
		});
	return undefined;
}

/** What the server says a ticket plays, now. */
async function readInfo(ticket: string): Promise<Resolved | Unread> {
	try {
		const response = await fetch(`/api/watch/info?${new URLSearchParams({ t: ticket })}`, {
			credentials: "same-origin",
		});
		const body = response.ok ? ((await response.json()) as Record<string, unknown>) : undefined;
		const read = body && readResolved(body, !relaysNothing(response));
		// Read only as what it would be with a relay: a video that plays
		// nowhere else, on a ticket the server will not relay.
		const withheld = body && !read && relaysNothing(response) ? readResolved(body) : undefined;
		// Only the ticket asked about: an answer naming another is not this one.
		return read && read.ticket === ticket
			? withGrantor(read, response)
			: withheld && withheld.ticket === ticket
				? "unavailable"
				: "failed";
	} catch {
		return "failed";
	}
}

/**
 * What a ticket plays, asked of the server again: for a player whose relay
 * stopped partway through a video that plays nowhere else.
 *
 * The page otherwise asks once per ticket and keeps the answer, so a bangumi
 * episode whose switch was turned off mid-episode, or a film whose grant was
 * withdrawn, went on reading as playable here while every piece of it was
 * refused, and its viewers sat at the last frame with nothing said. Only that
 * answer -- the server will not relay it -- replaces what the page knew, and
 * the screen then says so in place of the player. Any other answer leaves
 * it alone: a ticket that still reads as playable is the player's to try
 * again, and one that could not be read this time, because the server or the
 * network faltered, is no reason to unlearn a video that was playing.
 */
export async function askAgain(ticket: string): Promise<Resolved | Unread> {
	if (!TICKET.test(ticket)) return "failed";
	const found = await readInfo(ticket);
	if (found === "unavailable") {
		infos.set(ticket, found);
		infoChanged();
	}
	return found;
}

/** What this page knows a ticket plays, without asking. */
export function knownInfo(ticket: string): Resolved | Unread | undefined {
	return infos.get(ticket);
}

/** What this page resolved itself, filled in so it is not asked for again. */
export function rememberInfo(found: Resolved): void {
	infos.set(found.ticket, found);
	infoChanged();
}

/**
 * What a ticket plays, once the server has said: the same question as
 * videoInfo, and the same answer kept for the page, waited for.
 *
 * Asked by whoever runs a show of a ticket somebody else resolved and handed
 * over (see Theatre.addTicket in watch.ts). The ticket is only a name the
 * gateway issued; what it plays, and whether this deployment relays it, is the
 * server's to say, and this is where it is said -- a media server's film the
 * server's ledger does not hold comes back without its relay and so reads as
 * unavailable, the way it would for every viewer.
 */
export function readTicket(ticket: string): Promise<Resolved | Unread> {
	if (!TICKET.test(ticket)) return Promise.resolve("failed");

	return new Promise((settle) => {
		const answered = (): boolean => {
			const known = videoInfo(ticket);
			if (known === undefined) return false;
			stop();
			settle(known);
			return true;
		};
		const stop = subscribeInfo(answered);
		answered();
	});
}

/** Why a link plays nothing here, as the server said it. */
export type Unresolved = "not_a_video" | "unavailable" | Withheld | "not_allowed" | "emby_not_allowed" | "failed";

/**
 * Why a video that was read cannot be played here, where the gateway can say
 * more than that it cannot. Today all of them are Bilibili's shows: a members'
 * episode, whose whole Bilibili hands only to its own player (a page elsewhere
 * is given a three-minute preview, whatever account asks); one under DRM; one
 * Bilibili does not offer in the region the deployment reads it from; and one
 * Bilibili answers is not there. That last is not "not_a_video": the link was
 * read as a show's, and the show is often there for whoever pasted it -- a
 * season offered only in Hong Kong, Macau and Taiwan may be answered from the
 * mainland as nothing at that number rather than refused by region -- so saying
 * the link was no video told somebody looking at the episode that it was not one.
 */
export type Withheld = "members_only" | "copy_protected" | "region_locked" | "not_found";

const WITHHELD: readonly Withheld[] = ["members_only", "copy_protected", "region_locked", "not_found"];

/**
 * A 422 read for its reason. Any other code, or none, is a video that cannot be
 * played here, which is all a 422 said before the gateway gave reasons and all
 * the server's own 422 says still.
 */
async function withheldBy(response: Response): Promise<Withheld | "unavailable"> {
	try {
		const { error } = (await response.json()) as { error?: unknown };
		return WITHHELD.find((reason) => reason === error) ?? "unavailable";
	} catch {
		return "unavailable";
	}
}

/**
 * The two refusals of a person rather than of a link, told apart by the code
 * the server sends with them: an account not given watching together at all,
 * and a film from a media server, which is relayed only for somebody given that
 * and only for what they chose themselves (see internal/app/may.go). Any other
 * 403 is nothing this page can explain, and reads as a failure.
 */
async function refusedBy(response: Response): Promise<"not_allowed" | "emby_not_allowed" | "failed"> {
	try {
		const { error } = (await response.json()) as { error?: unknown };
		return error === "not_allowed" || error === "emby_not_allowed" ? error : "failed";
	} catch {
		return "failed";
	}
}

/**
 * What a pasted link plays, or why it plays nothing.
 *
 * `forOther` is for whoever runs a show reading a link somebody else added.
 * It is said to the server because the server decides whether a film from a
 * media server is relayed by who chose it, and the browser asking is not always
 * theirs: a show reads every link pasted by somebody who cannot read one
 * themselves -- a guest -- with its holder's session. Unsaid, a guest pasting
 * a media server's address into a granted holder's show would be spending the
 * holder's grant; said, the server refuses such a film and everything else
 * reads as it always did.
 */
export async function resolveVideo(pasted: string, { forOther = false }: { forOther?: boolean } = {}): Promise<Resolved | Unresolved> {
	const params = new URLSearchParams({ url: pasted.slice(0, 2000) });
	if (forOther) params.set("for", "other");
	try {
		const response = await fetch(`/api/watch/resolve?${params}`, { credentials: "same-origin" });
		if (response.status === 404) return "not_a_video";
		if (response.status === 422) return await withheldBy(response);
		if (response.status === 403) return await refusedBy(response);
		if (!response.ok) return "failed";
		const body = (await response.json()) as Record<string, unknown>;
		const read = readResolved(body, !relaysNothing(response));
		// Read, and playable only through a relay this deployment does not run.
		if (!read && relaysNothing(response) && readResolved(body)) return "unavailable";
		return read ? withGrantor(read, response) : "failed";
	} catch {
		return "failed";
	}
}
