import { describe, expect, it, vi } from "vitest";

/*
 * The key, and where it does not come from.
 *
 * There is one property here worth a test and it is not cryptographic: the key
 * must depend on the room as well as the word. Without the room, one word used
 * for two meetings makes them one key — and anybody who was in the first can
 * read the second, from a recording of frames they were never in the room for.
 *
 * The derivation itself is the SDK's (PBKDF2 over the string) and is not this
 * file's to test. What is this file's is what string it is given.
 */

const keys: string[] = [];

vi.mock("livekit-client", () => ({
	isE2EESupported: () => true,
	ExternalE2EEKeyProvider: class {
		setKey(key: string) {
			keys.push(key);
			return Promise.resolve();
		}
	},
}));

// jsdom has no Worker. Stubbed rather than skipped, because what is being
// checked is which string reaches setKey and that does not depend on there
// being a real one — the encryption itself happens inside the SDK's worker and
// is not this file's to test.
vi.stubGlobal(
	"Worker",
	class {
		terminate() {}
	},
);

const { seal, sealing, possible } = await import("./secrecy");

describe("sealing a call", () => {
	it("is not offered for an empty word", () => {
		expect(sealing("")).toBeUndefined();
	});

	it("is offered for a word, where the browser can do it", () => {
		expect(possible()).toBe(true);
		expect(sealing("open sesame")).toBeTruthy();
	});

	it("gives the same key for the same room and word", async () => {
		keys.length = 0;
		await seal("standup", "open sesame");
		await seal("standup", "open sesame");

		expect(keys[0]).toBe(keys[1]);
	});

	// The whole reason the room is in it.
	it("gives different keys to different rooms with one word", async () => {
		keys.length = 0;
		await seal("standup", "open sesame");
		await seal("retro", "open sesame");

		expect(keys[0]).not.toBe(keys[1]);
	});

	// And the reason for the separator. Concatenated, ("ab", "c") and
	// ("a", "bc") are one key, which is two meetings sharing one.
	it("does not confuse a long room with a long word", async () => {
		keys.length = 0;
		await seal("ab", "c");
		await seal("a", "bc");

		expect(keys[0]).not.toBe(keys[1]);
	});

	it("does nothing without a word", async () => {
		keys.length = 0;
		await seal("standup", "");

		expect(keys).toHaveLength(0);
	});
});
