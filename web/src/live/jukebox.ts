import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import type { Library, LibraryTrack, Quality, TrackAudio } from "./music";
import type { Decoded, LibraryAudio, NowPlaying } from "./sound";

/**
 * The song desk: a queue the whole call can add to, played into the call by
 * one person's browser.
 *
 * Somebody who can reach the music library runs it -- holds the queue, fetches
 * and plays each track, losslessly, through the same output a single track
 * plays through -- and everybody else sees what is playing and what is next,
 * and adds to it: a track they found, a keyword the desk searches for them, a
 * playlist or song link as it was shared. A song ends and the next one plays on
 * the same stream where it can; anybody may vote to skip, and a majority of the
 * others listening skips it. The model is the Chinese "song request desk" the
 * open-source Jusic made familiar, kept to what a call needs.
 *
 * Everything travels as data, so in an encrypted call -- where this project's
 * SDK options do not encrypt data -- the desk runs for its holder alone and says
 * nothing to the room: what is being listened to is not something the relay is
 * told in a call whose promise is that it hears nothing.
 */

export const TOPIC = "jukebox";

/** One song in the queue, and who asked for it. */
export interface Entry {
	/** Distinct per addition, so the same song twice is two entries. */
	key: string;
	source: string;
	id: string;
	title: string;
	artists: string[];
	album: string;
	cover: string;
	duration: number;
	/** The display name of whoever added it. */
	by: string;
}

export interface DeskState {
	holder: string;
	holderName: string;
	now?: Entry;
	queue: Entry[];
	/** Who has voted to skip what is playing. */
	votes: string[];
	/** How many votes skip it. */
	needed: number;
	/** The next song is being fetched. */
	loading: boolean;
	/** Which: off the queue already, and not playing yet. */
	next?: Entry;
	/** What is playing is paused, by whoever runs the desk. */
	paused: boolean;
	/** What is playing actually is: "FLAC · 24-bit · 44.1 kHz". */
	quality?: string;
}

type Song = Omit<Entry, "key" | "by">;

type Message =
	| { t: "state"; state: DeskState }
	| { t: "add"; songs: Song[] }
	| { t: "request"; query: string }
	| { t: "link"; text: string }
	| { t: "vote" }
	| { t: "hello" };

/** What the desk needs from the library and the player; a seam for the tests. */
export interface DeskDeps {
	libraries: () => Library[];
	search: (source: string, query: string) => Promise<LibraryTrack[]>;
	readLink: (text: string) => Promise<{ source: string; tracks: LibraryTrack[] } | undefined>;
	describe: (source: string, id: string, quality: Quality, signal?: AbortSignal) => Promise<TrackAudio | "unavailable">;
	audioUrl: (source: string, id: string, quality: Quality) => string;
	fetchTrack: (audio: LibraryAudio, signal: AbortSignal, onProgress: (fraction: number) => void) => Promise<Decoded>;
	play: (decoded: Decoded, onEnded: () => void) => Promise<void>;
	stop: () => Promise<void>;
	pause: (paused: boolean) => void;
	describeAudio: (audio: TrackAudio) => string;
	quality: () => Quality;
	/** A track was skipped because it could not be played. */
	onSkipped: (entry: Entry) => void;
	/** How far the track about to play has arrived. */
	onProgress: (fraction: number) => void;
}

let counter = 0;
const newKey = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

function song(track: LibraryTrack, source: string): Song {
	return {
		source,
		id: track.id,
		title: track.title,
		artists: track.artists,
		album: track.album,
		cover: track.cover,
		duration: track.duration,
	};
}

/** The desk, as run by its holder. */
export class Desk {
	private queue: Entry[] = [];
	private now?: Entry;
	private quality?: string;
	private paused = false;
	private votes = new Set<string>();
	private ahead?: { key: string; abort: AbortController; result: Promise<Decoded | "unavailable"> };
	/** The song being fetched to play next, and how to abandon it. */
	private fetching?: { entry: Entry; abort: AbortController };
	private starting = false;
	private closed = false;
	private listeners = new Set<() => void>();
	private timer?: ReturnType<typeof setInterval>;
	/** The state as last built, kept until something changes: the same object each time it is asked for. */
	private cached?: DeskState;

