import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resolved } from "@/live/watch-api";
import { WatchScreen } from "./WatchScreen";

/*
A YouTube video for a viewer who cannot reach YouTube.

What this guards is the whole reason a deployment that relays nothing else
turns its YouTube switch on: somebody in mainland China, whose browser never
gets YouTube's player script, is moved onto the relay without anybody doing
anything — and only where the server said there is one. The server says so per
ticket (X-Watch-Relay, read into `proxy` by watch-api.ts); a player that fell
back regardless would ask for a relay that answers 404, and one that never fell
back would leave the viewer at a black tile while everybody else watched.

And the relay it falls back to is held to the size of the tile: the owner chose
no ceiling at the source, so the player's own size is what keeps a phone in a
corner of the screen from being sent the 1080p a full-screen window would get.
*/

const { hlsMade, info, seen } = vi.hoisted(() => {
	const ticket = "youtube0000000000000001";

	return {
		hlsMade: [] as { config: Record<string, unknown>; loaded?: string }[],
		info: { current: undefined as unknown },
		seen: {
			show: {
				holder: "h",
				holderName: "Holder",
				now: { key: "k1", by: "Ada", ticket, duration: 60, live: false },
				queue: [],
				playing: true,
				position: 0,
				version: 1,
			},
			at: 0,
		},
	};
});

// Unreachable, as it is from the mainland: the script fails to load.
vi.mock("@/live/youtube", () => ({
	ENDED: 0,
	PLAYING: 1,
	PAUSED: 2,
	BUFFERING: 3,
	youtubeApi: () => Promise.reject(new Error("YouTube could not be reached")),
}));

vi.mock("@/live/watch", () => ({
	CLOSE_ENOUGH: 0.12,
	command: vi.fn(),
	correction: () => ({ rate: 1 }),
	expected: () => 0,
	myTheatre: () => undefined,
	seenShow: () => seen,
	subscribeShow: () => () => {},
}));

vi.mock("@/hooks/useVideoInfo", () => ({ useVideoInfo: () => info.current }));

vi.mock("hls.js", () => {
	class Hls {
		static Events = {
			MANIFEST_PARSED: "manifest",
			LEVELS_UPDATED: "levels",
			MAX_AUTO_LEVEL_UPDATED: "max",
			ERROR: "error",
		};
		static isSupported = () => true;
		made: { config: Record<string, unknown>; loaded?: string };
		autoLevelCapping = -1;
		levels = [];
		constructor(config: Record<string, unknown>) {
			this.made = { config };
			hlsMade.push(this.made);
		}
		on() {}
		loadSource(url: string) {
			this.made.loaded = url;
		}
		attachMedia() {}
		destroy() {}
	}

	return { default: Hls };
});

const youtube = (relayed: boolean): Resolved => ({
	ticket: seen.show.now.ticket,
	title: "A video",
	duration: 60,
	cover: "",
	link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	live: false,
	relay: false,
	play: { kind: "youtube", id: "dQw4w9WgXcQ" },
	// What readResolved leaves when the server said X-Watch-Relay: off.
	proxy: relayed ? { kind: "hls", url: `/api/watch/media?t=${seen.show.now.ticket}` } : undefined,
});

beforeEach(() => {
	hlsMade.length = 0;
	// jsdom has no media pipeline; these are the calls the player makes of it.
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

// Unmounted before the stubs go: the player's cleanup calls load().
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("a YouTube video YouTube cannot be reached for", () => {
	it("plays through the relay where the server offers one, held to the player's size", async () => {
		info.current = youtube(true);

		await act(async () => {
			render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
		});

		await waitFor(() => expect(hlsMade[0]?.loaded).toBe(`/api/watch/media?t=${seen.show.now.ticket}`));

		expect(hlsMade[0]?.config.capLevelToPlayerSize).toBe(true);
		expect(screen.getByText(/Relayed/)).toBeDefined();
		expect(screen.queryByText("This video does not reach you")).toBeNull();
	});

	it("says it does not reach the viewer where the server offers none", async () => {
		info.current = youtube(false);

		await act(async () => {
			render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
		});

		expect(await screen.findByText("This video does not reach you")).toBeDefined();
		expect(hlsMade).toEqual([]);
	});
});
