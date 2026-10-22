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
