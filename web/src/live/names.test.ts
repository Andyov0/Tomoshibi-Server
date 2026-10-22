import { describe, expect, it } from "vitest";
import {
	MAX_ROOM_NAME,
	MAX_SCOPE,
	generateRoomName,
	looksGenerated,
	normaliseRoomName,
	scopeOf,
	validRoomName,
	validScope,
} from "./names";
import { impersonating, parseName, signatureOf, passphraseOf } from "./name";

describe("generateRoomName", () => {
	it("produces a name the server will accept", () => {
		for (let i = 0; i < 200; i++) {
			const name = generateRoomName();
			expect(validRoomName(name), name).toBe(true);
			expect(looksGenerated(name), name).toBe(true);
		}
	});

	// The name is the credential, so repetition would be somebody walking into
	// a stranger's meeting rather than a cosmetic flaw.
	it("does not repeat itself over a large sample", () => {
		const seen = new Set(Array.from({ length: 500 }, generateRoomName));
		expect(seen.size).toBe(500);
	});
});

describe("normaliseRoomName", () => {
	it("reduces what somebody typed to something acceptable", () => {
		expect(normaliseRoomName("Weekly Standup")).toBe("weekly-standup");
		expect(normaliseRoomName("  Team!! Sync  ")).toBe("team-sync");
		expect(normaliseRoomName("--edges--")).toBe("edges");
		expect(normaliseRoomName("已经开始")).toBe("");
	});

	it("keeps the result within the length the server allows", () => {
		expect(normaliseRoomName("a".repeat(200)).length).toBeLessThanOrEqual(64);
	});

	it("leaves an acceptable name alone", () => {
		expect(normaliseRoomName("weekly-standup")).toBe("weekly-standup");
	});
});

/*
 * A room held under a scope: one `@`, and each half a plain name.
 *
 * Kept in step with the server's rule rather than looser than it, because the
 * address bar is read through this and a name it accepted that the server
 * refused would be a page that loads a room and then cannot join it.
 */
describe("scoped names", () => {
	it("accepts a room and a scope", () => {
		for (const name of ["standup@acme", "a@b", "weekly-standup@acme-cn"]) {
			expect(validRoomName(name), name).toBe(true);
		}

		expect(validRoomName(`${"a".repeat(MAX_ROOM_NAME)}@${"b".repeat(MAX_SCOPE)}`)).toBe(true);
	});

	it("refuses anything that splits two ways or has an empty half", () => {
		for (const name of ["@acme", "standup@", "a@b@c", "standup@-acme", `standup@${"b".repeat(MAX_SCOPE + 1)}`]) {
			expect(validRoomName(name), name).toBe(false);
		}

		expect(validScope("")).toBe(false);
		expect(validScope("a@b")).toBe(false);
	});

	it("normalises each half as it would a plain name", () => {
		expect(normaliseRoomName("Weekly Standup@ACME Corp")).toBe("weekly-standup@acme-corp");
		expect(normaliseRoomName("a@b@c")).toBe("a@b-c");
	});

	// Normalised as somebody types, so the separator has to survive the moment
	// it is pressed or nobody could type a scope at all.
	it("keeps the @ while the scope is still being typed", () => {
		expect(normaliseRoomName("standup@")).toBe("standup@");
		expect(validRoomName(normaliseRoomName("standup@"))).toBe(false);
	});

	it("reads the scope out of a name", () => {
		expect(scopeOf("standup@acme")).toBe("acme");
		expect(scopeOf("standup")).toBe("");
	});
});

describe("looksGenerated", () => {
	// Decides whether to warn that a room can be guessed, so a chosen name must
	// never be mistaken for one from the generator.
	it("is false for names somebody chose", () => {
		for (const name of ["standup", "team-sync", "amber-otter-glide", "amber-otter-glide-42"]) {
			expect(looksGenerated(name), name).toBe(false);
		}
	});
});

describe("parseName", () => {
	it("splits a name from its passphrase", () => {
		expect(parseName("Alice#hunter2")).toEqual({ name: "Alice", passphrase: "hunter2" });
		expect(parseName("Alice")).toEqual({ name: "Alice", passphrase: "" });
		expect(parseName("  Alice  ")).toEqual({ name: "Alice", passphrase: "" });
	});

	// A harder passphrase is a better one, so nothing in it is rejected.
	it("keeps everything after the first separator", () => {
		expect(parseName("Alice#a#b#c").passphrase).toBe("a#b#c");
	});

	it("allows a passphrase with no name", () => {
		expect(parseName("#secret")).toEqual({ name: "", passphrase: "secret" });
	});
});

