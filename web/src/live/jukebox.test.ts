import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { Desk, type DeskDeps, TOPIC, closeDesk, deskState, hearDesks, startDesk } from "./jukebox";
import type { LibraryTrack } from "./music";
import type { Decoded } from "./sound";

/*
The song desk.

What would go wrong quietly: a song taken off the queue and never played, two
played at once, a skip that two impatient people turn into skipping two songs,
a request that lands under the wrong name, anything said to the room in an
encrypted call, and a desk everybody still believes in after its holder left.
*/

type Handler = (...args: unknown[]) => void;

function fakeRoom(identity = "gholder-1", others: string[] = ["gfriend-2", "gother-3"]) {
	const handlers = new Map<string, Set<Handler>>();
	const sent: { message: Record<string, unknown>; to?: string[] }[] = [];
	const remoteParticipants = new Map(others.map((id) => [id, { identity: id, name: id.toUpperCase() }]));

	const room = {
		remoteParticipants,
		localParticipant: {
			identity,
			name: "Holder",
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

	const emit = (event: string, ...args: unknown[]) => {
		for (const handler of handlers.get(event) ?? []) handler(...args);
	};

	const send = (identity: string, message: unknown) =>
		emit("dataReceived", new TextEncoder().encode(JSON.stringify(message)), remoteParticipants.get(identity), 0, TOPIC);

	return { room: room as unknown as Room, sent, emit, send, remoteParticipants };
}

const track = (id: string, title = `Song ${id}`): LibraryTrack => ({
	id,
	title,
	artists: ["Someone"],
	album: "",
	cover: "",
	duration: 200,
});

const song = (id: string) => ({ source: "lib", id, title: `Song ${id}`, artists: ["Someone"], album: "", cover: "", duration: 200 });

/** Dependencies that play nothing, and remember what they were asked. */
function fakeDeps(unavailable: string[] = []) {
	const played: string[] = [];
	const ends: (() => void)[] = [];
	const fetched: string[] = [];
	const aborted: string[] = [];
	let stopped = 0;
	/** Songs held on their way until released, as a slow library holds them. */
	const held = new Map<string, () => void>();
	const slowed = new Set<string>();
	/** A play held at publishing until the music is stopped, which then refuses it as stopped. */
	let publishing: { title: string; refuse: () => void } | undefined;
	const slowPublish = new Set<string>();

	const deps: DeskDeps = {
		libraries: () => [
			{ id: "off", name: "Off", signedIn: false },
			{ id: "lib", name: "Lib", signedIn: true },
		],
		search: vi.fn(async (_source: string, query: string) => [track(`found-${query}`), track("second")]),
		readLink: vi.fn(async () => ({ source: "lib", tracks: [track("l1"), track("l2"), track("l3")] })),
		describe: vi.fn(async (_source: string, id: string) =>
			unavailable.includes(id) ? ("unavailable" as const) : { format: "flac", rate: 44_100, channels: 2, bits: 16, tier: "lossless" },
		),
		audioUrl: (source, id) => `/a?${source}/${id}`,
		fetchTrack: vi.fn(async (audio, signal: AbortSignal) => {
			fetched.push(audio.url);
			const id = audio.url.split("/").at(-1) ?? "";
			if (slowed.has(id)) {
				await new Promise<void>((resolve, reject) => {
					held.set(id, resolve);
					signal.addEventListener("abort", () => {
						aborted.push(id);
						reject(new DOMException("aborted", "AbortError"));
					});
				});
			}
			return { buffer: {} as AudioBuffer, rate: 44_100, bits: 16, now: audio.now } as Decoded;
		}),
		play: vi.fn(async (decoded: Decoded, onEnded: () => void) => {
			const title = decoded.now?.title ?? "";
			if (slowPublish.has(title)) {
				await new Promise<void>((_, reject) => {
					publishing = { title, refuse: () => reject(new DOMException("stopped", "AbortError")) };
				});
			}
			played.push(title);
			ends.push(onEnded);
		}),
		stop: vi.fn(async () => {
			stopped++;
			publishing?.refuse();
			publishing = undefined;
		}),
		pause: vi.fn(),
		describeAudio: () => "FLAC",
		quality: () => "lossless",
		onSkipped: vi.fn(),
		onProgress: () => {},
	};

	return {
		deps,
		played,
		ends,
		fetched,
		aborted,
		stopped: () => stopped,
		slow: (id: string) => slowed.add(id),
		slowToPublish: (title: string) => slowPublish.add(title),
		release: (id: string) => {
			slowed.delete(id);
			held.get(id)?.();
		},
	};
}

const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("the queue", () => {
	it("plays the first song added, and the next when it ends, and stops when there is none", async () => {
		const { room } = fakeRoom();
		const { deps, played, ends, stopped } = fakeDeps();
		const desk = new Desk(room, deps, true);

		desk.add([song("a"), song("b")], "Holder");
		await settle();
		expect(played).toEqual(["Song a"]);
		expect(desk.state().queue.map((one) => one.id)).toEqual(["b"]);

		ends.at(-1)?.();
		await settle();
		expect(played).toEqual(["Song a", "Song b"]);

		ends.at(-1)?.();
		await settle();
		expect(desk.state().now).toBeUndefined();
		expect(stopped()).toBe(1);
	});

	it("fetches the next song while this one plays", async () => {
		const { room } = fakeRoom();
		const { deps, fetched } = fakeDeps();
		const desk = new Desk(room, deps, true);

		desk.add([song("a"), song("b")], "Holder");
		await settle();

		expect(fetched).toEqual(["/a?lib/a", "/a?lib/b"]);
	});

	it("skips a song the account may not play, says so, and plays the one after", async () => {
		const { room } = fakeRoom();
		const { deps, played } = fakeDeps(["bad"]);
		const desk = new Desk(room, deps, true);

		desk.add([song("bad"), song("good")], "Holder");
		await settle();

		expect(deps.onSkipped).toHaveBeenCalledWith(expect.objectContaining({ id: "bad" }));
		expect(played).toEqual(["Song good"]);
	});

	it("moves a song to the top, and takes one out", async () => {
		const { room } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);
		desk.add([song("a"), song("b"), song("c"), song("d")], "Holder");
		await settle();

		const [b, c] = desk.state().queue;
		desk.toTop(c?.key ?? "");
		desk.remove(b?.key ?? "");

		expect(desk.state().queue.map((one) => one.id)).toEqual(["c", "d"]);
	});
});

describe("pausing", () => {
	it("pauses what is playing for everybody, and the next song plays unpaused", async () => {
		const { room, sent } = fakeRoom();
		const { deps, ends } = fakeDeps();
		const desk = new Desk(room, deps, true);
		desk.add([song("a"), song("b")], "Holder");
		await settle();

		desk.pause(true);
		expect(deps.pause).toHaveBeenLastCalledWith(true);
		expect((sent.at(-1)?.message as { state: { paused: boolean } }).state.paused).toBe(true);

		ends.at(-1)?.();
		await settle();
		expect(desk.state().now?.id).toBe("b");
		expect(desk.state().paused).toBe(false);
	});

	it("has nothing to pause when nothing is playing", () => {
		const { room } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);

		desk.pause(true);

		expect(deps.pause).not.toHaveBeenCalled();
		expect(desk.state().paused).toBe(false);
	});
});

