import { Room, RoomEvent, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPARE, giveBack, listenForPresses, resetSpeakers, sound, take, unlock, wake, whenUnlocked } from "./speakers";

/*
 * What these guard is a call that comes back silent for one person.
 *
 * Somebody placed on another relay rejoins by themselves, with no press, and a
 * browser that asks permission of each element refuses every element made for
 * the new call. They hear nobody; everybody hears them; the server says the
 * rejoin went through in a second. Nothing about that is visible in a unit test
 * unless the pieces that carry the permission across are pinned down here: the
 * elements are played during a press and handed out again, an element that was
 * refused is not handed out as if it had been allowed, a later press starts what
 * was refused, and the room's tracks are put on those elements and taken off
 * them again without anybody hearing themselves or somebody else at the wrong
 * volume.
 *
 * jsdom plays nothing, so play() and pause() are stood in for below with what the
 * browsers do that matters here: play() answers a promise, which a refusal
 * rejects with NotAllowedError, and pause() during it rejects it with
 * AbortError instead.
 */

type Answer = "allow" | "refuse";

/** What play() does for each element: allowed unless told otherwise. */
let answer: (element: HTMLMediaElement) => Answer = () => "allow";
const played: HTMLMediaElement[] = [];
const paused = new WeakMap<HTMLMediaElement, boolean>();

beforeEach(() => {
	resetSpeakers();
	answer = () => "allow";
	played.length = 0;

	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: HTMLMediaElement) {
		played.push(this);
		if (answer(this) === "refuse") return Promise.reject(new DOMException("refused", "NotAllowedError"));
		paused.set(this, false);
		return Promise.resolve();
	});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: HTMLMediaElement) {
		paused.set(this, true);
	});
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(function (this: HTMLMediaElement) {
		return paused.get(this) ?? true;
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSpeakers();
});

/** Let the promises the stand-ins answered settle. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the page's speakers", () => {
	it("are made and played during a press, so there are some to spare", () => {
		unlock();

		const made = document.querySelectorAll("[data-speakers] audio");
		expect(made).toHaveLength(SPARE);

		// Every one of them played, inside the press, and left silent again.
		for (const element of made) {
			expect(played).toContain(element);
			expect(paused.get(element as HTMLMediaElement)).toBe(true);
		}
	});

	/*
	 * The refused one first in the line is the case that matters: an element a
	 * room gave back that was never allowed, then a press. Handing out whatever
	 * came back first would hand out the one element that cannot play.
	 */
	it("hand out an element that was allowed before one that was refused", async () => {
		const refused = take();
		giveBack(refused);

		answer = (element) => (element === refused ? "refuse" : "allow");
		unlock();
		await settled();

		const handed = take();
		expect(handed).not.toBe(refused);
		expect(played).toContain(handed);
	});

	it("start, at the next press, an element in use that the browser refused", () => {
		const element = take();
		// What a track attached and the browser refused looks like: a stream on
		// it, and not playing.
		Object.defineProperty(element, "srcObject", { value: {}, writable: true, configurable: true });
		played.length = 0;

		unlock();

		expect(played).toContain(element);
		// Not paused afterwards: this one has something to play.
		expect(paused.get(element)).toBe(false);
	});

	it("come back the way a new one starts", () => {
		const element = take();
		element.volume = 0.2;
		element.muted = true;

		giveBack(element);

		expect(element.volume).toBe(1);
		expect(element.muted).toBe(false);
		expect(element.srcObject).toBeNull();
	});

	it("resume at a press the contexts that are waiting, and only those", () => {
		const waiting = { state: "suspended", resume: vi.fn(() => Promise.resolve()) } as unknown as AudioContext;
		const done = { state: "suspended", resume: vi.fn(() => Promise.resolve()) } as unknown as AudioContext;

		wake(waiting);
		const stop = wake(done);
		stop();

		unlock();

		expect(waiting.resume).toHaveBeenCalled();
		expect(done.resume).not.toHaveBeenCalled();
	});

	it("run what was waiting for a press inside it", () => {
		let during = false;
		let inside = false;

		whenUnlocked(() => {
			inside = during;
		});

		during = true;
		unlock();
		during = false;

		expect(inside).toBe(true);
	});

	/*
	 * On a touch screen the pointerdown comes first and the activation only with
	 * the pointerup. Trying at the first would be refused, and nothing would be
	 * tried at the second if the refusal had been taken as the answer.
	 */
	it("are tried at the event that carries the press, not at one before it", () => {
		const activation = { isActive: false };
		Object.defineProperty(navigator, "userActivation", { value: activation, configurable: true });
		const stop = listenForPresses();

		try {
			document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			expect(played).toHaveLength(0);

			activation.isActive = true;
			document.body.dispatchEvent(new Event("pointerup", { bubbles: true }));
			expect(played.length).toBeGreaterThanOrEqual(SPARE);
		} finally {
			stop();
			Reflect.deleteProperty(navigator, "userActivation");
		}
	});
});

/** A track of the room's, as far as the speakers are concerned. */
function track() {
	const attached: HTMLMediaElement[] = [];

	return {
		attached,
		attach: vi.fn((element: HTMLMediaElement) => {
			attached.push(element);
			return element;
		}),
		detach: vi.fn((element: HTMLMediaElement) => {
			attached.splice(attached.indexOf(element), 1);
			return element;
		}),
	};
}