	constructor(
		private readonly room: Room,
		private readonly deps: DeskDeps,
		/** Whether to tell the room; false in an encrypted call. */
		private readonly broadcast: boolean,
	) {
		if (broadcast) {
			room.on(RoomEvent.DataReceived, this.onData);
			room.on(RoomEvent.ParticipantConnected, this.announce);
			room.on(RoomEvent.ParticipantDisconnected, this.onLeft);
			// Again now and then, for anybody whose copy went stale.
			this.timer = setInterval(this.announce, 15_000);
		}
		this.announce();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	state(): DeskState {
		this.cached ??= {
			holder: this.room.localParticipant.identity,
			holderName: this.room.localParticipant.name || "",
			now: this.now,
			queue: [...this.queue],
			votes: [...this.votes],
			needed: this.needed(),
			loading: this.starting,
			next: this.fetching?.entry,
			paused: this.now !== undefined && this.paused,
			quality: this.now ? this.quality : undefined,
		};
		return this.cached;
	}

	/** Add songs, by whoever is named; playing starts if nothing is. */
	add(songs: Song[], by: string): void {
		if (this.closed || songs.length === 0) return;
		for (const one of songs.slice(0, 500)) this.queue.push({ ...one, key: newKey(), by });
		this.changed();
		if (!this.now && !this.starting) void this.next();
		else this.prefetch();
	}

	/** The top result for a keyword, from the first library signed in. */
	async request(query: string, by: string): Promise<boolean> {
		const library = this.deps.libraries().find((one) => one.signedIn) ?? this.deps.libraries()[0];
		const asked = query.trim().slice(0, 100);
		if (!library || !asked) return false;
		const [top] = await this.deps.search(library.id, asked);
		if (!top) return false;
		this.add([song(top, library.id)], by);
		return true;
	}

	/** Every song a shared playlist or song link names. */
	async link(text: string, by: string): Promise<number> {
		const found = await this.deps.readLink(text.slice(0, 2000));
		if (!found) return 0;
		this.add(
			found.tracks.map((track) => song(track, found.source)),
			by,
		);
		return found.tracks.length;
	}

	vote(identity: string): void {
		// Not while the next song is on its way. What everybody still sees then
		// is the song already being skipped, and a vote against it would skip
		// the one coming as well.
		if (!this.now || this.starting) return;
		this.votes.add(identity);
		if (this.votes.size >= this.needed()) void this.next();
		else this.changed();
	}

	skip(): void {
		void this.next();
	}

	/** Pause what is playing, or go on with it. The next song plays unpaused. */
	pause(paused: boolean): void {
		if (!this.now || this.paused === paused) return;
		this.paused = paused;
		this.deps.pause(paused);
		this.changed();
	}

	remove(key: string): void {
		this.queue = this.queue.filter((one) => one.key !== key);
		if (this.ahead?.key === key) this.dropAhead();
		// The song already on its way to playing is taken out too: it was in
		// the list a moment ago, and taking it out has to mean it never plays.
		if (this.fetching?.entry.key === key) this.fetching.abort.abort();
		this.changed();
		this.prefetch();
	}

	toTop(key: string): void {
		const found = this.queue.find((one) => one.key === key);
		if (!found) return;
		this.queue = [found, ...this.queue.filter((one) => one.key !== key)];
		this.changed();
		this.prefetch();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.dropAhead();
		this.fetching?.abort.abort();
		this.queue = [];
		this.now = undefined;
		if (this.timer) clearInterval(this.timer);
		this.room.off(RoomEvent.DataReceived, this.onData);
		this.room.off(RoomEvent.ParticipantConnected, this.announce);
		this.room.off(RoomEvent.ParticipantDisconnected, this.onLeft);
		this.say({ t: "closed" });
		await this.deps.stop();
		this.changed();
	}

	/** A majority of everybody else listening. */
	private needed(): number {
		return Math.max(1, Math.ceil(this.room.remoteParticipants.size / 2));
	}

	private async next(): Promise<void> {
		if (this.closed) return;

		// One at a time. Asked again while a song is on its way -- a second
		// press, or a skip voted through -- it is that song that is skipped:
		// abandoned, and the one after fetched in its place. Before, this did
		// nothing at all, and a song slow to arrive could not be got past.
		if (this.starting) {
			this.fetching?.abort.abort();
			return;
		}

		this.starting = true;
		this.votes.clear();

		try {
			for (;;) {
				const entry = this.queue.shift();
				if (!entry) {
					this.now = undefined;
					this.changed();
					await this.deps.stop();
					return;
				}

				// Said at once. The song left the queue here and the list on
				// everybody's screen did not change until it began to play, so it
				// sat at the top of the queue while it loaded, and taking it out
				// there took out nothing: it loaded and played regardless.
				const abort = new AbortController();
				this.fetching = { entry, abort };
				this.changed();

				const decoded = await this.decode(entry, abort.signal);
				if (this.closed) return;
				if (abort.signal.aborted || decoded === "unavailable") {
					this.fetching = undefined;
					if (decoded === "unavailable" && !abort.signal.aborted) this.deps.onSkipped(entry);
					continue;
				}

				// Still the song on its way while it is published, which waits on
				// the media server, and still to be abandoned there: taken out,
				// skipped or the desk put away, the music is stopped, and the play
				// that was setting up finds it so and undoes itself.
				const stopping = () => void this.deps.stop();
				abort.signal.addEventListener("abort", stopping);
				try {
					await this.deps.play(decoded, () => this.advance(entry.key));
				} catch {
					if (this.closed) return;
					if (!abort.signal.aborted) this.deps.onSkipped(entry);
					continue;
				} finally {
					abort.signal.removeEventListener("abort", stopping);
					this.fetching = undefined;
				}
				if (this.closed) return;

				this.now = entry;
				this.paused = false;
				this.quality = decoded.now?.quality;
				this.changed();
				this.prefetch();
				return;
			}
		} finally {
			this.starting = false;
			this.changed();
		}
	}

	/**
	 * The song playing ended by itself: on to the next, unless one is on its way
	 * already. Not next(), which takes being asked while a song loads as a
	 * second press and skips that one too: a song that ended while somebody's
	 * skip was loading the next took the next with it.
	 */
	private advance(key: string): void {
		if (this.starting || this.now?.key !== key) return;
		void this.next();
	}

	/** The next song in the queue, fetched and decoded while this one plays. */
	private prefetch(): void {
		const following = this.queue[0];
		if (!following || this.ahead?.key === following.key || this.closed) return;
		this.dropAhead();
		const abort = new AbortController();
		this.ahead = { key: following.key, abort, result: this.load(following, abort.signal, () => {}) };
		// Settled here so an unwatched failure is not reported as unhandled.
		this.ahead.result.catch(() => {});
	}

	private dropAhead(): void {
		this.ahead?.abort.abort();
		this.ahead = undefined;
	}

	private async decode(entry: Entry, signal: AbortSignal): Promise<Decoded | "unavailable"> {
		if (this.ahead?.key === entry.key) {
			const ahead = this.ahead;
			this.ahead = undefined;
			signal.addEventListener("abort", () => ahead.abort.abort(), { once: true });
			try {
				return await ahead.result;
			} catch {
				// Fetched ahead and failed; try once more now, unless abandoned.
				if (signal.aborted) return "unavailable";
			}
		}
		try {
			return await this.load(entry, signal, this.deps.onProgress);
		} catch {
			return "unavailable";
		}
	}

	private async load(entry: Entry, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<Decoded | "unavailable"> {
		const quality = this.deps.quality();
		const audio = await this.deps.describe(entry.source, entry.id, quality, signal);
		if (audio === "unavailable") return "unavailable";

		const now: NowPlaying = { title: entry.title, artists: entry.artists.join(" / "), quality: this.deps.describeAudio(audio) };
		return this.deps.fetchTrack(
			{ url: this.deps.audioUrl(entry.source, entry.id, quality), rate: audio.rate, format: audio.format, bits: audio.bits, now },
			signal,
			onProgress,
		);
	}

	private changed(): void {
		this.cached = undefined;
		this.announce();
		for (const listener of this.listeners) listener();
	}

	private readonly announce = (): void => {
		// Nothing after the word that it closed: a state sent behind it -- the
		// listeners are told the desk changed as it closes -- would have
		// everybody believe in it again until it went stale.
		if (this.closed) return;
		this.say({ t: "state", state: this.state() });
	};

	private say(message: Message | { t: "closed" }): void {
		if (!this.broadcast) return;
		void this.room.localParticipant
			.publishData(new TextEncoder().encode(JSON.stringify(message)), { reliable: true, topic: TOPIC })
			.catch(() => {});
	}

	private readonly onLeft = (participant: RemoteParticipant): void => {
		// The majority is of whoever is still here.
		this.votes.delete(participant.identity);
		this.changed();
	};

	private readonly onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		if (topic !== TOPIC || !participant || this.closed) return;
		const message = parse(payload);
		if (!message) return;
		const by = participant.name || participant.identity;

		switch (message.t) {
			case "add":
				this.add(message.songs.filter(validSong).slice(0, 500), by);
				return;
			case "request":
				void this.request(String(message.query), by);
				return;
			case "link":
				void this.link(String(message.text), by);
				return;
			case "vote":
				this.vote(participant.identity);
				return;
			case "hello":
				this.announce();
				return;
		}
	};
}

function parse(payload: Uint8Array): Message | { t: "closed" } | undefined {
	try {
		const value = JSON.parse(new TextDecoder().decode(payload)) as { t?: unknown };
		return typeof value?.t === "string" ? (value as Message) : undefined;
	} catch {
		return undefined;
	}
}

function validSong(value: unknown): value is Song {
	const one = value as Record<string, unknown>;
	return (
		typeof one?.source === "string" &&
		typeof one.id === "string" &&
		typeof one.title === "string" &&
		one.id.length > 0 &&
		one.id.length < 64 &&
		Array.isArray(one.artists)
	);
}

/*
 * Everybody else: the desk as heard from its holder.
 */

/** How long a desk that has said nothing is believed to still exist. */
const STALE_MS = 45_000;

interface Heard {
	state: DeskState;
	at: number;
}

const desks = new WeakMap<Room, Desk>();
const heard = new WeakMap<Room, Heard>();
const watchers = new Set<() => void>();

function notify(): void {
	for (const watcher of watchers) watcher();
}

/** The desk this browser runs in a room, if it runs one. */
export function myDesk(room: Room): Desk | undefined {
	return desks.get(room);
}

/** The desk in a room, as far as this browser knows: its own, or one it heard. */
export function deskState(room: Room): DeskState | undefined {
	const mine = desks.get(room);
	if (mine) return mine.state();

	const last = heard.get(room);
	if (!last) return undefined;
	if (Date.now() - last.at > STALE_MS || !room.remoteParticipants.has(last.state.holder)) return undefined;
	return last.state;
}

export function subscribeDesk(listener: () => void): () => void {
	watchers.add(listener);
	return () => watchers.delete(listener);
}

/** Start running the desk here. Refused while another is heard. */
export function startDesk(room: Room, deps: DeskDeps, broadcast: boolean): Desk | undefined {
	const existing = desks.get(room);
	if (existing) return existing;
	if (deskState(room)) return undefined;

	const desk = new Desk(room, deps, broadcast);
	desks.set(room, desk);
	desk.subscribe(notify);
	notify();
	return desk;
}

export async function closeDesk(room: Room): Promise<void> {
	const desk = desks.get(room);
	if (!desk) return;
	desks.delete(room);
	await desk.close();
	notify();
}

/** Send something to whoever holds the desk. */
function tell(room: Room, message: Message): boolean {
	const state = deskState(room);
	if (!state || desks.has(room)) return false;
	void room.localParticipant
		.publishData(new TextEncoder().encode(JSON.stringify(message)), {
			reliable: true,
			topic: TOPIC,
			destinationIdentities: [state.holder],
		})
		.catch(() => {});
	return true;
}

/** Add songs to the room's desk: this browser's own, or the one heard. */
export function addToDesk(room: Room, songs: Song[], by: string): boolean {
	const mine = desks.get(room);
	if (mine) {
		mine.add(songs, by);
		return true;
	}
	return tell(room, { t: "add", songs });
}

export function requestSong(room: Room, query: string): boolean {
	return tell(room, { t: "request", query: query.slice(0, 100) });
}

export function sendLink(room: Room, text: string): boolean {
	return tell(room, { t: "link", text: text.slice(0, 2000) });
}

export function voteToSkip(room: Room): boolean {
	const mine = desks.get(room);
	if (mine) {
		mine.skip();
		return true;
	}
	return tell(room, { t: "vote" });
}

/**
 * Listen for a desk run elsewhere in a room. Returns the function that stops.
 *
 * Asks once on arrival, so somebody joining a call with music already playing
 * sees the queue without waiting for the desk's next announcement.
 */
export function hearDesks(room: Room, broadcast: boolean): () => void {
	if (!broadcast) return () => {};

	const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
		if (topic !== TOPIC || !participant || desks.has(room)) return;
		const message = parse(payload);
		if (message?.t === "state" && message.state?.holder === participant.identity) {
			heard.set(room, { state: { ...message.state, holderName: participant.name || message.state.holderName }, at: Date.now() });
			notify();
		} else if (message?.t === "closed" && heard.get(room)?.state.holder === participant.identity) {
			heard.delete(room);
			notify();
		}
	};

	const onLeft = (participant: RemoteParticipant) => {
		if (heard.get(room)?.state.holder === participant.identity) {
			heard.delete(room);
			notify();
		}
	};

	room.on(RoomEvent.DataReceived, onData);
	room.on(RoomEvent.ParticipantDisconnected, onLeft);
	void room.localParticipant
		.publishData(new TextEncoder().encode(JSON.stringify({ t: "hello" })), { reliable: true, topic: TOPIC })
		.catch(() => {});

	return () => {
		room.off(RoomEvent.DataReceived, onData);
		room.off(RoomEvent.ParticipantDisconnected, onLeft);
	};
}

export { song as songFrom };