describe("asking the desk", () => {
	it("plays the top result for a keyword, from the library that is signed in, under the asker's name", async () => {
		const { room, send } = fakeRoom();
		const { deps, played } = fakeDeps();
		const desk = new Desk(room, deps, true);

		send("gfriend-2", { t: "request", query: "sunny day" });
		await settle();

		expect(deps.search).toHaveBeenCalledWith("lib", "sunny day");
		expect(played).toEqual(["found-sunny day"].map((id) => `${track(id).title}`));
		expect(desk.state().now?.by).toBe("GFRIEND-2");
	});

	it("queues every song a pasted link names", async () => {
		const { room, send } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);

		send("gfriend-2", { t: "link", text: "a playlist https://example.invalid/list?id=1" });
		await settle();

		expect(desk.state().now?.id).toBe("l1");
		expect(desk.state().queue.map((one) => one.id)).toEqual(["l2", "l3"]);
	});

	it("takes songs somebody added, and drops what is not a song", async () => {
		const { room, send } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);

		send("gother-3", { t: "add", songs: [song("x"), { nonsense: true }, { ...song(""), id: "" }] });
		await settle();

		expect(desk.state().now).toMatchObject({ id: "x", by: "GOTHER-3" });
		expect(desk.state().queue).toEqual([]);
	});
});