/** Somebody in the room with the publications given. */
function somebody(
	room: Room,
	identity: string,
	publications: { source: Track.Source; kind?: Track.Kind; track?: ReturnType<typeof track>; subscribed?: boolean }[],
	isLocal = false,
) {
	const trackPublications = new Map(
		publications.map((one, i) => [
			`TR_${identity}_${i}`,
			{
				source: one.source,
				kind: one.kind ?? Track.Kind.Audio,
				track: one.track,
				isSubscribed: one.subscribed ?? Boolean(one.track),
			},
		]),
	);

	const participant = { identity, isLocal, trackPublications };
	(room.remoteParticipants as Map<string, unknown>).set(identity, participant);

	return participant;
}

describe("a room's sound on the page's speakers", () => {
	it("plays each remote sound on its own element, and lets it go when the track goes", () => {
		const room = new Room();
		const voice = track();
		const screen = track();
		const music = track();
		const camera = track();
		// A picture on the source the music uses: the kind, not the source, is
		// what says it is not a sound.
		const picture = track();

		const person = somebody(room, "tb", [
			{ source: Track.Source.Microphone, track: voice },
			{ source: Track.Source.ScreenShareAudio, track: screen },
			{ source: Track.Source.Unknown, track: music },
			{ source: Track.Source.Camera, kind: Track.Kind.Video, track: camera },
			{ source: Track.Source.Unknown, kind: Track.Kind.Video, track: picture },
		]);

		const stop = sound(room, () => {});

		expect(voice.attach).toHaveBeenCalledTimes(1);
		expect(screen.attach).toHaveBeenCalledTimes(1);
		expect(music.attach).toHaveBeenCalledTimes(1);
		expect(camera.attach).not.toHaveBeenCalled();
		expect(picture.attach).not.toHaveBeenCalled();

		const element = voice.attach.mock.calls[0]?.[0];
		expect(element?.parentElement?.dataset.speakers).toBe("");

		// Unsubscribed: the track is let go of, from the element it had, and
		// the element goes back to be handed out again.
		person.trackPublications.delete("TR_tb_0");
		room.emit(RoomEvent.TrackUnsubscribed, {} as never, {} as never, {} as never);

		expect(voice.detach).toHaveBeenCalledWith(element);
		expect(take()).toBe(element);

		stop();
	});

	it("gives every element back when the room is let go of", () => {
		const room = new Room();
		const voice = track();
		somebody(room, "tb", [{ source: Track.Source.Microphone, track: voice }]);

		const stop = sound(room, () => {});
		const element = voice.attach.mock.calls[0]?.[0];
		stop();

		expect(voice.detach).toHaveBeenCalledWith(element);
		expect(take()).toBe(element);
	});

	it("does not play a sound before it is subscribed", () => {
		const room = new Room();
		const voice = track();
		somebody(room, "tb", [{ source: Track.Source.Microphone, track: voice, subscribed: false }]);

		const stop = sound(room, () => {});
		expect(voice.attach).not.toHaveBeenCalled();
		stop();
	});

	/*
	 * Nobody hears themselves. The library keeps this person out of the remote
	 * list, so the case is the one where something else does not: the session
	 * a rejoin replaced, still listed under the same identity for a moment, or
	 * anything marked local.
	 */
	it("never plays this person", () => {
		const room = new Room();
		room.localParticipant.identity = "tme";

		const earlier = track();
		const local = track();
		somebody(room, "tme", [{ source: Track.Source.Microphone, track: earlier }]);
		somebody(room, "tother", [{ source: Track.Source.Microphone, track: local }], true);

		const stop = sound(room, () => {});

		expect(earlier.attach).not.toHaveBeenCalled();
		expect(local.attach).not.toHaveBeenCalled();
		stop();
	});

	/*
	 * The order of events is the fault. The room tells the code applying
	 * volumes about a new track in the same breath as it tells this, and when
	 * that code goes first the library keeps the volume on the track and gives
	 * it to an element attached later only if it is not nought. A person turned
	 * all the way down came back at full volume after every rejoin.
	 */
	it("puts the volumes back after a track is given an element, onto an element that starts at full", () => {
		const room = new Room();

		// An element left at a fifth by whoever it played before.
		const before = take();
		before.volume = 0.2;
		giveBack(before);

		const voice = track();
		somebody(room, "tb", [{ source: Track.Source.Microphone, track: voice }]);

		const order: string[] = [];
		voice.attach.mockImplementation((element: HTMLMediaElement) => {
			order.push(`attach at ${element.volume}`);
			return element;
		});

		const stop = sound(room, () => order.push("settle"));

		expect(order).toEqual(["attach at 1", "settle"]);
		stop();
	});

	it("settles only when something was handed out, not on every event", () => {
		const room = new Room();
		somebody(room, "tb", [{ source: Track.Source.Microphone, track: track() }]);

		const settle = vi.fn();
		const stop = sound(room, settle);
		settle.mockClear();

		room.emit(RoomEvent.TrackPublished, {} as never, {} as never);
		expect(settle).not.toHaveBeenCalled();
		stop();
	});
});
