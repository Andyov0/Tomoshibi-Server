import { Track } from "livekit-client";
import { signatureOf } from "./name";
import { keep, recall } from "@/lib/storage";

/**
 * How loud everybody else is, and who is not to be heard at all.
 *
 * Held here rather than on the objects the media library already keeps it on,
 * and that is not a preference. Both of the library's own places forget:
 *
 *   - a volume lives in `RemoteParticipant.volumeMap`, and every remote
 *     participant is torn down and rebuilt on a full reconnect;
 *   - a block lives in `RemoteTrackPublication.requestedDisabled`, and a
 *     publication does not outlive the track it describes, so somebody stopping
 *     a share and starting it again comes back audible.
 *
 * Neither failure announces itself. The call carries on, the setting is simply
 * not there any more, and the person who set it finds out by hearing something
 * they had decided not to hear. So this is the record, and what the library
 * holds is treated as a cache of it that is re-filled whenever the room changes
 * underneath.
 */

/** One thing there is to hear from somebody. */
export type Sound = "voice" | "screen" | "music";

/** All of them, in the order a panel should list them. */
export const SOUNDS: readonly Sound[] = ["voice", "screen", "music"];

/**
 * The track each is carried on.
 *
 * The split the whole feature rests on, and it was already here: somebody
 * sharing a screen while their camera is on is two pictures in the layout and
 * two publications on the wire. Turning down their voice and turning down the
 * film they are playing are separate acts because they were always separate
 * tracks.
 */
export const SOURCE: Record<Sound, Track.Source.Microphone | Track.Source.ScreenShareAudio | Track.Source.Unknown> = {
	voice: Track.Source.Microphone,
	screen: Track.Source.ScreenShareAudio,
	// The song desk's music, on a source of its own so that it and a screen's
	// sound never take each other's place; see Channel in lossless.ts.
	music: Track.Source.Unknown,
};

/** The sound belonging to a picture. */
export function soundOf(kind: "camera" | "screen"): Sound {
	return kind === "screen" ? "screen" : "voice";
}

/** What somebody has decided about one sound. */
export interface Setting {
	/** Between silent and as loud as it was sent. */
	volume: number;
	/**
	 * Stopped at the media server rather than turned down here.
	 *
	 * The difference is bandwidth. A volume of nought still downloads every
	 * packet of a shared film and throws it away; this asks the server to stop
	 * sending, and it can be asked before the first byte arrives.
	 */
	blocked: boolean;
}

/** Untouched, which is what everybody is until somebody says otherwise. */
export const AS_SENT: Setting = { volume: 1, blocked: false };

/** Whether this is something somebody has decided not to hear. */
export function silenced(setting: Setting): boolean {
	return setting.blocked || setting.volume === 0;
}

/*
 * The keys below still say the name this was called before. Deliberate, and not
 * an oversight to tidy: renaming one abandons what every browser already has
 * written down.
 */
const STORED = "meet-live.hearing";

/** A setting, and whether the person it is about will be that person tomorrow. */
interface Held extends Setting {
	keeps: boolean;
}

/** Filed under `<who>/<sound>`. */
type Book = ReadonlyMap<string, Held>;

let book: Book = load();
const listeners = new Set<() => void>();

/**
 * Where a setting is filed, and whether it outlives the call.
 *
 * A proven signature is derived from a passphrase only its holder can produce,
 * so it is the same string on every visit — which is the whole of what makes it
 * worth writing down. Everybody else gets a fresh identity each time they open a
 * tab, and a setting kept against one of those would be a note about somebody
 * who no longer exists, applied to whoever happens to be issued that string
 * next.
 *
 * So a guest's setting lasts the call and no longer. Not a shortcoming to work
 * around: there is no persistent them to remember, and a signature is exactly
 * how somebody says there should be.
 */
function filing(identity: string): { key: string; keeps: boolean } {
	const signature = signatureOf(identity);

	return signature?.proven
		? { key: signature.trip, keeps: true }
		: { key: identity, keeps: false };
}

function at(identity: string, sound: Sound): string {
	return `${filing(identity).key}/${sound}`;
}

/** What has been decided about one sound from one person. */
export function settingFor(identity: string, sound: Sound): Setting {
	const held = book.get(at(identity, sound));
	if (!held) return AS_SENT;

	// Put through the clamp on the way out rather than only on the way in: a
	// storage entry can be hand-edited, and this is the one door everything
	// leaves by.
	return { volume: level(held.volume), blocked: held.blocked };
}

export function setVolume(identity: string, sound: Sound, volume: number): void {
	write(identity, sound, { ...settingFor(identity, sound), volume: level(volume) });
}

export function setBlocked(identity: string, sound: Sound, blocked: boolean): void {
	write(identity, sound, { ...settingFor(identity, sound), blocked });
}

/** The whole book, for anything that needs to know when it changed. */
export function hearing(): Book {
	return book;
}

export function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

function write(identity: string, sound: Sound, next: Setting): void {
	const { key, keeps } = filing(identity);
	const where = `${key}/${sound}`;

	// Replaced rather than mutated, because the readers compare snapshots by
	// identity and a map edited in place has not changed as far as they can see.
	const replaced = new Map(book);

	if (next.volume === AS_SENT.volume && !next.blocked) {
		// Nothing decided is not a decision to write down. It also means turning
		// somebody back up removes them from storage rather than leaving a row
		// saying they are ordinary.
		replaced.delete(where);
	} else {
		replaced.set(where, { ...next, keeps });
	}

	book = replaced;

	// Only where the entry was one that survives the call. A guest's setting
	// changing leaves nothing on disk different, so there is nothing to write.
	if (keeps) save(book);

	for (const listener of listeners) listener();
}

/**
 * A volume the browser will accept.
 *
 * `HTMLMediaElement.volume` throws outside nought to one rather than clamping,
 * and this application mixes through elements rather than through Web Audio, so
 * there is no gain node that would take a louder number. A slider cannot produce
 * a bad value; a storage entry somebody edited by hand can.
 */
function level(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return AS_SENT.volume;

	return Math.min(1, Math.max(0, value));
}

function load(): Book {
	const found = new Map<string, Held>();

	try {
		const stored = recall(STORED);
		if (!stored) return found;

		const parsed = JSON.parse(stored) as Record<string, Partial<Setting>>;

		for (const [where, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;

			found.set(where, {
				volume: level(value.volume),
				blocked: value.blocked === true,
				keeps: true,
			});
		}
	} catch {
		// Unreadable storage is read as nothing decided, which is the state every
		// browser that has never seen this is in.
		return new Map();
	}

	return found;
}

function save(current: Book): void {
	const keeping: Record<string, Setting> = {};

	for (const [where, held] of current) {
		if (held.keeps) keeping[where] = { volume: held.volume, blocked: held.blocked };
	}

	try {
		if (Object.keys(keeping).length === 0) {
			keep(STORED, undefined);
		} else {
			keep(STORED, JSON.stringify(keeping));
		}
	} catch {
		// A browser refusing storage leaves the setting lasting the call, which
		// is what every guest's does anyway.
	}
}
