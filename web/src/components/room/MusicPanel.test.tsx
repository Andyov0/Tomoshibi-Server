import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Room } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberedDucking } from "@/live/duck";
import { setBlocked, settingFor } from "@/live/hearing";
import { closeDesk, hearDesks } from "@/live/jukebox";
import { MusicPanel } from "./MusicPanel";

/*
The music panel.

What it must get right is what it hands the desk and the player: the address of
the track it was pressed on, at the rate the library read off that file -- a
wrong rate is a resampled track, which is the loss the whole path exists to
avoid -- and nothing at all for a track the account may not play. Somebody who
cannot reach the library asks the desk rather than playing anything, and the
volume each listener sets is theirs: the holder's own slider turns down their
speakers and nothing that is sent, a listener's turns down the holder's shared
sound for them alone.
*/

const searchLibrary = vi.fn();
const describeTrack = vi.fn();
const readLink = vi.fn();
const fetchLibraryTrack = vi.fn();
const playDecoded = vi.fn(async () => {});
const setMonitorVolume = vi.fn();
const actionFailed = vi.fn();

vi.mock("@/live/music", async (original) => {
	const real = await original<typeof import("@/live/music")>();
	return {
		...real,
		searchLibrary: (...args: unknown[]) => searchLibrary(...args),
		describeTrack: (...args: unknown[]) => describeTrack(...args),
		readLink: (...args: unknown[]) => readLink(...args),
	};
});

vi.mock("@/live/sound", async (original) => {
	const real = await original<typeof import("@/live/sound")>();
	return {
		...real,
		fetchLibraryTrack: (...args: unknown[]) => fetchLibraryTrack(...args),
		playDecoded: (...args: unknown[]) => playDecoded(...(args as [])),
		stopListening: vi.fn(async () => {}),
		setMonitorVolume: (...args: unknown[]) => setMonitorVolume(...args),
		rememberedLossless: () => true,
	};
});

vi.mock("@/live/notices", () => ({
	actionFailed: (...args: unknown[]) => actionFailed(...args),
	losslessGaveUp: vi.fn(),
}));

type Handler = (...args: unknown[]) => void;

function fakeRoom(others: string[] = []) {
	const handlers = new Map<string, Set<Handler>>();
	const sent: { message: Record<string, unknown>; to?: string[] }[] = [];
	const person = (identity: string, isLocal: boolean) => ({
		identity,
		name: isLocal ? "Me" : identity.toUpperCase(),
		isLocal,
		trackPublications: new Map(),
	});

	const room = {
		options: {},
		remoteParticipants: new Map(others.map((id) => [id, person(id, false)])),
		localParticipant: {
			...person("gme-1", true),
			publishData: vi.fn(async (bytes: Uint8Array, options: { destinationIdentities?: string[] }) => {
				sent.push({ message: JSON.parse(new TextDecoder().decode(bytes)), to: options.destinationIdentities });
			}),
		},
		on(event: string, handler: Handler) {
			if (!handlers.has(event)) handlers.set(event, new Set());
			handlers.get(event)?.add(handler);
		},
		off(event: string, handler: Handler) {
			handlers.get(event)?.delete(handler);
		},
	};

	const hear = (identity: string, message: unknown) => {
		for (const handler of handlers.get("dataReceived") ?? [])
			handler(new TextEncoder().encode(JSON.stringify(message)), room.remoteParticipants.get(identity), 0, "jukebox");
	};

	return { room: room as unknown as Room, sent, hear };
}

const track = { id: "0039", title: "Sunny Day", artists: ["Jay"], album: "Ye Hui Mei", cover: "", duration: 269 };
const libraries = [{ id: "one", name: "Library one", signedIn: true }];

let rooms: Room[] = [];

/** The panel, for somebody who can reach these libraries, or none ("guest"). */
function show(room: Room, withLibraries: typeof libraries | "guest" = libraries) {
	rooms.push(room);
	render(<MusicPanel room={room} libraries={withLibraries === "guest" ? undefined : withLibraries} onClose={vi.fn()} />);
}