describe("skipping", () => {
	it("needs a majority of everybody else, and one vote each", async () => {
		const { room, send } = fakeRoom("gholder-1", ["g2", "g3", "g4"]);
		const { deps, played } = fakeDeps();
		const desk = new Desk(room, deps, true);
		desk.add([song("a"), song("b")], "Holder");
		await settle();

		send("g2", { t: "vote" });
		send("g2", { t: "vote" });
		await settle();
		expect(played).toEqual(["Song a"]);
		expect(desk.state().votes).toEqual(["g2"]);

		send("g3", { t: "vote" });
		await settle();
		expect(played).toEqual(["Song a", "Song b"]);
		expect(desk.state().votes).toEqual([]);
	});

	it("skips the song on its way when the holder presses again while it loads", async () => {
		const { room } = fakeRoom();
		const { deps, played, slow, aborted } = fakeDeps();
		const desk = new Desk(room, deps, true);
		slow("b");
		desk.add([song("a"), song("b"), song("c")], "Holder");
		await settle();

		desk.skip();
		await settle();
		desk.skip();
		await settle();

		expect(played).toEqual(["Song a", "Song c"]);
		expect(aborted).toContain("b");
		expect(desk.state().queue).toEqual([]);
	});

	it("takes out the song on its way to playing, which shows as loading and not in the queue", async () => {
		const { room } = fakeRoom();
		const { deps, played, ends, slow, aborted } = fakeDeps();
		const desk = new Desk(room, deps, true);
		slow("b");
		desk.add([song("a"), song("b"), song("c")], "Holder");
		await settle();

		ends.at(-1)?.();
		await settle();
		expect(desk.state().next?.id).toBe("b");
		expect(desk.state().queue.map((one) => one.id)).toEqual(["c"]);

		desk.remove(desk.state().next?.key ?? "");
		await settle();

		expect(aborted).toContain("b");
		expect(played).toEqual(["Song a", "Song c"]);
		expect(deps.onSkipped).not.toHaveBeenCalled();
	});

	it("lets a song that ends by itself while the next is loading leave the next alone", async () => {
		const { room } = fakeRoom();
		const { deps, played, ends, slow, release, aborted } = fakeDeps();
		const desk = new Desk(room, deps, true);
		slow("b");
		desk.add([song("a"), song("b"), song("c")], "Holder");
		await settle();

		desk.skip();
		await settle();
		ends[0]?.();
		await settle();
		release("b");
		await settle();

		expect(aborted).not.toContain("b");
		expect(played).toEqual(["Song a", "Song b"]);
	});

	it("abandons a song taken out while it is being published, and plays the next", async () => {
		const { room } = fakeRoom();
		const { deps, played, ends, slowToPublish } = fakeDeps();
		const desk = new Desk(room, deps, true);
		slowToPublish("Song b");
		desk.add([song("a"), song("b"), song("c")], "Holder");
		await settle();

		ends.at(-1)?.();
		await settle();
		const loading = desk.state().next;
		expect(loading?.id).toBe("b");
		desk.remove(loading?.key ?? "");
		await settle();

		expect(deps.stop).toHaveBeenCalled();
		expect(played).toEqual(["Song a", "Song c"]);
		expect(deps.onSkipped).not.toHaveBeenCalled();
	});

	it("does not count votes cast while the next song is loading, which were against the one already skipped", async () => {
		const { room, send } = fakeRoom("gholder-1", ["g2"]);
		const { deps, played, slow, release } = fakeDeps();
		const desk = new Desk(room, deps, true);
		slow("b");
		desk.add([song("a"), song("b"), song("c")], "Holder");
		await settle();

		send("g2", { t: "vote" });
		await settle();
		send("g2", { t: "vote" });
		await settle();
		release("b");
		await settle();

		expect(played).toEqual(["Song a", "Song b"]);
		expect(desk.state().queue.map((one) => one.id)).toEqual(["c"]);
	});
});

