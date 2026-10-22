import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resolved } from "@/live/watch-api";
import { WatchScreen } from "./WatchScreen";

/*
A Bilibili bangumi episode, as every viewer plays it.

The deployment relays bangumi for everybody (the owner, 2026-10-14), because
an episode's whole -- a members' episode -- and everything above 720p come only
through the relay. So what is held here is that a viewer plays the relay from
the start, with nothing else tried first: there is no address of its own to
try, and an attempt at one would be a black tile for STALL_MS on every episode.
And that the relay is held to the player's size, as YouTube's is for a viewer
who cannot reach YouTube: relaying for everybody is the deployment's bandwidth
times everybody, and a phone in a corner of the screen has no use for 4K.

Where the server said it will not relay the ticket (the switch turned off after
the episode was queued), the page has no player to show and says the video
cannot be played here; not "could not be read, try again", which no retry
cures.

And where the relay stops partway -- the switch turned off mid-episode, or the
relay failing to renew Bilibili's addresses for longer than hls.js retries --
the player is not left at its last frame with nothing said, which is what a
fatal error after the first frame used to leave: hls.js loads nothing more
after one. The server is asked about the ticket again; told it will not relay
it, the page says so, and otherwise the relay is started again a few times and
then the viewer is told it stopped and given a press.
*/

interface Made {
	config: Record<string, unknown>;
	loaded?: string;
	handlers: Record<string, ((...args: unknown[]) => void)[]>;
	started: number;
	recovered: number;
}

const { again, hlsMade, info, seen, youtubeAsked } = vi.hoisted(() => {
	const ticket = "bangumi0000000000000001";
	const listeners = new Set<() => void>();

	return {
		hlsMade: [] as Made[],
		// What the screen is told the ticket plays, changed as the page's own
		// record of it would be, so that the screen hears the change.
		info: {
			current: undefined as unknown,
			listeners,
			set(value: unknown) {
				this.current = value;
				for (const listener of listeners) listener();
			},
		},
		// The server asked about the ticket again, and what it says.
		again: { asked: [] as string[], answer: "playable" as "playable" | "unavailable" | "failed" },
		youtubeAsked: { count: 0 },
		seen: {
			show: {
				holder: "h",
				holderName: "Holder",
				now: { key: "k1", by: "Ada", ticket, duration: 1450, live: false },
				queue: [],
				playing: true,
				position: 0,
				version: 1,
			},
			at: 0,
		},
	};
});

