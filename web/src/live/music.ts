/**
 * The music library: searching it, and what a track's audio is.
 *
 * Served by the server at /api/music/*, which passes signed-in people's
 * requests on to a gateway the deployment runs; see internal/app/music.go. The
 * client never learns where the library is or what is behind it, and a
 * deployment without one answers 404, which reads here as "no library".
 */

export interface Library {
	id: string;
	name: string;
	/** Whether the library is signed in. Signed out, it plays at most 320 kbit/s. */
	signedIn: boolean;
}

export interface LibraryTrack {
	id: string;
	title: string;
	artists: string[];
	album: string;
	cover: string;
	/** Seconds. */
	duration: number;
}

/** What a track's audio is, read off the file by the library. */
export interface TrackAudio {
	format: string;
	/** Samples a second; nought where the library could not tell. */
	rate: number;
	channels: number;
	bits: number;
	/** "master", "hires", "lossless", "320k", "128k". */
	tier: string;
}

/** Best is the highest tier the library's account may have. */
export type Quality = "best" | "lossless" | "lossy";

/** Thrown when the library did not answer as a library answers. */
export class LibraryFailed extends Error {
	constructor(readonly status: number) {
		super(`the library answered ${status}`);
		this.name = "LibraryFailed";
	}
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The libraries there are, or undefined where there is none or nobody signed in. */
export async function libraries(): Promise<Library[] | undefined> {
	try {
		const response = await fetch("/api/music/sources", { credentials: "same-origin" });
		if (!response.ok) return undefined;

		const body = (await response.json()) as { sources?: unknown };
		if (!Array.isArray(body.sources)) return undefined;

		const found = body.sources
			.map((one: Record<string, unknown>) => ({
				id: text(one.id),
				name: text(one.name),
				signedIn: one.signedIn === true,
			}))
			.filter((one) => one.id && one.name);

		return found.length > 0 ? found : undefined;
	} catch {
		return undefined;
	}
}

export async function searchLibrary(source: string, query: string, page = 1): Promise<LibraryTrack[]> {
	const params = new URLSearchParams({ source, q: query, page: String(page) });
	const response = await fetch(`/api/music/search?${params}`, { credentials: "same-origin" });
	if (!response.ok) throw new LibraryFailed(response.status);

	const body = (await response.json()) as { tracks?: unknown };
	if (!Array.isArray(body.tracks)) return [];

	return body.tracks
		.map((one: Record<string, unknown>) => ({
			id: text(one.id),
			title: text(one.title),
			artists: Array.isArray(one.artists) ? one.artists.map(text).filter(Boolean) : [],
			album: text(one.album),
			cover: text(one.cover),
			duration: count(one.duration),
		}))
		.filter((one) => one.id && one.title);
}

/** What a track's audio is, or "unavailable" where this library's account may not play it. */
export async function describeTrack(
	source: string,
	id: string,
	quality: Quality = "best",
	signal?: AbortSignal,
): Promise<TrackAudio | "unavailable"> {
	const params = new URLSearchParams({ source, id, quality });
	const response = await fetch(`/api/music/track?${params}`, { credentials: "same-origin", signal });
	if (response.status === 404) return "unavailable";
	if (!response.ok) throw new LibraryFailed(response.status);

	const body = (await response.json()) as Record<string, unknown>;
	return {
		format: text(body.format),
		rate: count(body.rate),
		channels: count(body.channels) || 2,
		bits: count(body.bits),
		tier: text(body.tier),
	};
}

/** What a pasted link names: a playlist or a song, and its tracks. */
export interface Linked {
	source: string;
	kind: "playlist" | "song";
	title: string;
	tracks: LibraryTrack[];
}

/**
 * Read a playlist or song link, pasted as somebody shared it -- a bare address
 * or the sentence a music app wraps around one. Undefined for anything that is
 * not one.
 */
export async function readLink(pasted: string): Promise<Linked | undefined> {
	const params = new URLSearchParams({ text: pasted.slice(0, 2000) });
	const response = await fetch(`/api/music/link?${params}`, { credentials: "same-origin" });
	if (response.status === 404) return undefined;
	if (!response.ok) throw new LibraryFailed(response.status);

	const body = (await response.json()) as Record<string, unknown>;
	const tracks = Array.isArray(body.tracks)
		? body.tracks
				.map((one: Record<string, unknown>) => ({
					id: text(one.id),
					title: text(one.title),
					artists: Array.isArray(one.artists) ? one.artists.map(text).filter(Boolean) : [],
					album: text(one.album),
					cover: text(one.cover),
					duration: count(one.duration),
				}))
				.filter((one) => one.id && one.title)
		: [];

	return {
		source: text(body.source),
		kind: body.kind === "song" ? "song" : "playlist",
		title: text(body.title),
		tracks,
	};
}

/** Where the audio of a track is played from. Same origin, so the page may read it. */
export function audioUrl(source: string, id: string, quality: Quality = "best"): string {
	return `/api/music/audio?${new URLSearchParams({ source, id, quality })}`;
}

/** "FLAC · 24-bit · 44.1 kHz", or "MP3 · 320 kbps": what is actually being played. */
export function describeAudio(audio: TrackAudio): string {
	const format = audio.format.toUpperCase();
	if (audio.format !== "flac") return audio.tier.endsWith("k") ? `${format} · ${audio.tier.replace("k", " kbps")}` : format;

	const rate = audio.rate ? `${(audio.rate / 1000).toFixed(audio.rate % 1000 === 0 ? 0 : 1)} kHz` : "";
	return [format, audio.bits ? `${audio.bits}-bit` : "", rate].filter(Boolean).join(" · ");
}

/** Minutes and seconds. */
export function clock(seconds: number): string {
	const whole = Math.max(0, Math.round(seconds));
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
