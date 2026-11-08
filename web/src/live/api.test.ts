import { beforeEach, describe, expect, it, vi } from "vitest";
import { INVITE_KEY, inviteToken } from "./account";
import { chosenRelay, join, rememberRelay } from "./api";

/*
The relay somebody chose, and the two screens that choose one.

Both the lobby and the device screen offer a machine, and only the lobby was
writing the answer down. So a choice made in the lobby was not shown a screen
later, and a choice made on the device screen did not survive a reload — a
person asked the same question twice and having both answers ignored, which is
the complaint this application has already been given about other fields.
*/
describe("the relay somebody chose", () => {
	beforeEach(() => sessionStorage.clear());

	it("is nothing until somebody chooses", () => {
		expect(chosenRelay()).toBe("");
	});

	it("comes back after it is written down", () => {
		rememberRelay("SG Misaka");
		expect(chosenRelay()).toBe("SG Misaka");
	});

	it("can be given up again", () => {
		rememberRelay("SG Misaka");
		rememberRelay("");

		// Empty is a choice: it means whichever measures fastest. Storing it as
		// an empty string rather than removing it would work here and would put
		// a key in storage that reads like a machine nobody can find.
		expect(chosenRelay()).toBe("");
		expect(sessionStorage.getItem("meet-live.relay")).toBeNull();
	});

	it("belongs to this sitting and not to this browser", () => {
		rememberRelay("SG Misaka");

		// Session storage, deliberately. Next week is a different network and
		// the machine that measured fastest today probably is not the one that
		// will — a stale answer here is a call held further away than it
		// needed to be, every time, until somebody notices a dropdown.
		expect(localStorage.getItem("meet-live.relay")).toBeNull();
		expect(sessionStorage.getItem("meet-live.relay")).toBe("SG Misaka");
	});
});

/*
 * The invite comes out of the address bar once it has been used.
 *
 * It belongs in a link — that is what an invite is, and the query is where
 * every chat client preserves it. What it does not belong in is the address bar
 * of somebody in a video call, which is the one place this application puts its
 * users that a link normally never reaches: people share their screen, and the
 * token admits anybody to the meeting for the rest of the day.
 *
 * Kept in this tab rather than thrown away. The server puts it in a cookie for
 * exactly this, and that cookie is HttpOnly — so a browser that declined it
 * would be one where a reload lost the call, and nothing here could tell.
 */
describe("an invite that has been used", () => {
	it("is taken out of the address bar and kept for the tab", async () => {
		sessionStorage.clear();
		history.replaceState(null, "", "/?invite=a-token#/standup");

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ url: "wss://x.invalid", token: "t", identity: "g1-a", room: "standup" }), {
						status: 200,
					}),
			),
		);

		await join("standup", "Somebody", "", "", "a-token");

		expect(new URL(window.location.href).searchParams.get("invite")).toBeNull();
		expect(sessionStorage.getItem(INVITE_KEY)).toBe("a-token");

		// And it is still found, so a reload goes back into the call rather than
		// being turned away by a door that now asks for one.
		expect(inviteToken()).toBe("a-token");
	});
});

/*
 * A guest's identity is kept across a reload only by the tab it was issued to,
 * which proves it by sending back what came with it. Kept beside the identity,
 * per tab, and sent on the next join.
 */
describe("an issued identity", () => {
	it("is sent back with the proof the server gave with it", async () => {
		sessionStorage.clear();

		const sent: unknown[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (String(url).includes("/join")) sent.push(JSON.parse(String(init?.body ?? "{}")));

				return new Response(
					JSON.stringify({ url: "wss://x.invalid", token: "t", identity: "g1-a", proof: "the-proof", room: "standup" }),
					{ status: 200 },
				);
			}),
		);

		await join("standup", "Somebody");
		await join("standup", "Somebody");

		expect(sent).toHaveLength(2);
		expect(sent[0]).not.toHaveProperty("proof");
		expect(sent[1]).toMatchObject({ identity: "g1-a", proof: "the-proof" });
	});
});

/*
 * A meeting held on a machine reached only through another relay, with none
 * answering: the server refuses rather than hand out that machine's address,
 * and the page says so as something that will pass.
 */
describe("a meeting nothing can carry the signalling to", () => {
	it("is refused with a sentence rather than an address", async () => {
		sessionStorage.clear();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				String(url).includes("/join")
					? new Response(JSON.stringify({ error: "no_signalling" }), { status: 503 })
					: new Response(JSON.stringify({ relays: [], measure: false }), { status: 200 }),
			),
		);

		await expect(join("standup", "Somebody")).rejects.toMatchObject({
			reason: "no_signalling",
			message: "The server holding this meeting cannot be reached right now. Try again in a few minutes.",
		});
	});
});

/*
 * A caller shut out of signing in is refused a passphrase at the join as well,
 * since the identity a join hands back is the passphrase's signature. The
 * refusal is the lockout's, with its end, and the page says how long rather
 * than "in a moment", which about half an hour invites the next try; the
 * join's own limits name no end and keep their sentence.
 */
describe("a join refused for a sign-in lockout", () => {
	const refusing = (body: object) =>
		vi.fn(async (url: string) =>
			String(url).includes("/join")
				? new Response(JSON.stringify(body), { status: 429 })
				: new Response(JSON.stringify({ relays: [], measure: false }), { status: 200 }),
		);

	it("says how long is left", async () => {
		sessionStorage.clear();
		const until = new Date(Date.now() + 29 * 60_000 + 5_000).toISOString();
		vi.stubGlobal("fetch", refusing({ error: "rate_limited", until, retryAfter: 1745 }));

		await expect(join("standup", "Somebody", "a passphrase")).rejects.toMatchObject({
			reason: "rate_limited",
			message: "Too many failed sign-ins. Try again in 30 minutes.",
		});
	});

	it("is told apart from the join's own limit, which names no end", async () => {
		sessionStorage.clear();
		vi.stubGlobal("fetch", refusing({ error: "rate_limited" }));

		await expect(join("standup", "Somebody", "a passphrase")).rejects.toMatchObject({
			reason: "rate_limited",
			message: "Too many attempts. Try again in a moment.",
		});
	});
});
