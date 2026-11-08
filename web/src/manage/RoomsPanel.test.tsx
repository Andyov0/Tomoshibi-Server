import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Participant } from "./api";
import { RoomsPanel } from "./RoomsPanel";

/*
 * What the rooms page says about the people in a call.
 *
 * The redesign drew each track as a chip and moved its layers into a tooltip,
 * which a finger cannot open and nobody thinks to point at, and the owner
 * noticed the page saying less than it had (2026-11-01). The layers — each
 * height and the rate it is allowed — are how anybody tells whether a share is
 * going out at full resolution, so they are held here on the page itself, not
 * in a title.
 */

const { rooms, participants, visits } = vi.hoisted(() => ({
	rooms: vi.fn(),
	participants: vi.fn(),
	visits: vi.fn(),
}));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: {
		rooms,
		participants,
		visits,
		relays: async () => ({ relays: [] }),
		policy: () => new Promise(() => {}),
		settings: () => new Promise(() => {}),
		accounts: () => new Promise(() => {}),
		admins: () => new Promise(() => {}),
	},
}));

const sharing: Participant = {
	identity: "tada0000000-1",
	name: "Ada",
	sid: "PA_1",
	state: "ACTIVE",
	joinedAt: new Date(Date.now() - 60_000).toISOString(),
	publisher: true,
	trip: { mark: "ada0000000", proven: true },
	tracks: [
		{
			sid: "TR_1",
			source: "SCREEN_SHARE",
			kind: "VIDEO",
			muted: false,
			width: 1920,
			height: 1080,
			mime: "video/VP8",
			simulcast: true,
			layers: [
				{ quality: "LOW", width: 640, height: 360, bitrate: 450_000 },
				{ quality: "HIGH", width: 1920, height: 1080, bitrate: 2_500_000 },
			],
		},
	],
};

describe("a person in a call", () => {
	it("says each track's layers on the page, and how often a name has been used", async () => {
		rooms.mockResolvedValue({
			live: [{ name: "standup", sid: "RM_1", participants: 1, publishers: 1, createdAt: new Date().toISOString() }],
			known: [{ name: "standup", firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-29T00:00:00Z", joins: 12 }],
		});
		participants.mockResolvedValue([sharing]);
		visits.mockResolvedValue({ room: "standup", visits: [] });

		render(<RoomsPanel canRooms={false} canSettings={false} onSignedOut={vi.fn()} />);

		expect(await screen.findByText("12 joins")).toBeDefined();

		fireEvent.click((await screen.findAllByText("standup"))[0] as HTMLElement);

		const track = (await screen.findByText("Screen")).closest("li") as HTMLElement;
		expect(within(track).getByText("360p 450 kbps, 1080p 2.5 Mbps")).toBeDefined();
		expect(within(track).getByText("in layers")).toBeDefined();
		expect(within(track).getByText("1920×1080")).toBeDefined();
	});
});
