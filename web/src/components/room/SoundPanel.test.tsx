import { AS_SENT, setBlocked, setVolume, settingFor } from "@/live/hearing";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { Room, Track } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SoundPanel } from "./SoundPanel";

/*
 * What can be heard, which is not the same list as what can be seen.
 *
 * Sound in this application is rendered outside the stage on purpose, so it
 * carries on while a tile is paged away, behind a share, or nowhere on screen at
 * all. That is the reason this is a panel and not a control on a picture, and it
 * is the property most likely to be lost the next time somebody tidies: a
 * control moved onto a tile would look tidier and would silently stop reaching
 * the person who is too loud on the second page.
 */

const OTHER = "taaaaaaaaaa-0123456789abcdef0123456789abcdef";
const MINE = "gbbbbbbbbbb-0123456789abcdef0123456789abcdef";

/**
 * A participant, as much of one as this panel reads.
 *
 * `sharing` is a screen publication carrying sound, which is a different thing
 * from a screen being shared: a share whose tab audio was never granted has
 * nothing to turn down.
 */
function person(
	identity: string,
	{ name = "", isLocal = false, microphone = true, sharing = false } = {},
) {
	return {
		identity,
		name,
		isLocal,
		isMicrophoneEnabled: microphone,
		trackPublications: new Map(),
		getTrackPublication: (source: Track.Source) =>
			source === Track.Source.ScreenShareAudio && sharing ? {} : undefined,
	};
}

function roomOf(...people: ReturnType<typeof person>[]) {
	const room = new Room();
	const remote = room.remoteParticipants as Map<string, unknown>;

	for (const one of people) {
		if (one.isLocal) {
			Object.defineProperty(room, "localParticipant", { value: one, configurable: true });
			continue;
		}
		remote.set(one.identity, one);
	}

	return room;
}

function forget() {
	localStorage.clear();
	for (const identity of [OTHER, MINE]) {
		for (const sound of ["voice", "screen"] as const) {
			setVolume(identity, sound, AS_SENT.volume);
			setBlocked(identity, sound, AS_SENT.blocked);
		}
	}
}

beforeEach(forget);
// Wrapped, because the rows are subscribed to the record and putting it back
// re-renders them — after the assertions, but still inside the test.
afterEach(() => act(forget));

describe("SoundPanel", () => {
	it("lists one row for a voice and another for a shared screen", () => {
		const room = roomOf(person(MINE, { name: "me", isLocal: true }), person(OTHER, { name: "Alex" }));

		const { rerender } = render(<SoundPanel room={room} onClose={vi.fn()} />);

		expect(screen.getByLabelText("Alex's volume")).toBeDefined();
		expect(screen.queryByLabelText("Alex (screen)'s volume")).toBeNull();

		// The same person, now playing something. The two are separate tracks on
		// the wire and separate decisions here.
		const sharing = roomOf(
			person(MINE, { name: "me", isLocal: true }),
			person(OTHER, { name: "Alex", sharing: true }),
		);
		rerender(<SoundPanel room={sharing} onClose={vi.fn()} />);

		expect(screen.getByLabelText("Alex's volume")).toBeDefined();
		expect(screen.getByLabelText("Alex (screen)'s volume")).toBeDefined();
	});

	// Nobody hears their own microphone, so a row for it would be a control that
	// does nothing whichever way it were moved.
	it("offers no control over oneself", () => {
		const room = roomOf(person(MINE, { name: "me", isLocal: true }), person(OTHER, { name: "Alex" }));

		render(<SoundPanel room={room} onClose={vi.fn()} />);

		expect(screen.queryByLabelText("me's volume")).toBeNull();
	});

	it("says so when there is nobody else", () => {
		render(<SoundPanel room={roomOf(person(MINE, { isLocal: true }))} onClose={vi.fn()} />);

		expect(screen.getByText("Nobody else is here.")).toBeDefined();
	});

	it("writes a moved slider down against the person it is about", () => {
		const room = roomOf(person(MINE, { isLocal: true }), person(OTHER, { name: "Alex" }));

		render(<SoundPanel room={room} onClose={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("Alex's volume"), { target: { value: "0.4" } });

		expect(settingFor(OTHER, "voice").volume).toBeCloseTo(0.4);
		// And touches nothing else of theirs.
		expect(settingFor(OTHER, "screen")).toEqual(AS_SENT);
	});

	/*
	 * The button is named for what pressing it does rather than for the state it
	 * is in. The two read as opposites, and only one of them is the thing
	 * somebody is deciding — a control labelled with its current state is one
	 * that has to be read twice before it can be pressed once.
	 */
	it("offers to mute, then offers to unmute", () => {
		const room = roomOf(person(MINE, { isLocal: true }), person(OTHER, { name: "Alex" }));

		render(<SoundPanel room={room} onClose={vi.fn()} />);

		fireEvent.click(screen.getByLabelText("Mute Alex"));

		expect(settingFor(OTHER, "voice").blocked).toBe(true);
		expect(screen.getByLabelText("Unmute Alex")).toBeDefined();

		// Nothing is arriving to be made louder, so the slider says so rather
		// than moving while the sound stays off.
		expect((screen.getByLabelText("Alex's volume") as HTMLInputElement).disabled).toBe(true);
	});

	// Said rather than drawn as a state of the slider: one is about what this
	// reader chose, the other about what the other person is doing right now.
	it("distinguishes somebody turned down from somebody not speaking", () => {
		const room = roomOf(
			person(MINE, { isLocal: true }),
			person(OTHER, { name: "Alex", microphone: false }),
		);

		render(<SoundPanel room={room} onClose={vi.fn()} />);

		expect(screen.getByText("microphone off")).toBeDefined();
		expect((screen.getByLabelText("Alex's volume") as HTMLInputElement).disabled).toBe(false);
	});
});