async function addFromSearch() {
	fireEvent.click(screen.getByRole("tab", { name: "Search" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Search songs" }), { target: { value: "sunny" } });
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	fireEvent.click(await screen.findByRole("button", { name: "Add Sunny Day" }));
}

beforeEach(() => {
	searchLibrary.mockReset().mockResolvedValue([track]);
	describeTrack.mockReset().mockResolvedValue({ format: "flac", rate: 44_100, channels: 2, bits: 24, tier: "lossless" });
	readLink.mockReset();
	fetchLibraryTrack.mockReset().mockImplementation(async (audio: { rate: number; now: unknown }) => ({
		buffer: {},
		rate: audio.rate,
		bits: 0,
		now: audio.now,
	}));
	playDecoded.mockClear();
	setMonitorVolume.mockClear();
	actionFailed.mockClear();
});

afterEach(async () => {
	cleanup();
	for (const room of rooms) await closeDesk(room);
	rooms = [];
	localStorage.clear();
});

describe("choosing a track", () => {
	it("starts the desk, which plays the track's address at the rate its file has", async () => {
		const { room } = fakeRoom();
		show(room);

		await addFromSearch();

		await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
		expect(searchLibrary).toHaveBeenCalledWith("one", "sunny");
		expect(describeTrack).toHaveBeenCalledWith("one", "0039", "lossless", expect.any(AbortSignal));
		const [audio] = fetchLibraryTrack.mock.calls[0] as [{ url: string; rate: number; now: { quality: string } }];
		expect(audio.url).toBe("/api/music/audio?source=one&id=0039&quality=lossless");
		expect(audio.rate).toBe(44_100);
		// What the sender needs to recover the file's own integers; see decodedToInt24.
		expect(audio).toMatchObject({ format: "flac", bits: 24 });
		expect(audio.now.quality).toBe("FLAC · 24-bit · 44.1 kHz");
		const [played, , lossless] = playDecoded.mock.calls[0] as unknown as [Room, unknown, boolean];
		expect(played).toBe(room);
		expect(lossless).toBe(true);

		fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));
		expect(screen.getByText("Sunny Day")).toBeTruthy();
		expect(screen.getByText(/Asked for by Me/)).toBeTruthy();
	});

	it("asks for the highest tier only when it is chosen", async () => {
		const { room } = fakeRoom();
		show(room);
		fireEvent.click(screen.getByRole("tab", { name: "Search" }));
		fireEvent.click(screen.getByRole("button", { name: "Highest" }));

		await addFromSearch();

		await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
		expect(describeTrack).toHaveBeenCalledWith("one", "0039", "best", expect.any(AbortSignal));
	});

	it("plays nothing, and says why, for a track the account may not play", async () => {
		describeTrack.mockResolvedValue("unavailable");
		const { room } = fakeRoom();
		show(room);

		await addFromSearch();

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith(expect.stringMatching(/Skipped Sunny Day/)));
		expect(playDecoded).not.toHaveBeenCalled();
	});

	it("says a library that is not signed in plays at most 320 kbps", () => {
		const { room } = fakeRoom();
		show(room, [{ id: "two", name: "Library two", signedIn: false }]);
		fireEvent.click(screen.getByRole("tab", { name: "Search" }));
		expect(screen.getByText(/at most 320 kbps/)).toBeTruthy();
	});

	it("starts on a library that is signed in", () => {
		const { room } = fakeRoom();
		show(room, [{ id: "two", name: "Library two", signedIn: false }, ...libraries]);
		fireEvent.click(screen.getByRole("tab", { name: "Search" }));
		expect(screen.getByRole("button", { name: "Library one" }).getAttribute("aria-pressed")).toBe("true");
	});
});

it("opens a pasted playlist and queues every song in it", async () => {
	readLink.mockResolvedValue({
		source: "one",
		kind: "playlist",
		title: "A mix",
		tracks: [track, { ...track, id: "0040", title: "Rainy Day" }],
	});
	const { room } = fakeRoom();
	show(room);

	fireEvent.click(screen.getByRole("tab", { name: "Playlist" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Playlist link" }), { target: { value: "listen https://example.invalid/p/1" } });
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
	fireEvent.click(await screen.findByRole("button", { name: "Add all" }));

	await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
	expect(readLink).toHaveBeenCalledWith("listen https://example.invalid/p/1");
	fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));
	expect(screen.getByText("Rainy Day")).toBeTruthy();
});

it("keeps an opened playlist through a look at the desk, and through closing the panel, until another is opened", async () => {
	readLink.mockResolvedValue({ source: "one", kind: "playlist", title: "A mix", tracks: [track] });
	const { room } = fakeRoom();
	show(room);
	fireEvent.click(screen.getByRole("tab", { name: "Playlist" }));
	fireEvent.change(screen.getByRole("textbox", { name: "Playlist link" }), { target: { value: "https://example.invalid/p/1" } });
	fireEvent.click(screen.getByRole("button", { name: "Open" }));
	await screen.findByText("A mix");

	fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));
	fireEvent.click(screen.getByRole("tab", { name: "Playlist" }));
	expect(screen.getByText("A mix")).toBeTruthy();

	cleanup();
	render(<MusicPanel room={room} libraries={libraries} onClose={vi.fn()} />);
	expect(screen.getByRole("tab", { name: "Playlist" }).getAttribute("aria-selected")).toBe("true");
	expect(screen.getByText("A mix")).toBeTruthy();
	expect((screen.getByRole("textbox", { name: "Playlist link" }) as HTMLInputElement).value).toBe("https://example.invalid/p/1");
});