it("is the same object each time it is asked for, until something changes", async () => {
	const { room } = fakeRoom();
	const { deps } = fakeDeps();
	const desk = new Desk(room, deps, true);

	const first = desk.state();
	expect(desk.state()).toBe(first);

	desk.add([song("a")], "Holder");
	await settle();
	expect(desk.state()).not.toBe(first);
});

describe("telling the room", () => {
	it("says nothing at all in an encrypted call, and hears nothing", async () => {
		const { room, sent, send } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, false);

		desk.add([song("a")], "Holder");
		send("gfriend-2", { t: "add", songs: [song("x")] });
		await settle();

		expect(sent).toEqual([]);
		expect(desk.state().queue).toEqual([]);
	});

	it("says last of all that it closed, so nobody believes in it afterwards", async () => {
		const { room, sent } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);
		desk.add([song("a")], "Holder");
		await settle();

		await desk.close();
		await settle();

		expect(sent.at(-1)?.message).toEqual({ t: "closed" });
	});

	it("announces what is playing and what is queued", async () => {
		const { room, sent } = fakeRoom();
		const { deps } = fakeDeps();
		const desk = new Desk(room, deps, true);

		desk.add([song("a"), song("b")], "Holder");
		await settle();

		const last = sent.at(-1)?.message as { t: string; state: { now: { id: string }; queue: { id: string }[] } };
		expect(last.t).toBe("state");
		expect(last.state.now.id).toBe("a");
		expect(last.state.queue.map((one) => one.id)).toEqual(["b"]);
	});
});

describe("a desk heard from elsewhere", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("is believed while its holder announces it, and not once they leave or close it", () => {
		const { room, send, emit, remoteParticipants } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearDesks(room, true);

		send("gholder-2", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });
		expect(deskState(room)?.holder).toBe("gholder-2");

		send("gholder-2", { t: "closed" });
		expect(deskState(room)).toBeUndefined();

		send("gholder-2", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });
		remoteParticipants.delete("gholder-2");
		emit("participantDisconnected", { identity: "gholder-2" });
		expect(deskState(room)).toBeUndefined();
		stop();
	});

	it("is not believed once its holder is no longer in the call, though their leaving went unheard", () => {
		const { room, send, remoteParticipants } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearDesks(room, true);
		send("gholder-2", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });

		// A reconnect replaces the roster without saying who left.
		remoteParticipants.delete("gholder-2");

		expect(deskState(room)).toBeUndefined();
		stop();
	});

	it("is forgotten when its holder has said nothing for a long while", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearDesks(room, true);
		send("gholder-2", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });

		vi.advanceTimersByTime(40_000);
		expect(deskState(room)?.holder).toBe("gholder-2");
		vi.advanceTimersByTime(10_000);
		expect(deskState(room)).toBeUndefined();
		stop();
	});

	it("is not believed when somebody announces a desk held by somebody else", () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2", "gliar-3"]);
		const stop = hearDesks(room, true);

		send("gliar-3", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });

		expect(deskState(room)).toBeUndefined();
		stop();
	});

	it("keeps a second desk from being started beside it", async () => {
		const { room, send } = fakeRoom("gme-1", ["gholder-2"]);
		const stop = hearDesks(room, true);
		send("gholder-2", { t: "state", state: { holder: "gholder-2", holderName: "", queue: [], votes: [], needed: 1, loading: false } });

		expect(startDesk(room, fakeDeps().deps, true)).toBeUndefined();
		stop();
		await closeDesk(room);
	});
});
