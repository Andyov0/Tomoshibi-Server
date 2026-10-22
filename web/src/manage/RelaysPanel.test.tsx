import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Relay } from "./api";
import { RelaysPanel } from "./RelaysPanel";

/*
 * What this guards is a button that asks a question about the wrong machines.
 *
 * The measurement on every row is taken while the list is drawn, so re-reading
 * the list refreshes all of them — which made re-reading the list a plausible
 * implementation of the button on one row, and it was the one this page had.
 * It is not visibly wrong: the row does update, with a true reading, and the
 * only witnesses are a fleet dialled eleven times over for one answer and a
 * spinner that keeps turning until the slowest machine in the deployment
 * replies. On a fleet where something is genuinely down that is the full
 * timeout on every press, and the row it appears to be about is a relay that is
 * perfectly well.
 *
 * Nothing about that fails a type check or throws, which is why the count of
 * calls is what is asserted here rather than what ends up on screen.
 */

const { list, checkRelay, reorderRelays } = vi.hoisted(() => ({
	list: vi.fn(),
	checkRelay: vi.fn(),
	reorderRelays: vi.fn(),
}));

vi.mock("./api", () => ({
	// The poll reaches for this to tell a lost session from a failure.
	SignedOut: class SignedOut extends Error {},
	api: {
		relays: list,
		checkRelay,
		reorderRelays,
		editRelay: vi.fn(),
		dropRelay: vi.fn(),
		relayScript: vi.fn(),
		relayCommand: vi.fn(),
	},
}));

function answering(name: string, ms: number): Relay {
	return {
		name,
		url: `wss://${name}.example:39217`,
		enabled: true,
		reachable: true,
		latencyMs: ms,
	};
}

describe("a relay's own button", () => {
	it("measures that relay and leaves the rest of the fleet alone", async () => {
		list.mockResolvedValue({
			relays: [answering("alpha", 40), answering("bravo", 220), answering("charlie", 90)],
		});
		checkRelay.mockResolvedValue(answering("bravo", 7));

		render(<RelaysPanel canRelays onSignedOut={vi.fn()} />);

		await screen.findByText("wss://bravo.example:39217");
		expect(list).toHaveBeenCalledTimes(1);

		const buttons = screen.getAllByLabelText("Measure again");
		expect(buttons).toHaveLength(3);

		fireEvent.click(buttons[1] as HTMLElement);

		await waitFor(() => expect(checkRelay).toHaveBeenCalledWith("bravo"));

		// The whole point. Reading the list again would measure all three and
		// would look, from the row, exactly like this.
		expect(list).toHaveBeenCalledTimes(1);

		// The new reading lands on the row that asked for it, and the rows that
		// did not ask keep the reading they had rather than being redrawn from a
		// measurement nobody took.
		await screen.findByText("Answered in 7 ms");
		expect(screen.getByText("Answered in 40 ms")).toBeDefined();
		expect(screen.getByText("Answered in 90 ms")).toBeDefined();
	});
});
