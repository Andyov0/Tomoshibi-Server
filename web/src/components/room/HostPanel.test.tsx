import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Participant, Room } from "livekit-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Handing the room to somebody who cannot hold it.
 *
 * The server refuses a room to a guest -- an identity drawn from nothing, worn
 * by whoever reads it -- and it used to refuse with the code it uses for
 * somebody who is not there, which this panel says as "they have already
 * left". So a host pressing the crown beside a guest still plainly in the call
 * was told the guest had gone. Two things hold it now, and each is tested on
 * its own: the panel does not send the request for a guest, and says why; and
 * the server's own refusal, should it come back for anybody, is said as what
 * it is rather than as a departure.
 */

const { others, handOver, actionFailed } = vi.hoisted(() => ({
	others: { current: [] as Participant[] },
	handOver: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("@/live/host", () => ({
	dissolve: vi.fn(),
	handOver,
	invite: vi.fn(),
	moveRoom: vi.fn(),
	revoke: vi.fn(),
	silence: vi.fn(),
	turnOut: vi.fn(),
	useOthers: () => others.current,
}));
vi.mock("@/live/notices", () => ({ actionDone: vi.fn(), actionFailed, atTheDoor: () => () => {} }));
vi.mock("@/live/relays", () => ({ relays: async () => ({ relays: [], measure: false }) }));
vi.mock("./AtTheDoor", () => ({ AtTheDoor: () => null, useTheDoor: () => ({ waiting: [] }) }));

import { HostPanel } from "./HostPanel";

const GUEST = "gabcdefghij-0123456789abcdef";
const PROVEN = "tklmnopqrst-0123456789abcdef";
const SAID = "They joined without a passphrase, so they cannot run the room. Ask them to rejoin with one.";

function person(identity: string, name: string): Participant {
	return { identity, name, isMicrophoneEnabled: false } as unknown as Participant;
}

/** Rendered, with the list of servers it asks for on opening answered. */
async function panel() {
	await act(async () => {
		render(
			<HostPanel
				door={{ waiting: [], busy: undefined, decide: () => {} } as never}
				room={{ name: "standup" } as Room}
				standing={{ yours: true, admin: false } as never}
				onClose={() => {}}
			/>,
		);
	});
}

/** The crown on one person's row. */
function crown(name: string): HTMLElement {
	const row = screen.getByText(name).closest("li");
	if (!row) throw new Error(`no row for ${name}`);

	const button = row.querySelector<HTMLElement>('button[aria-label="Make host"]');
	if (!button) throw new Error(`no crown for ${name}`);

	return button;
}

beforeEach(() => {
	handOver.mockReset();
	actionFailed.mockReset();
	others.current = [person(GUEST, "Guest"), person(PROVEN, "Proven")];
});

describe("handing the room over", () => {
	it("is shown as unavailable beside a guest, with the reason", async () => {
		await panel();

		expect(crown("Guest").getAttribute("aria-disabled")).toBe("true");
		expect(crown("Guest").getAttribute("title")).toBe(SAID);
		expect(crown("Proven").getAttribute("aria-disabled")).toBeNull();
	});

	it("says the reason to a host who presses it for a guest, and asks the server nothing", async () => {
		await panel();

		fireEvent.click(crown("Guest"));

		expect(handOver).not.toHaveBeenCalled();
		expect(actionFailed).toHaveBeenCalledWith(SAID);
	});

	it("hands the room to somebody who joined with a passphrase", async () => {
		handOver.mockResolvedValue(undefined);
		await panel();

		await act(async () => {
			fireEvent.click(crown("Proven"));
		});

		expect(handOver).toHaveBeenCalledTimes(1);
		expect(actionFailed).not.toHaveBeenCalled();
	});

	it("says the server's refusal of an unproven name as that, not as somebody having left", async () => {
		handOver.mockRejectedValue(new Error("not_proven"));
		await panel();

		await act(async () => {
			fireEvent.click(crown("Proven"));
		});

		expect(actionFailed).toHaveBeenCalledWith(SAID);
		expect(actionFailed).not.toHaveBeenCalledWith("They have already left.");
	});
});
