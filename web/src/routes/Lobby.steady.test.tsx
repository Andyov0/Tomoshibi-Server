import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Lobby } from "./Lobby";

/*
 * The lobby laid out before it knows its servers as it was laid out last.
 *
 * Whether there are two blocks depends on there being more than one server,
 * and the list comes from a request: decided by its arrival alone, the lobby
 * was drawn as one narrow column and then, a second later on a slow line, as
 * two wide ones, rearranged under somebody already reading it. The owner asked
 * for the pages to stop jumping about. What is guarded here is that the layout
 * a browser last saw is the one drawn while the list is on its way, the
 * servers' card standing in its place, and that the list, when it comes, is
 * what is remembered for next time.
 */

const KEY = "meet-live.lobby.two-blocks";
const RELAYS = [
	{ name: "hk", url: "wss://hk.example.com", label: "Hong Kong", lat: 22.3, lon: 114.2 },
	{ name: "tokyo", url: "wss://tokyo.example.com", label: "Tokyo", lat: 35.7, lon: 139.7 },
];

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	localStorage.clear();
});

/** A lobby whose server list arrives when the test says. */
function lobby() {
	let answer: (relays: typeof RELAYS) => void = () => {};
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL) => {
			if (String(input).includes("/api/relays")) {
				return new Promise<Response>((resolve) => {
					answer = (relays) =>
						resolve(new Response(JSON.stringify({ relays, measure: false, fleet: { online: relays.length, total: relays.length } })));
				});
			}
			return Promise.resolve(new Response(String(input).includes("meetings") ? "[]" : "{}"));
		}),
	);
	render(<Lobby me={{ name: "Ada", trip: "t1" }} onOpen={vi.fn()} onSignedOut={vi.fn()} />);
	const servers = () => screen.queryByRole("region", { name: "Server" });
	return { servers, answer: (relays: typeof RELAYS) => act(async () => answer(relays)) };
}

it("keeps a place for the servers while their list is on its way, where it was two blocks before", async () => {
	localStorage.setItem(KEY, "yes");
	const { servers, answer } = lobby();
	await act(async () => {});
	expect(servers(), "drawn as one column until the list came").not.toBeNull();

	await answer(RELAYS);
	expect(servers()).not.toBeNull();
});

it("draws one column while the list is on its way where it was one before, and remembers what the list says", async () => {
	localStorage.setItem(KEY, "no");
	const { servers, answer } = lobby();
	await act(async () => {});
	expect(servers(), "a second block for a deployment that had one server").toBeNull();

	await answer(RELAYS);
	expect(servers()).not.toBeNull();
	expect(localStorage.getItem(KEY)).toBe("yes");
});

it("takes a browser that has not seen the lobby for one with servers to choose between", async () => {
	const { servers } = lobby();
	await act(async () => {});
	expect(servers()).not.toBeNull();
});
