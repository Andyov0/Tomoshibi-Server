import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resolved } from "@/live/watch-api";
import { WatchScreen } from "./WatchScreen";

/*
 * A YouTube video for a viewer who came in through a relay in mainland China.
 *
 * YouTube is tried by waiting for it to fail, and from the mainland it always
 * fails: the player's script never arrives, and the viewer looked at a black
 * tile for up to six seconds, on every video, before being given the relay
 * they were always going to be given. The relay their call came in through
 * says where they are, so they go to the relay first and YouTube is not asked.
 *
 * Only where the server said there is a relay for that ticket. Where it said
 * X-Watch-Relay: off there is nothing to go to first, and the viewer is left
 * to try YouTube, which is all there is -- going "straight to the relay" there
 * would be going nowhere. And a viewer who came in anywhere else still tries
 * YouTube first, since for them it is the better picture and costs the
 * deployment nothing.
 */

const { hlsMade, info, seen, youtubeApi } = vi.hoisted(() => {
	const ticket = "youtube0000000000000002";

	return {
		hlsMade: [] as { config: Record<string, unknown>; loaded?: string }[],
		info: { current: undefined as unknown },
		// Never answers: the player would be waiting on it.
		youtubeApi: vi.fn(() => new Promise(() => {})),
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

vi.mock("@/live/youtube", () => ({ ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, youtubeApi }));

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

const relayed = `/api/watch/media?t=${seen.show.now.ticket}`;

const youtube = (relay: boolean): Resolved => ({
	ticket: seen.show.now.ticket,
	title: "A video",
	duration: 60,
	cover: "",
	link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
	live: false,
	relay: false,
	play: { kind: "youtube", id: "dQw4w9WgXcQ" },
	// What readResolved leaves when the server said X-Watch-Relay: off.
	proxy: relay ? { kind: "hls", url: relayed } : undefined,
});

async function watching(mainland: boolean) {
	await act(async () => {
		render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} mainland={mainland} />);
	});
}

beforeEach(() => {
	hlsMade.length = 0;
	youtubeApi.mockClear();
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
});

// Unmounted before the stubs go: the player's cleanup calls load().
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("a YouTube video, for a viewer who came in through the mainland", () => {
	it("plays through the relay at once, held to the player's size, and never asks YouTube", async () => {
		info.current = youtube(true);
		await watching(true);

		await waitFor(() => expect(hlsMade[0]?.loaded).toBe(relayed));

		expect(youtubeApi).not.toHaveBeenCalled();
		// The same relay a viewer falls back to, held to the tile, rather than
		// one chosen for a quality only it carries.
		expect(hlsMade[0]?.config.capLevelToPlayerSize).toBe(true);
		expect(screen.getByText(/Relayed/)).toBeDefined();
	});

	it("still tries YouTube where the server relays nothing for the ticket", async () => {
		info.current = youtube(false);
		await watching(true);

		await waitFor(() => expect(youtubeApi).toHaveBeenCalled());
		expect(hlsMade).toEqual([]);
	});

	it("and, where YouTube does not arrive either, says so rather than showing a black tile", async () => {
		// The case the rest of this file is about, with the relay switched off:
		// YouTube's script fails to arrive, there is nothing to fall back to,
		// and the viewer is told their connection does not reach the site --
		// while everybody else goes on watching. The tests above never let
		// youtubeApi answer, so they could not see this sentence.
		youtubeApi.mockImplementationOnce(() => Promise.reject(new Error("the script did not arrive")));
		info.current = youtube(false);
		await watching(true);

		await waitFor(() => expect(screen.getByText("This video does not reach you")).toBeDefined());
		expect(screen.getByText("Your connection cannot reach youtube.com. Everybody else goes on watching.")).toBeDefined();
		expect(hlsMade).toEqual([]);
	});
});

describe("a YouTube video, for a viewer who came in anywhere else", () => {
	it("tries YouTube first, relay or no relay", async () => {
		info.current = youtube(true);
		await watching(false);

		await waitFor(() => expect(youtubeApi).toHaveBeenCalled());
		expect(hlsMade).toEqual([]);
		expect(screen.queryByText(/Relayed/)).toBeNull();
	});
});
