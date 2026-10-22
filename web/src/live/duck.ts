import { keep, recall } from "@/lib/storage";
import { type Participant, type Room, Track } from "livekit-client";
import { wake } from "./speakers";

/**
 * Music that makes way for speech.
 *
 * Whenever anybody in the call is talking -- this person included -- the
 * song desk's music is turned down where it is heard, and brought back up a
 * moment after they stop: what a radio presenter's desk does under a voice,
 * and what a pair of earphones that notice their wearer talking does to what
 * is playing. Each browser decides for itself, from the microphones it can
 * hear, and turns down only its own playback, so what goes out is still the
 * file sample for sample and nobody's choice reaches anybody else.
 *
 * Only microphones are listened to. The music, a screen's sound and anything
 * else are not speech, and the music counted as speech would turn itself down
 * for as long as it played. What is not avoided here is the music reaching a
 * microphone through somebody's speakers: the browser's echo cancelling takes
 * most of it out, and the threshold is set above what is left, but a loud room
 * with no headphones can still sound like somebody talking. That is what the
 * switch is for.
 *
 * Music also arrives gently: a stream that starts is faded in over a second
 * and a half rather than starting at full level in the middle of a sentence.
 */

/** How far the music comes down while somebody talks. */
export const DUCKED = 0.3;

/** Down quickly, so the first word is heard; up slowly, so a pause is not a lurch. */
export const ATTACK_MS = 150;
export const HOLD_MS = 700;
export const RELEASE_MS = 1200;
export const FADE_IN_MS = 1500;

/** How often the microphones are read and the level moved. */
export const TICK_MS = 40;

/**
 * Loudness, as the root of the mean square of a frame, that counts as talking:
 * about -38 dB below full scale. A voice through the browser's own processing
 * sits well above it, and the residue of a room after noise suppression, or of
 * music after echo cancelling, well below.
 */
export const SPEECH = 0.012;

/** Readings in a row above SPEECH before it is taken for speech: a click is one. */
const ONSET = 2;

/** The key a page's own music output is filed under, beside remote identities. */
export const LOCAL = "\u0000local";

const KEY = "meet-live.music-duck";

/** Whether this browser turns music down under speech. On unless turned off. */
export function rememberedDucking(): boolean {
	return recall(KEY) !== "off";
}

export function setDucking(on: boolean): void {
	keep(KEY, on ? undefined : "off");
	enabled = on;
	notify();
}

let enabled = rememberedDucking();
let level = 1;
let lastSpeech = Number.NEGATIVE_INFINITY;
let loud = 0;
const arrivals = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

