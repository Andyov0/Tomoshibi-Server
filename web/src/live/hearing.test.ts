import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * What is remembered about hearing somebody, and for how long.
 *
 * The rule this guards is not a preference, it is the only honest reading of
 * what an identity means here. A proven signature is derived from a passphrase
 * only its holder can produce, so it is the same string next week; every other
 * identity is a fresh random one per tab. Writing a setting against the second
 * kind would be a note about somebody who has ceased to exist, applied to
 * whoever is issued that string next — and the setting it would silently apply
 * is "do not hear this person".
 *
 * The module reads storage once, when it is first imported, so each test here
 * arranges storage and then imports it fresh. Resetting a singleton is what a
 * test double would be for, and there is nothing to double: the singleton is the
 * behaviour.
 */

const STORED = "meet-live.hearing";

// Identities as the server mints them: a kind, a ten-character signature, a
// dash, and thirty-two hex characters that are new every time.
const random = "0123456789abcdef0123456789abcdef";
const PROVEN = `taaaaaaaaaa-${random}`;
const GUEST = `gbbbbbbbbbb-${random}`;

async function load() {
	// Fresh, so the module-level book is built from whatever storage now holds.
	vi.resetModules();

	return import("./hearing");
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("hearing", () => {
	it("leaves everybody as they were sent until somebody says otherwise", async () => {
		const { settingFor, AS_SENT } = await load();

		expect(settingFor(PROVEN, "voice")).toEqual(AS_SENT);
		expect(settingFor(GUEST, "screen")).toEqual(AS_SENT);
	});

	// The split the feature exists for: one person, two things to hear, two
	// separate decisions.
	it("keeps a voice and a shared screen apart", async () => {
		const { setVolume, setBlocked, settingFor } = await load();

		setVolume(PROVEN, "voice", 0.4);
		setBlocked(PROVEN, "screen", true);

		expect(settingFor(PROVEN, "voice")).toEqual({ volume: 0.4, blocked: false });
		expect(settingFor(PROVEN, "screen")).toEqual({ volume: 1, blocked: true });
	});

	it("keeps people apart", async () => {
		const { setBlocked, settingFor } = await load();

		setBlocked(PROVEN, "voice", true);

		expect(settingFor(GUEST, "voice").blocked).toBe(false);
	});

	/*
	 * `HTMLMediaElement.volume` throws outside nought to one rather than
	 * clamping, and this application mixes through elements, so there is no gain
	 * node that would take a louder number. A slider cannot produce a bad value;
	 * this is about the ones that arrive some other way.
	 */
	it("never lets out a volume the browser would throw on", async () => {
		const { setVolume, settingFor } = await load();

		setVolume(PROVEN, "voice", 4);
		expect(settingFor(PROVEN, "voice").volume).toBe(1);

		setVolume(PROVEN, "voice", -1);
		expect(settingFor(PROVEN, "voice").volume).toBe(0);

		setVolume(PROVEN, "voice", Number.NaN);
		expect(settingFor(PROVEN, "voice").volume).toBe(1);
	});

	it("reads a hand-edited storage entry through the same clamp", async () => {
		localStorage.setItem(
			STORED,
			JSON.stringify({ "aaaaaaaaaa/voice": { volume: 11, blocked: false } }),
		);

		const { settingFor } = await load();

		expect(settingFor(PROVEN, "voice").volume).toBe(1);
	});

	it("survives a reload for somebody who can prove who they are", async () => {
		const first = await load();
		first.setVolume(PROVEN, "voice", 0.25);
		first.setBlocked(PROVEN, "screen", true);

		const again = await load();

		expect(again.settingFor(PROVEN, "voice").volume).toBe(0.25);
		expect(again.settingFor(PROVEN, "screen").blocked).toBe(true);
	});

	/*
	 * A guest is a different identity on their next visit, so there is nothing
	 * for a stored setting to be about. What makes this worth a test rather than
	 * a comment is what would be applied if it were kept: a random string
	 * arriving at a browser that had once decided not to hear a random string.
	 */
	it("forgets a guest, whose next identity is not theirs", async () => {
		const first = await load();
		first.setBlocked(GUEST, "voice", true);

		expect(first.settingFor(GUEST, "voice").blocked).toBe(true);
		expect(localStorage.getItem(STORED)).toBeNull();

		const again = await load();
		expect(again.settingFor(GUEST, "voice").blocked).toBe(false);
	});

	// Filed under the signature rather than the identity, so the same person is
	// the same person however many times they open a tab.
	it("recognises a proven signature under a new identity", async () => {
		const first = await load();
		first.setVolume(PROVEN, "voice", 0.5);

		const again = await load();
		const tomorrow = `taaaaaaaaaa-${"f".repeat(32)}`;

		expect(again.settingFor(tomorrow, "voice").volume).toBe(0.5);
	});

	// Turning somebody back up is not a decision worth carrying around, so it
	// takes the row out rather than leaving one that says they are ordinary.
	it("writes nothing down for somebody left as they were sent", async () => {
		const { setVolume, setBlocked } = await load();

		setVolume(PROVEN, "voice", 0.3);
		setBlocked(PROVEN, "voice", true);
		expect(localStorage.getItem(STORED)).not.toBeNull();

		setVolume(PROVEN, "voice", 1);
		setBlocked(PROVEN, "voice", false);

		expect(localStorage.getItem(STORED)).toBeNull();
	});

	it("tells anybody watching that something changed", async () => {
		const { subscribe, setVolume, hearing } = await load();

		let told = 0;
		const stop = subscribe(() => told++);

		const before = hearing();
		setVolume(PROVEN, "voice", 0.6);

		expect(told).toBe(1);
		// Replaced rather than edited, because the readers compare by identity
		// and a map changed in place has not changed as far as they can see.
		expect(hearing()).not.toBe(before);

		stop();
		setVolume(PROVEN, "voice", 0.7);
		expect(told).toBe(1);
	});

	it("survives storage that will not be read or written", async () => {
		localStorage.setItem(STORED, "{ not json");

		const { settingFor, setVolume, AS_SENT } = await load();

		expect(settingFor(PROVEN, "voice")).toEqual(AS_SENT);

		// And still works for the rest of the call, which is what a guest's
		// setting does anyway.
		setVolume(PROVEN, "voice", 0.5);
		expect(settingFor(PROVEN, "voice").volume).toBe(0.5);
	});

	// Both mean there is no sound, and both are this reader's own doing, which
	// is what the mark on a picture is about.
	it("counts nought and blocked as the same silence", async () => {
		const { silenced } = await load();

		expect(silenced({ volume: 0, blocked: false })).toBe(true);
		expect(silenced({ volume: 1, blocked: true })).toBe(true);
		expect(silenced({ volume: 0.05, blocked: false })).toBe(false);
	});
});
