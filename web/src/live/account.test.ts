import { afterEach, describe, expect, it, vi } from "vitest";
import { invited } from "./account";

/*
 * What a link says about itself, as the landing page reads it.
 *
 * The server calls the end of a link `expires`, which is what the record holds,
 * and the page calls it `until`, which is what it says. The translation between
 * the two is one line and the kind that breaks silently: a link with an end
 * would read as one without, and the guest would be told nothing about when it
 * stops working.
 */

afterEach(() => {
	vi.unstubAllGlobals();
});

function answers(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status })),
	);
}

describe("invited", () => {
	it("reads the name and the window of a link", async () => {
		answers(200, {
			room: "standup@acme",
			name: "Client Co",
			from: "2026-03-03T02:00:00Z",
			expires: "2026-03-03T04:00:00Z",
		});

		expect(await invited("token")).toEqual({
			room: "standup@acme",
			name: "Client Co",
			from: "2026-03-03T02:00:00Z",
			until: "2026-03-03T04:00:00Z",
		});
	});

	it("reads when a link opened too early will open", async () => {
		answers(403, { error: "invite_not_yet", from: "2026-03-03T02:00:00Z" });

		expect(await invited("token")).toEqual({ error: "invite_not_yet", from: "2026-03-03T02:00:00Z" });
	});

	it("says a link is no good when the server says nothing readable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not json", { status: 502 })),
		);

		expect((await invited("token")).error).toBe("no_such_invite");
	});
});
