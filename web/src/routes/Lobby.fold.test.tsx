import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Lobby } from "./Lobby";

/*
 * Starting and joining fold away while a meeting is being arranged, which the
 * owner asked for: with the form open they were two cards to read past on the
 * way to it, and on a phone they pushed it a screen down. What would go wrong
 * quietly is that folded away is not gone: a form nobody can see that a tab
 * still lands in, or one that forgets the name somebody had typed into it by
 * the time it comes back.
 */

const RELAYS = [
	{ name: "hk", url: "wss://hk.example.com", label: "Hong Kong", lat: 22.3, lon: 114.2 },
	{ name: "tokyo", url: "wss://tokyo.example.com", label: "Tokyo", lat: 35.7, lon: 139.7 },
];

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const address = String(input);
			if (address.includes("/api/relays")) {
				return new Response(JSON.stringify({ relays: RELAYS, measure: false, fleet: { online: 2, total: 2 } }));
			}
			if (address.includes("arrangements")) return new Response("[]");
			return new Response("{}");
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function folding(button: string): HTMLElement {
	const card = screen.getByRole("button", { name: button }).closest("form");
	const fold = card?.closest("[data-folding]");
	if (!(fold instanceof HTMLElement)) throw new Error(`no fold around ${button}`);
	return fold;
}

it("folds starting and joining away while a meeting is arranged, out of reach, and brings them back as they were", async () => {
	render(<Lobby me={{ name: "Ada", trip: "t1" }} onOpen={vi.fn()} onSignedOut={vi.fn()} />);
	await act(async () => {});

	const name = screen.getByRole("combobox", { name: "Name for the new room" }) as HTMLInputElement;
	fireEvent.change(name, { target: { value: "standup" } });

	expect(folding("Start").dataset.folding).toBe("open");
	expect(folding("Start").inert).toBe(false);

	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));
	await act(async () => {});
	for (const card of ["Start", "Join"]) {
		expect(folding(card).dataset.folding, `${card} stayed open beside the form`).toBe("folded");
		expect(folding(card).inert, `${card} is folded away and still reachable`).toBe(true);
	}

	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));
	await act(async () => {});
	expect(folding("Start").dataset.folding).toBe("open");
	expect(folding("Start").inert).toBe(false);
	expect(name.value, "the name typed before was lost").toBe("standup");
});
