import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const { list, checkRelay, reorderRelays, relayScript, relayCommand, mintEnrolment } = vi.hoisted(() => ({
	list: vi.fn(),
	checkRelay: vi.fn(),
	reorderRelays: vi.fn(),
	relayScript: vi.fn(),
	relayCommand: vi.fn(),
	mintEnrolment: vi.fn(),
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
		relayScript,
		relayCommand,
		mintEnrolment,
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

/*
 * The token a new machine enrols with buys the deployment's key pair, so it is
 * minted here, for one prefix, as the first step of adding a machine, and shown
 * beside the command rather than inside it: what is typed is what a shell
 * keeps. It is drawn hidden until asked for, because the sheet is read on a
 * screen somebody else may be looking at, and copied whole either way. And
 * somebody who may not mint one is told so rather than shown a form the server
 * will refuse.
 */
describe("adding a machine", () => {
	const opening = async (canEnrol: boolean) => {
		list.mockResolvedValue({ relays: [] });
		relayScript.mockResolvedValue("#!/bin/sh\n");
		relayCommand.mockResolvedValue({
			command: "bash <(curl -fLSs https://meet.example.com/install) <prefix>",
			domain: "relays.example.com",
			port: 443,
		});

		render(<RelaysPanel canRelays canEnrol={canEnrol} onSignedOut={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));

		return screen.findByRole("dialog", { name: "Add a machine" });
	};

	it("mints a token for the prefix typed, keeps it out of the command, and hides it until asked", async () => {
		mintEnrolment.mockResolvedValue({
			token: "the-one-time-token",
			command: "bash <(curl -fLSs https://meet.example.com/install) tokyo",
			domain: "relays.example.com",
			port: 443,
			grant: { prefix: "tokyo", expires: new Date(Date.now() + 1_800_000).toISOString() },
		});

		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

		const sheet = await opening(true);

		fireEvent.change(await within(sheet).findByLabelText("Prefix"), { target: { value: " Tokyo " } });
		fireEvent.click(within(sheet).getByRole("button", { name: "Make a token" }));

		await waitFor(() =>
			expect(mintEnrolment).toHaveBeenCalledWith({ prefix: "tokyo", replace: false, from: undefined }),
		);

		const command = await within(sheet).findByText("bash <(curl -fLSs https://meet.example.com/install) tokyo");
		expect(command.textContent).not.toContain("the-one-time-token");
		expect(within(sheet).queryByText("the-one-time-token")).toBeNull();

		// Copied whole while hidden: the second Copy is the token's.
		const copies = within(sheet).getAllByRole("button", { name: "Copy" });
		fireEvent.click(copies[0] as HTMLElement);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith("the-one-time-token"));

		fireEvent.click(within(sheet).getByRole("button", { name: "Show the secret" }));
		expect(within(sheet).getByText("the-one-time-token")).toBeDefined();
	});

	it("asks again before minting a token that takes over a name", async () => {
		const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
		mintEnrolment.mockClear();

		const sheet = await opening(true);

		fireEvent.change(await within(sheet).findByLabelText("Prefix"), { target: { value: "tokyo" } });
		fireEvent.click(within(sheet).getByLabelText("Takes over the relay already called this"));
		fireEvent.click(within(sheet).getByRole("button", { name: "Make a token" }));

		await waitFor(() => expect(confirm).toHaveBeenCalled());
		expect(mintEnrolment).not.toHaveBeenCalled();

		confirm.mockRestore();
	});

	it("says who can mint one to somebody who cannot", async () => {
		const sheet = await opening(false);

		await within(sheet).findByText(
			"The machine needs a token to enrol, and only an administrator who can manage everything can make one.",
		);
		expect(within(sheet).queryByRole("button", { name: "Make a token" })).toBeNull();
		// The line and what it runs are still theirs to read.
		expect(within(sheet).getByText("bash <(curl -fLSs https://meet.example.com/install) <prefix>")).toBeDefined();
	});
});

/*
 * Two states a row names and its sheet says in full. A relay that signals
 * through another is one no TLS reaches, and without a probe address a client
 * measures it by opening TLS to it; and one with nothing answering to carry
 * its signalling is offered to nobody.
 */
describe("a relay that signals through another", () => {
	it("is named on its row when it has no probe address, and said in full in its sheet", async () => {
		list.mockResolvedValue({
			relays: [
				{ ...answering("guangzhou", 30), signalVia: "hongkong" },
				{ ...answering("shanghai", 30), signalVia: "hongkong", probe: "sh.example:39218" },
				answering("hongkong", 20),
			],
		});

		render(<RelaysPanel canRelays onSignedOut={vi.fn()} />);

		expect(await screen.findAllByText("Needs a probe address")).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: /guangzhou/i }));
		const sheet = await screen.findByRole("dialog");
		await within(sheet).findByText(
			"Signals through another relay and has no probe address, so clients measure it by opening TLS to it. Set where it is measured.",
		);
	});

	it("says it is offered to nobody, and why, when nothing can carry its signalling", async () => {
		list.mockResolvedValue({
			relays: [
				{ ...answering("guangzhou", 30), signalVia: "hongkong", probe: "gz.example:39218", unavailable: "no_signalling" },
				{ ...answering("shanghai", 30), signalVia: "hongkong", probe: "sh.example:39218" },
			],
		});

		render(<RelaysPanel canRelays onSignedOut={vi.fn()} />);

		expect(await screen.findAllByText("Offered to nobody")).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: /guangzhou/i }));
		const sheet = await screen.findByRole("dialog");
		await within(sheet).findByText(
			"Offered to nobody: no relay that signals for itself is answering to carry its signalling, and clients never connect to it directly.",
		);
	});
});

/*
 * A relay that did not answer says why in plain words and, under them, in the
 * machine's own, on its row: the second is the difference between a refused
 * connection and an expired certificate, and the row said it before the
 * redesign moved it into the sheet (2026-11-01).
 */
describe("a relay that did not answer", () => {
	it("says the machine's own words on its row", async () => {
		list.mockResolvedValue({
			relays: [{ ...answering("delta", 0), reachable: false, detail: "dial tcp 203.0.113.9:443: connect: connection refused" }],
		});

		render(<RelaysPanel canRelays onSignedOut={vi.fn()} />);

		expect(await screen.findByText("dial tcp 203.0.113.9:443: connect: connection refused")).toBeDefined();
		expect(screen.getByText(/Nothing is listening there/)).toBeDefined();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