// A signature is exactly ten base32 characters, and an identity carries thirty
// two hex characters of randomness after it.
const TRIP = "k7m2q6x4rt";
const HEX = "0123456789abcdef0123456789abcdef";

describe("signatureOf", () => {
	it("reads a mark that was earned", () => {
		expect(signatureOf(`t${TRIP}-${HEX}`)).toEqual({ trip: TRIP, proven: true, account: false });
	});

	/*
	 * The third kind, and the reason it is not simply "proven".
	 *
	 * A mark from a passphrase and a mark from an account session are the same
	 * mark and the same person — signing in derives it the same way. What
	 * differs is how they arrived, and one thing turns on that: the picture on
	 * an account is shown only for somebody who was signed in. Shown for anybody
	 * who typed the right passphrase into a join form, it would become a second
	 * credential that nobody chose to make one.
	 */
	it("reads a mark that came from an account, and still calls it proven", () => {
		expect(signatureOf(`a${TRIP}-${HEX}`)).toEqual({ trip: TRIP, proven: true, account: true });
	});

	// Everybody carries one. What differs is whether it proves anything, and
	// that difference is the whole mechanism: a mark nobody can tell apart from
	// an earned one would let an impostor point at theirs and claim it.
	it("reads a mark that was issued, and does not call it proven", () => {
		expect(signatureOf(`g${TRIP}-${HEX}`)).toEqual({
			trip: TRIP,
			proven: false,
			account: false,
		});
	});

	it("rejects anything that is not shaped like one", () => {
		expect(signatureOf("t-short")).toBeUndefined();
		expect(signatureOf(`tABCDEFGHIJ-${HEX}`)).toBeUndefined();
		expect(signatureOf(`t${TRIP}x${HEX}`)).toBeUndefined();
		expect(signatureOf(`x${TRIP}-${HEX}`)).toBeUndefined();
	});
});

describe("impersonating", () => {
	const signed = { name: "Alice", identity: `t${TRIP}-${HEX}` };
	const unsigned = { name: "Alice", identity: `gaaaaaaaaaa-${HEX}` };
	const other = { name: "Bob", identity: `gbbbbbbbbbb-${HEX}` };

	it("marks an unsigned participant wearing a signed name", () => {
		expect(impersonating(unsigned, [signed, unsigned, other])).toBe(true);
	});

	it("never marks the signed participant", () => {
		expect(impersonating(signed, [signed, unsigned, other])).toBe(false);
	});

	// Two people genuinely called Alex is ordinary and worth no comment.
	it("says nothing about a collision between two unsigned names", () => {
		const twin = { name: "Alice", identity: `gcccccccccc-${HEX}` };
		expect(impersonating(unsigned, [unsigned, twin])).toBe(false);
	});

	it("says nothing when nobody else is called that", () => {
		expect(impersonating(unsigned, [unsigned, other])).toBe(false);
	});
});

/*
 * One shape, two fields.
 *
 * The pre-join reads `Alice#secret` and everybody who uses this has learnt it
 * there. The management sign-in takes a passphrase alone, and used to compute
 * the signature of whatever arrived — so the form people knew was refused, with
 * a sentence saying the passphrase was not an administrator's, at the one
 * moment when the passphrase was right and only the name had come with it.
 */
describe("passphraseOf", () => {
	it("keeps the half parseName throws away", () => {
		const typed = "Alice#secret";

		expect(passphraseOf(typed)).toBe(parseName(typed).passphrase);
	});

	it("takes a bare passphrase whole", () => {
		// Where parseName would call this a name and leave the passphrase
		// empty, which is right for the field it serves and wrong for this one.
		expect(passphraseOf("djoff-bv2j6")).toBe("djoff-bv2j6");
		expect(parseName("djoff-bv2j6").passphrase).toBe("");
	});

	it("cuts at the first separator only", () => {
		// A passphrase may contain them, and does whenever somebody chose one
		// with punctuation in it.
		expect(passphraseOf("Alice#one#two")).toBe("one#two");
	});

	it("agrees with the pre-join on everything it is given", () => {
		// The two fields have to reach the same passphrase from the same
		// keystrokes, or an administrator's signature in a room is not the
		// signature that opens the pages about it.
		for (const typed of ["Alice#secret", "  Bo #x y z", "Cy#a#b", "#leading", "Dee#"]) {
			expect(passphraseOf(typed), typed).toBe(parseName(typed).passphrase);
		}
	});

	it("leaves the passphrase exactly as it was typed", () => {
		// Trimming belongs to the server, which does it for both fields. Doing
		// it here as well would be a second opinion about what somebody's
		// passphrase is.
		expect(passphraseOf("Alice# padded ")).toBe(" padded ");
	});
});