/** Be told whenever a music level may have moved. */
export function subscribeDuck(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether somebody is talking, as far as the music is concerned. For the panel. */
export function ducking(): boolean {
	return enabled && level < 1;
}

/**
 * What to multiply a music stream's volume by now: the duck, and the fade-in
 * of a stream that has just started. `key` is the identity of whoever plays it,
 * or LOCAL for this page's own.
 */
export function musicFactor(key: string, now = performance.now()): number {
	const arrived = arrivals.get(key);
	const fade = arrived === undefined ? 1 : Math.min(1, Math.max(0, (now - arrived) / FADE_IN_MS));
	return (enabled ? level : 1) * fade;
}

/** A music stream has started from somebody. Fades it in, once; again only after it has gone. */
export function musicArrived(key: string, now = performance.now()): void {
	if (arrivals.has(key)) return;
	arrivals.set(key, now);
	ensureTicking();
}

export function musicLeft(key: string): void {
	arrivals.delete(key);
}

/**
 * Move the level one tick, given whether anybody is talking. Exported for the
 * tests, which drive it with a clock of their own.
 */
export function step(speaking: boolean, now: number, elapsed: number): boolean {
	const before = level;
	if (speaking) lastSpeech = now;

	const target = now - lastSpeech < HOLD_MS ? DUCKED : 1;
	if (level > target) level = Math.max(target, level - ((1 - DUCKED) * elapsed) / ATTACK_MS);
	else if (level < target) level = Math.min(target, level + ((1 - DUCKED) * elapsed) / RELEASE_MS);

	return level !== before || fadingAt(now);
}

/** Back to where a page starts. For the tests. */
export function resetDuck(): void {
	clearInterval(ticker);
	ticker = undefined;
	watchers.clear();
	level = 1;
	lastSpeech = Number.NEGATIVE_INFINITY;
	loud = 0;
	arrivals.clear();
	enabled = rememberedDucking();
}

/*
 * One clock for all of it, running while a page listens to microphones or a
 * stream is still fading in, and not otherwise.
 *
 * Not the microphones' own: a fade that only moved while they were being read
 * would hold the music at nothing wherever they could not be -- a browser that
 * would not make the context the analysers need -- and that is silence where
 * there should be music, which is worse than music that does not duck.
 */
const watchers = new Set<() => boolean>();
let ticker: ReturnType<typeof setInterval> | undefined;
let previous = 0;

function fadingAt(now: number): boolean {
	for (const arrived of arrivals.values()) if (now - arrived < FADE_IN_MS + TICK_MS) return true;
	return false;
}

function ensureTicking(): void {
	if (ticker) return;
	previous = performance.now();
	ticker = setInterval(tick, TICK_MS);
}

function tick(): void {
	const now = performance.now();

	let speaking = false;
	for (const listen of watchers) {
		try {
			if (listen()) speaking = true;
		} catch {
			// A microphone that could not be read is one not talking.
		}
	}
	loud = speaking ? loud + 1 : 0;

	const moved = step(loud >= ONSET, now, now - previous);
	previous = now;
	if (moved) notify();

	if (watchers.size === 0 && level === 1 && !fadingAt(now)) {
		clearInterval(ticker);
		ticker = undefined;
	}
}

/** Reads how loud a microphone is at this moment. A seam for the tests. */
export type Meter = (track: MediaStreamTrack) => { read(): number; close(): void };

let context: AudioContext | undefined;

/** The real meter: an analyser on the track, read as the RMS of its latest frame. */
const analyse: Meter = (track) => {
	if (!context) {
		context = new AudioContext();
		// One for the life of the page, so once it has started, every call
		// after — a move, a rejoin — finds it running. Made where the browser
		// wants a press first, it waits for the next press anywhere: resuming it
		// from a tick below is not one, and such a browser ignores it.
		wake(context);
	}
	const source = context.createMediaStreamSource(new MediaStream([track]));
	const analyser = context.createAnalyser();
	analyser.fftSize = 1024;
	source.connect(analyser);
	const frame = new Float32Array(analyser.fftSize);

	return {
		read() {
			// Suspended until the page has been interacted with; nothing is
			// played through it, so asking again costs nothing.
			if (context?.state === "suspended") void context.resume().catch(() => {});
			analyser.getFloatTimeDomainData(frame);
			let sum = 0;
			for (const sample of frame) sum += sample * sample;
			return Math.sqrt(sum / frame.length);
		},
		close() {
			source.disconnect();
		},
	};
};

/** Every microphone in the call that is on and has a track: this person's and everybody else's. */
function microphones(room: Room): MediaStreamTrack[] {
	const people: Participant[] = [room.localParticipant, ...room.remoteParticipants.values()];
	const out: MediaStreamTrack[] = [];
	for (const person of people) {
		const publication = person.getTrackPublication(Track.Source.Microphone);
		const track = publication?.track?.mediaStreamTrack;
		if (track && !publication?.isMuted && track.readyState === "live") out.push(track);
	}
	return out;
}

/**
 * Listen to the call's microphones and move the music's level. Returns the
 * function that stops.
 */
export function watchSpeech(room: Room, meter: Meter = analyse): () => void {
	const meters = new Map<MediaStreamTrack, ReturnType<Meter> | undefined>();

	const listen = (): boolean => {
		const present = new Set(microphones(room));
		for (const [track, one] of meters) {
			if (!present.has(track)) {
				one?.close();
				meters.delete(track);
			}
		}
		for (const track of present) {
			if (meters.has(track)) continue;
			try {
				meters.set(track, meter(track));
			} catch {
				// Not to be listened to here; kept, so it is not tried every tick.
				meters.set(track, undefined);
			}
		}

		let speaking = false;
		for (const one of meters.values()) {
			try {
				if ((one?.read() ?? 0) > SPEECH) speaking = true;
			} catch {
				// As above: one that cannot be read is one not talking.
			}
		}
		return speaking;
	};

	watchers.add(listen);
	ensureTicking();

	return () => {
		watchers.delete(listen);
		for (const one of meters.values()) one?.close();
		meters.clear();
	};
}