describe("somebody who cannot reach the library", () => {
	const deskHeld = {
		holder: "gholder-2",
		holderName: "",
		now: { ...track, key: "k1", source: "one", by: "GHOLDER-2" },
		queue: [],
		votes: [],
		needed: 1,
		loading: false,
	};

	function listening() {
		const { room, sent, hear } = fakeRoom(["gholder-2"]);
		const stop = hearDesks(room, true);
		hear("gholder-2", { t: "state", state: deskHeld });
		show(room, "guest");
		return { room, sent, stop };
	}

	it("asks the desk for a song by name, and for a playlist by link, and plays nothing itself", async () => {
		const { sent, stop } = listening();
		const box = screen.getByRole("textbox", { name: "Ask for a song" });

		fireEvent.change(box, { target: { value: "sunny" } });
		fireEvent.click(screen.getByRole("button", { name: "Ask for a song" }));
		await waitFor(() => expect(sent.some((one) => one.message.t === "request")).toBe(true));

		fireEvent.change(box, { target: { value: "this https://example.invalid/p/1" } });
		fireEvent.click(screen.getByRole("button", { name: "Ask for a song" }));
		await waitFor(() => expect(sent.some((one) => one.message.t === "link")).toBe(true));

		const asked = sent.filter((one) => one.message.t === "request" || one.message.t === "link");
		expect(asked.map((one) => one.message)).toEqual([
			{ t: "request", query: "sunny" },
			{ t: "link", text: "this https://example.invalid/p/1" },
		]);
		expect(asked.every((one) => one.to?.join() === "gholder-2")).toBe(true);
		expect(screen.queryByRole("tab", { name: "Search" })).toBeNull();
		expect(playDecoded).not.toHaveBeenCalled();
		stop();
	});

	it("is asked to request a song when the desk is open and nothing is playing", () => {
		const { room, hear } = fakeRoom(["gholder-2"]);
		const stop = hearDesks(room, true);
		hear("gholder-2", { t: "state", state: { ...deskHeld, now: undefined } });
		show(room, "guest");

		expect(screen.getByText(/Nothing is playing/)).toBeTruthy();
		expect((screen.getByRole("textbox", { name: "Ask for a song" }) as HTMLInputElement).disabled).toBe(false);
		stop();
	});

	it("cannot ask anything of a desk nobody runs", () => {
		const { room } = fakeRoom(["gholder-2"]);
		show(room, "guest");

		expect((screen.getByRole("textbox", { name: "Ask for a song" }) as HTMLInputElement).disabled).toBe(true);
	});

	it("votes to skip, once", async () => {
		const { sent, stop } = listening();

		fireEvent.click(screen.getByRole("button", { name: "Vote to skip (0/1)" }));

		expect(sent.filter((one) => one.message.t === "vote")).toHaveLength(1);
		stop();
	});

	it("mutes the music for themselves alone, and neither the holder's voice nor their screen", () => {
		const { stop } = listening();

		fireEvent.click(screen.getByRole("button", { name: "Mute Music" }));

		expect(settingFor("gholder-2", "music").blocked).toBe(true);
		expect(settingFor("gholder-2", "voice").blocked).toBe(false);
		expect(settingFor("gholder-2", "screen").blocked).toBe(false);
		setBlocked("gholder-2", "music", false);
		stop();
	});
});

it("lets whoever runs the desk put it away once the music has run out", async () => {
	const { room, sent } = fakeRoom(["gfriend-2"]);
	show(room);
	await addFromSearch();
	await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
	const [, , , , ended] = playDecoded.mock.calls[0] as unknown as [Room, unknown, boolean, unknown, () => void];
	ended();
	fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));

	fireEvent.click(await screen.findByRole("button", { name: "Stop the desk" }));

	await waitFor(() => expect(screen.getByText(/Search a song or paste a playlist link/)).toBeTruthy());
	expect(sent.at(-1)?.message).toEqual({ t: "closed" });
});

it("lets anybody stop the music making way for speech, for themselves", async () => {
	const { room } = fakeRoom();
	show(room);
	await addFromSearch();
	await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
	fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));

	const box = screen.getByRole("checkbox", { name: "Lower the music while anybody talks" }) as HTMLInputElement;
	expect(box.checked).toBe(true);
	fireEvent.click(box);

	expect(rememberedDucking()).toBe(false);
	expect(box.checked).toBe(false);
});

it("turns down the music in the holder's own speakers, and nobody's setting for anybody", async () => {
	const { room } = fakeRoom();
	show(room);
	await addFromSearch();
	await waitFor(() => expect(playDecoded).toHaveBeenCalledTimes(1));
	fireEvent.click(screen.getByRole("tab", { name: "Song desk" }));

	fireEvent.change(screen.getByRole("slider", { name: "Music volume in your speakers" }), { target: { value: "0.3" } });

	expect(setMonitorVolume).toHaveBeenCalledWith(room, 0.3);
	expect(settingFor("gme-1", "screen").volume).toBe(1);
});
