import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import {
	ATTACK_MS,
	DUCKED,
	FADE_IN_MS,
	HOLD_MS,
	LOCAL,
	RELEASE_MS,
	SPEECH,
	TICK_MS,
	type Meter,
	musicArrived,
	musicFactor,
	resetDuck,
	setDucking,
	subscribeDuck,
	watchSpeech,
} from "./duck";

/*
Music that makes way for speech.

What would go wrong unnoticed: the music turned down by itself, so that it never
comes back up; a click counted as somebody talking; the level stepping rather
than moving; a fade-in that never finishes, which is music that is never heard;
and a switch that says off while the music still ducks.
*/

type Level = { value: number };

function fakeRoom(microphones: Record<string, Level>) {
	const person = (identity: string) => ({
		identity,
		getTrackPublication(source: string) {
			if (source !== "microphone" || !(identity in microphones)) return undefined;
			return { isMuted: false, track: { mediaStreamTrack: { id: identity, readyState: "live", level: microphones[identity] } } };
		},
	});
	const room = {
		localParticipant: person("me"),
		remoteParticipants: new Map(Object.keys(microphones).filter((id) => id !== "me").map((id) => [id, person(id)])),
	};
	return room as unknown as Room;
}

/** Reads the level a fake track carries. */
const meter: Meter = (track) => {
	const level = (track as unknown as { level: Level }).level;
	return { read: () => level.value, close: () => {} };
};

let clock = 0;

beforeEach(() => {
	vi.useFakeTimers();
	clock = 0;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
	resetDuck();
});

afterEach(() => {
	resetDuck();
	vi.restoreAllMocks();
	vi.useRealTimers();
	localStorage.clear();
});

/** Move both clocks on together, tick by tick. */
function pass(ms: number) {
	for (let t = 0; t < ms; t += TICK_MS) {
		clock += TICK_MS;
		vi.advanceTimersByTime(TICK_MS);
	}
}

describe("under speech", () => {
	it("comes down within the attack once somebody talks, and only as far as DUCKED", () => {
		const voice = { value: 0 };
		const stop = watchSpeech(fakeRoom({ gfriend: voice }), meter);

		voice.value = 0.1;
		pass(2 * TICK_MS + ATTACK_MS + TICK_MS);

		expect(musicFactor("gfriend")).toBe(DUCKED);
		stop();
	});

	it("waits a moment after the talking stops, then comes back up over the release, not at once", () => {
		const voice = { value: 0.1 };
		const stop = watchSpeech(fakeRoom({ me: voice }), meter);
		pass(400);
		voice.value = 0;

		pass(HOLD_MS - 2 * TICK_MS);
		expect(musicFactor("gfriend")).toBe(DUCKED);

		pass(RELEASE_MS / 2);
		const midway = musicFactor("gfriend");
		expect(midway).toBeGreaterThan(DUCKED);
		expect(midway).toBeLessThan(1);

		pass(RELEASE_MS);
		expect(musicFactor("gfriend")).toBe(1);
		stop();
	});

	it("takes a click for nothing: one loud reading is not speech", () => {
		const voice = { value: 0 };
		const stop = watchSpeech(fakeRoom({ gfriend: voice }), meter);

		voice.value = 0.5;
		pass(TICK_MS);
		voice.value = 0;
		pass(ATTACK_MS * 2);

		expect(musicFactor("gfriend")).toBe(1);
		stop();
	});

	it("ignores what is below speech, such as the music's residue in a microphone", () => {
		const voice = { value: SPEECH * 0.8 };
		const stop = watchSpeech(fakeRoom({ gfriend: voice }), meter);

		pass(2000);

		expect(musicFactor("gfriend")).toBe(1);
		stop();
	});

	it("does nothing once switched off, and says so to whoever applies it", () => {
		const voice = { value: 0.1 };
		const stop = watchSpeech(fakeRoom({ gfriend: voice }), meter);
		pass(500);
		const told = vi.fn();
		const unsubscribe = subscribeDuck(told);

		setDucking(false);

		expect(musicFactor("gfriend")).toBe(1);
		expect(told).toHaveBeenCalled();
		unsubscribe();
		stop();
	});

	it("keeps going when a microphone cannot be listened to", () => {
		const voice = { value: 0.1 };
		const broken: Meter = (track) => {
			if ((track as unknown as { id: string }).id === "gbroken") throw new Error("no context");
			return meter(track);
		};
		const stop = watchSpeech(fakeRoom({ gbroken: { value: 1 }, gfriend: voice }), broken);

		pass(500);

		expect(musicFactor("gfriend")).toBe(DUCKED);
		stop();
	});
});

describe("starting", () => {
	it("fades a stream in from nothing, and finishes even with no microphones being listened to", () => {
		const told = vi.fn();
		const unsubscribe = subscribeDuck(told);
		musicArrived(LOCAL);

		expect(musicFactor(LOCAL)).toBe(0);
		pass(FADE_IN_MS / 2);
		expect(musicFactor(LOCAL)).toBeCloseTo(0.5, 1);
		pass(FADE_IN_MS);
		expect(musicFactor(LOCAL)).toBe(1);
		expect(told).toHaveBeenCalled();
		unsubscribe();
	});

	it("fades a stream in once, not again between songs", () => {
		musicArrived("gholder");
		pass(FADE_IN_MS + 100);

		musicArrived("gholder");

		expect(musicFactor("gholder")).toBe(1);
	});
});