vi.mock("@/live/youtube", () => ({
	ENDED: 0,
	PLAYING: 1,
	PAUSED: 2,
	BUFFERING: 3,
	youtubeApi: () => {
		youtubeAsked.count++;
		return Promise.reject(new Error("not for a bangumi episode"));
	},
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

vi.mock("@/hooks/useVideoInfo", async () => {
	const { useSyncExternalStore } = await import("react");
	return {
		useVideoInfo: () =>
			useSyncExternalStore(
				(listener: () => void) => {
					info.listeners.add(listener);
					return () => info.listeners.delete(listener);
				},
				() => info.current,
			),
	};
});

// askAgain as it behaves (watch-api.test.ts holds it to this): the server asked
// again, and only its saying it will not relay the ticket replacing what the
// page knew.
vi.mock("@/live/watch-api", async (importOriginal) => {
	const real = await importOriginal<typeof import("@/live/watch-api")>();
	return {
		...real,
		askAgain: async (ticket: string) => {
			again.asked.push(ticket);
			if (again.answer === "unavailable") info.set("unavailable");
			return again.answer === "playable" ? info.current : again.answer;
		},
	};
});

vi.mock("hls.js", () => {
	class Hls {
		static Events = {
			MANIFEST_PARSED: "manifest",
			LEVELS_UPDATED: "levels",
			MAX_AUTO_LEVEL_UPDATED: "max",
			ERROR: "error",
		};
		static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
		static isSupported = () => true;
		made: Made;
		autoLevelCapping = -1;
		levels = [];
		constructor(config: Record<string, unknown>) {
			this.made = { config, handlers: {}, started: 0, recovered: 0 };
			hlsMade.push(this.made);
		}
		on(event: string, handler: (...args: unknown[]) => void) {
			this.made.handlers[event] ??= [];
			this.made.handlers[event].push(handler);
		}
		loadSource(url: string) {
			this.made.loaded = url;
		}
		attachMedia() {}
		startLoad() {
			this.made.started++;
		}
		recoverMediaError() {
			this.made.recovered++;
		}
		destroy() {}
	}

	return { default: Hls };
});

const relayed = `/api/watch/media?t=${seen.show.now.ticket}`;

const episode: Resolved = {
	ticket: seen.show.now.ticket,
	title: "间谍过家家 · 第2话 任务2 寻找妻子",
	duration: 1450,
	cover: "",
	link: "https://www.bilibili.com/bangumi/play/ep508405",
	live: false,
	relay: false,
	play: { kind: "bangumi" },
	proxy: { kind: "hls", url: relayed },
};

const played: string[] = [];

beforeEach(() => {
	hlsMade.length = 0;
	played.length = 0;
	youtubeAsked.count = 0;
	again.asked.length = 0;
	again.answer = "playable";
	info.listeners.clear();
	// jsdom has no media pipeline; these are the calls the player makes of it.
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
	// Anything given to the video element itself would be an address of the
	// episode's own, which there is none of.
	const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
	vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(function (this: HTMLMediaElement, value: string) {
		played.push(value);
		src?.set?.call(this, value);
	});
});

// Unmounted before the stubs go: the player's cleanup calls load().
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("a bangumi episode", () => {
	it("plays through the relay from the start, held to the player's size", async () => {
		info.current = episode;

		await act(async () => {
			render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
		});

		await waitFor(() => expect(hlsMade[0]?.loaded).toBe(relayed));

		expect(hlsMade[0]?.config.capLevelToPlayerSize).toBe(true);
		expect(hlsMade).toHaveLength(1);
		expect(played).toEqual([]);
		expect(youtubeAsked.count).toBe(0);
		expect(screen.queryByText("This video does not reach you")).toBeNull();
	});

	it("says it cannot be played here where the server will not relay it, and plays nothing", async () => {
		info.current = "unavailable";

		await act(async () => {
			render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
		});

		expect(await screen.findByText("That video cannot be played here.")).toBeDefined();
		expect(screen.queryByText("The video could not be read. Try again.")).toBeNull();
		expect(hlsMade).toEqual([]);
		expect(played).toEqual([]);
	});

	it("still says a ticket that could not be read at all could not be read", async () => {
		info.current = "failed";

		await act(async () => {
			render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
		});

		expect(await screen.findByText("The video could not be read. Try again.")).toBeDefined();
	});
});

/** The episode on screen, its relay loaded, and -- unless `playing` is false -- its first frame shown. */
async function playingEpisode(playing = true): Promise<Made> {
	info.current = episode;

	await act(async () => {
		render(<WatchScreen room={{} as Room} onStage onOpenPanel={() => {}} />);
	});

	await waitFor(() => expect(hlsMade[0]?.loaded).toBe(relayed));
	if (playing) {
		await act(async () => {
			document.querySelector("video")?.dispatchEvent(new Event("playing"));
		});
	}

	const made = hlsMade[0];
	if (!made) throw new Error("no player was made");
	return made;
}

/** hls.js giving up, as it does once it has retried a piece for long enough. */
async function fatal(made: Made, type = "networkError") {
	await act(async () => {
		for (const handler of made.handlers.error ?? []) handler("hlsError", { fatal: true, type, details: "fragLoadError" });
	});
}

describe("a bangumi episode whose relay stops partway", () => {
	it("asks the server again and starts the relay again, then says it stopped and starts it on a press", async () => {
		const made = await playingEpisode();
		const playsAgain = async () => {
			await act(async () => {
				document.querySelector("video")?.dispatchEvent(new Event("playing"));
			});
		};

		await fatal(made);
		expect(again.asked).toEqual([seen.show.now.ticket]);
		expect(await screen.findByText("Reconnecting…")).toBeDefined();
		await waitFor(() => expect(made.started).toBe(1));

		// Playing again: nothing said any more, and its own tries counted
		// from nought the next time it stops.
		await playsAgain();
		await waitFor(() => expect(screen.queryByText("Reconnecting…")).toBeNull());
		await fatal(made);
		await waitFor(() => expect(made.started).toBe(2));
		await fatal(made);
		await waitFor(() => expect(made.started).toBe(3));

		// Started again as often as it will be by itself: said, with a press.
		await fatal(made);
		expect(await screen.findByText("The video stopped coming through.")).toBeDefined();
		expect(again.asked).toHaveLength(4);
		expect(made.started).toBe(3);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(made.started).toBe(4);
		expect(await screen.findByText("Reconnecting…")).toBeDefined();
		await playsAgain();
		await waitFor(() => expect(screen.queryByText("Reconnecting…")).toBeNull());
		expect(hlsMade).toHaveLength(1);
	});

	it("says it cannot be played here where the server says it no longer relays it", async () => {
		const made = await playingEpisode();
		again.answer = "unavailable";

		await fatal(made);

		expect(await screen.findByText("That video cannot be played here.")).toBeDefined();
		expect(again.asked).toEqual([seen.show.now.ticket]);
		expect(made.started).toBe(0);
		expect(screen.queryByText("The video stopped coming through.")).toBeNull();
	});

	it("recovers a decoder that choked rather than loading again", async () => {
		const made = await playingEpisode();

		await fatal(made, "mediaError");

		await waitFor(() => expect(made.recovered).toBe(1));
		expect(made.started).toBe(0);
	});

	it("is not asked about again for a failure before it ever played, which is the relay not working at all", async () => {
		const made = await playingEpisode(false);

		await fatal(made);

		expect(again.asked).toEqual([]);
		expect(made.started).toBe(0);
		expect(screen.queryByText("Reconnecting…")).toBeNull();
	});
});
