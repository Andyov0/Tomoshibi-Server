import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { setBlocked } from "./hearing";
import { ASK_TOPIC, FRAMES, LOSSLESS, MUSIC, TOPIC, fromInt24, pack } from "./lossless";
import { MAX_UNDERRUNS, type Player, SLOW_WINDOW_MS, STALL_MS, holdsBack, receiveLossless } from "./lossless-receiver";
import { LISTENING } from "./sound";

/*
 * Hearing a lossless share.
 *
 * Two promises are tested here, and each fails quietly if broken. The first is
 * that what reaches the player is exactly what was sent, in order. The second is
 * that whenever the lossless stream is not playing -- it never started, it
 * stopped, a packet went missing, the player could not start -- the Opus track
 * comes back. Holding Opus back is what keeps one song from playing twice; if
 * it is held back with nothing playing in its place, the listener hears
 * silence and nothing on the screen says why.
 */

vi.mock("livekit-client", async (original) => {
	const real = await original<typeof import("livekit-client")>();
	return real;
});

type Handler = (...args: unknown[]) => void;

function fakeRoom(options: Record<string, unknown> = {}) {
	const handlers = new Map<string, Set<Handler>>();
	const publishData = vi.fn(async () => {});
	const remoteParticipants = new Map<string, { identity: string; trackPublications: Map<string, unknown> }>();

	const room = {
		options,
		remoteParticipants,
		localParticipant: { publishData },
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

	const share = (identity: string, name = LOSSLESS, sid = "TR_one") => {
		remoteParticipants.set(identity, {
			identity,
			trackPublications: new Map([[sid, { source: "screen_share_audio", trackName: name, trackSid: sid }]]),
		});
		emit("trackPublished");
	};

	const asks = () =>
		publishData.mock.calls
			.filter((call) => (call as unknown[])[1] && ((call as unknown[])[1] as { topic: string }).topic === ASK_TOPIC)
			.map((call) => ({
				to: ((call as unknown[])[1] as { destinationIdentities: string[] }).destinationIdentities[0],
				yes: new TextDecoder().decode((call as unknown[])[0] as Uint8Array) === "1",
			}));

	const send = (identity: string, seq: number, stream = 1, channels = samples(seq)) => {
		emit("dataReceived", pack({ rate: 48_000, stream, seq, channels }), remoteParticipants.get(identity), 0, TOPIC);
	};

	return { room: room as unknown as Room, emit, share, asks, send };
}

/** A block whose samples say which block they belong to. */
function samples(seq: number): Int32Array[] {
	return [0, 1].map((c) => Int32Array.from({ length: FRAMES }, (_, i) => (seq * FRAMES + i) * (c ? -1 : 1)));
}

function fakePlayers() {
	const made: (Player & { blocks: Float32Array[][]; closed: boolean; level: number; isBroken: boolean; isHeld: boolean; underruns: number })[] = [];
	const make = () => {
		const player = {
			blocks: [] as Float32Array[][],
			closed: false,
			level: 1,
			isBroken: false,
			isHeld: false,
			underruns: 0,
			push(block: Float32Array[]) {
				player.blocks.push(block);
			},
			volume(level: number) {
				player.level = level;
			},
			close() {
				player.closed = true;
			},
			counts: () => ({ underruns: player.underruns, skipped: 0, held: 0, played: 0, playing: true }),
			broken: () => player.isBroken,
			held: () => player.isHeld,
		};
		made.push(player);
		return player;
	};

	return { made, make };
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("AudioWorkletNode", function AudioWorkletNode() {});
	vi.stubGlobal("AudioContext", function AudioContext() {});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("a lossless share", () => {
	it("is asked for, and its Opus track held back", () => {
		const { room, share, asks } = fakeRoom();
		const changed = vi.fn();
		const stop = receiveLossless(room, changed, fakePlayers().make);

		share("gfriend-1");

		expect(asks()).toEqual([{ to: "gfriend-1", yes: true }]);
		expect(holdsBack(room, "gfriend-1")).toBe(true);
		expect(changed).toHaveBeenCalled();
		stop();
	});

	it("reaches the player sample for sample, in order", () => {
		const { room, share, send } = fakeRoom();
		const players = fakePlayers();
		const stop = receiveLossless(room, () => {}, players.make);
		share("gfriend-1");

		for (let seq = 40; seq < 45; seq++) send("gfriend-1", seq);

		const player = players.made[0];
		expect(players.made).toHaveLength(1);
		expect(player?.blocks).toHaveLength(5);
		player?.blocks.forEach((block, b) => {
			const expected = samples(40 + b);
			block.forEach((channel, c) => expect(Array.from(channel)).toEqual(Array.from(expected[c] as Int32Array, fromInt24)));
		});
		stop();
	});

	it("is asked for again while it lasts, so the sender keeps sending", () => {
		const { room, share, asks, send } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		let seq = 0;
		for (let second = 0; second < 11; second++) {
			for (let i = 0; i < 50; i++) send("gfriend-1", seq++);
			vi.advanceTimersByTime(1000);
		}

		expect(asks().filter((ask) => ask.yes).length).toBeGreaterThanOrEqual(3);
		stop();
	});
});

describe("giving up, and giving Opus back", () => {
	it("on a packet missing from the sequence", () => {
		const { room, share, send, asks } = fakeRoom();
		const players = fakePlayers();
		const changed = vi.fn();
		const stop = receiveLossless(room, changed, players.make);
		share("gfriend-1");

		send("gfriend-1", 1);
		send("gfriend-1", 3);

		expect(holdsBack(room, "gfriend-1")).toBe(false);
		expect(players.made[0]?.closed).toBe(true);
		expect(asks().at(-1)).toEqual({ to: "gfriend-1", yes: false });
		stop();
	});

	it("when nothing arrives after asking", () => {
		const { room, share } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		vi.advanceTimersByTime(STALL_MS - 1000);
		expect(holdsBack(room, "gfriend-1")).toBe(true);

		vi.advanceTimersByTime(2000);
		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("when the stream stops", () => {
		const { room, share, send } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		send("gfriend-1", 0);
		vi.advanceTimersByTime(STALL_MS + 1500);

		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("when packets arrive but the player could not start", () => {
		const { room, share, send } = fakeRoom();
		const players = fakePlayers();
		const stop = receiveLossless(room, () => {}, players.make);
		share("gfriend-1");

		send("gfriend-1", 0);
		(players.made[0] as { isBroken: boolean }).isBroken = true;
		send("gfriend-1", 1);
		vi.advanceTimersByTime(1000);

		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	/*
	 * A call the page came back to by itself, in a browser that asks for a
	 * press per thing that plays: the elements were carried over from an
	 * earlier press and play, and this player's context, made since, was not.
	 * Held back, the share would be silent while everything else was heard.
	 */
	it("when the browser will not start the player, though it plays the rest of the call", () => {
		const { room, share, send } = fakeRoom();
		(room as unknown as { canPlaybackAudio: boolean }).canPlaybackAudio = true;
		const players = fakePlayers();
		const stop = receiveLossless(room, () => {}, players.make);
		share("gfriend-1");

		send("gfriend-1", 0);
		(players.made[0] as { isHeld: boolean }).isHeld = true;
		send("gfriend-1", 1);
		vi.advanceTimersByTime(1000);

		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	// Where nothing in the call is allowed to play yet, the press that starts
	// any of it starts this as well, and the share is still lossless after it.
	it("but not while the rest of the call is held back as well", () => {
		const { room, share, send } = fakeRoom();
		(room as unknown as { canPlaybackAudio: boolean }).canPlaybackAudio = false;
		const players = fakePlayers();
		const stop = receiveLossless(room, () => {}, players.make);
		share("gfriend-1");

		send("gfriend-1", 0);
		(players.made[0] as { isHeld: boolean }).isHeld = true;
		send("gfriend-1", 1);
		vi.advanceTimersByTime(1000);

		expect(holdsBack(room, "gfriend-1")).toBe(true);
		stop();
	});

	it("when playout keeps running dry, though packets still come", () => {
		const { room, share, send } = fakeRoom();
		const players = fakePlayers();
		const stop = receiveLossless(room, () => {}, players.make);
		share("gfriend-1");
		send("gfriend-1", 0);
		const player = players.made[0] as { underruns: number };

		player.underruns = MAX_UNDERRUNS - 1;
		send("gfriend-1", 1);
		vi.advanceTimersByTime(1000);
		expect(holdsBack(room, "gfriend-1")).toBe(true);

		player.underruns = MAX_UNDERRUNS;
		send("gfriend-1", 2);
		vi.advanceTimersByTime(1000);
		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("when it arrives at a fraction of real time, without waiting for it to run dry", () => {
		const { room, share, send } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		// A packet is 20 ms; one every 200 ms is a tenth of real time.
		let seq = 0;
		for (let t = 0; t < SLOW_WINDOW_MS + 1000; t += 200) {
			send("gfriend-1", seq++);
			vi.advanceTimersByTime(200);
		}

		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("but not when it arrives at real time in bursts", () => {
		const { room, share, send } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		// A second's worth at once, every second: lumpy, and all of it.
		let seq = 0;
		for (let second = 0; second < 12; second++) {
			for (let i = 0; i < 50; i++) send("gfriend-1", seq++);
			vi.advanceTimersByTime(1000);
		}

		expect(holdsBack(room, "gfriend-1")).toBe(true);
		stop();
	});

	it("and starts afresh when the person shares again", () => {
		const { room, share, send } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");
		send("gfriend-1", 1);
		send("gfriend-1", 3);
		expect(holdsBack(room, "gfriend-1")).toBe(false);

		share("gfriend-1", LOSSLESS, "TR_two");

		expect(holdsBack(room, "gfriend-1")).toBe(true);
		stop();
	});
});

describe("not asking", () => {
	it("in an encrypted call", () => {
		const { room, share, asks } = fakeRoom({ e2ee: {} });
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		expect(asks()).toEqual([]);
		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("for a share that is not offered losslessly", () => {
		const { room, share, asks } = fakeRoom();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1", LISTENING);

		expect(asks()).toEqual([]);
		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
	});

	it("for somebody whose sound this person has turned off", () => {
		const { room, share, asks } = fakeRoom();
		setBlocked("gfriend-1", "screen", true);
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		share("gfriend-1");

		expect(asks()).toEqual([]);
		expect(holdsBack(room, "gfriend-1")).toBe(false);
		stop();
		setBlocked("gfriend-1", "screen", false);
	});
});

it("asks again every second until the first packet, in case the first ask arrived too early", () => {
	const { room, share, asks, send } = fakeRoom();
	const stop = receiveLossless(room, () => {}, fakePlayers().make);
	share("gfriend-1");

	vi.advanceTimersByTime(3000);
	expect(asks().filter((ask) => ask.yes).length).toBeGreaterThanOrEqual(3);

	send("gfriend-1", 0);
	const before = asks().length;
	vi.advanceTimersByTime(3000);
	send("gfriend-1", 1);
	expect(asks().length).toBe(before);
	stop();
});

describe("music beside a shared sound, from the same person", () => {
	function both() {
		const made = fakeRoom();
		const room = made.room as unknown as { remoteParticipants: Map<string, unknown> };
		room.remoteParticipants.set("gfriend-1", {
			identity: "gfriend-1",
			trackPublications: new Map([
				["TR_app", { source: "screen_share_audio", trackName: LOSSLESS, trackSid: "TR_app" }],
				["TR_music", { source: "unknown", trackName: MUSIC.lossless, trackSid: "TR_music" }],
			]),
		});
		return made;
	}

	it("is asked for on its own topic and played by its own player, sample for sample", () => {
		const { room, emit } = both();
		const players = fakePlayers();
		const publishData = (room as unknown as { localParticipant: { publishData: ReturnType<typeof vi.fn> } }).localParticipant
			.publishData;
		const stop = receiveLossless(room, () => {}, players.make);
		emit("trackPublished");

		const topics = publishData.mock.calls.map((call) => (call[1] as { topic: string }).topic);
		expect(topics).toContain(ASK_TOPIC);
		expect(topics).toContain(MUSIC.ask);

		const friend = (room as unknown as { remoteParticipants: Map<string, unknown> }).remoteParticipants.get("gfriend-1");
		emit("dataReceived", pack({ rate: 44_100, stream: 7, seq: 0, channels: samples(0) }), friend, 0, MUSIC.topic);
		emit("dataReceived", pack({ rate: 48_000, stream: 8, seq: 0, channels: samples(1) }), friend, 0, TOPIC);

		expect(players.made).toHaveLength(2);
		expect(Array.from(players.made[0]?.blocks[0]?.[0] ?? [])).toEqual(Array.from(samples(0)[0] as Int32Array, fromInt24));
		expect(Array.from(players.made[1]?.blocks[0]?.[0] ?? [])).toEqual(Array.from(samples(1)[0] as Int32Array, fromInt24));
		expect(holdsBack(room, "gfriend-1", "music")).toBe(true);
		expect(holdsBack(room, "gfriend-1", "screen")).toBe(true);
		stop();
	});

	it("is let go of on its own when the music is turned off, and the shared sound is not", () => {
		const { room, emit } = both();
		const stop = receiveLossless(room, () => {}, fakePlayers().make);
		emit("trackPublished");

		setBlocked("gfriend-1", "music", true);

		expect(holdsBack(room, "gfriend-1", "music")).toBe(false);
		expect(holdsBack(room, "gfriend-1", "screen")).toBe(true);
		setBlocked("gfriend-1", "music", false);
		stop();
	});
});

