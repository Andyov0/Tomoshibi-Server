import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { ASK_TOPIC, FRAMES, MUSIC, TOPIC, toInt24, unpack } from "./lossless";
import { LosslessSender } from "./lossless-sender";

/*
 * Sending a lossless share.
 *
 * The capture is fed in as the browser feeds it -- ten-millisecond chunks that
 * do not line up with the packet size -- and what is checked is what leaves:
 * that it goes only to people who asked, that it decodes to exactly the samples
 * fed in, that a hole in the capture is counted rather than smoothed over, and
 * that an upload that cannot keep up ends the stream instead of queueing
 * forever.
 */

type Handler = (...args: unknown[]) => void;

/** Chunks of capture, as a MediaStreamTrackProcessor hands them over. */
function chunk(start: number, frames: number, timestamp: number, rate = 48_000) {
	const planes = [0, 1].map((c) => Float32Array.from({ length: frames }, (_, i) => (((start + i) % 5000) - 2500) / (c ? 4096 : 8192)));
	return {
		sampleRate: rate,
		numberOfChannels: 2,
		numberOfFrames: frames,
		timestamp,
		copyTo(dest: Float32Array, options: { planeIndex: number }) {
			dest.set(planes[options.planeIndex] as Float32Array);
		},
		close: vi.fn(),
		planes,
	};
}

let feed: (value: ReturnType<typeof chunk>) => void;

class Processor {
	readable = new ReadableStream({
		start(controller) {
			// Once the sender has cancelled its reader, capture has nowhere to go.
			feed = (value) => {
				try {
					controller.enqueue(value);
				} catch {}
			};
		},
	});
}

function fakeRoom(slow = false) {
	const handlers = new Map<string, Set<Handler>>();
	const sent: { bytes: Uint8Array; to: string[] }[] = [];
	const sentOn: string[] = [];
	const publishData = vi.fn(
		(bytes: Uint8Array, options: { topic: string; destinationIdentities: string[] }) =>
			new Promise<void>((resolve) => {
				sentOn.push(options.topic);
				if (options.topic === TOPIC || options.topic === MUSIC.topic) sent.push({ bytes, to: options.destinationIdentities });
				if (!slow) resolve();
			}),
	);
	const remoteParticipants = new Map<string, { identity: string }>();

	const room = {
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

	const join = (identity: string) => remoteParticipants.set(identity, { identity });
	const ask = (identity: string, yes = true, topic = ASK_TOPIC) => {
		for (const handler of handlers.get("dataReceived") ?? []) {
			handler(new TextEncoder().encode(yes ? "1" : "0"), remoteParticipants.get(identity), 0, topic);
		}
	};

	return { room: room as unknown as Room, sent, sentOn, join, ask };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Feed `chunks` ten-millisecond chunks, contiguous, starting at frame 0. */
async function capture(chunks: number, from = 0, skipAt?: number) {
	let timestamp = from * 10_000;
	for (let n = from; n < from + chunks; n++) {
		if (n === skipAt) timestamp += 10_000;
		feed(chunk(n * 480, 480, timestamp));
		timestamp += 10_000;
		await settle();
	}
}

beforeEach(() => {
	vi.stubGlobal("MediaStreamTrackProcessor", Processor);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

it("sends nothing until somebody asks, then only to them", async () => {
	const { room, sent, join, ask } = fakeRoom();
	join("gfriend-1");
	join("gother-2");
	const sender = new LosslessSender(room, {} as MediaStreamTrack);

	await capture(4);
	expect(sent).toHaveLength(0);

	ask("gfriend-1");
	await capture(4, 4);

	expect(sent).toHaveLength(2);
	for (const packet of sent) expect(packet.to).toEqual(["gfriend-1"]);
	sender.stop();
});

it("sends exactly the samples it was given, in consecutive packets", async () => {
	const { room, sent, join, ask } = fakeRoom();
	join("gfriend-1");
	const sender = new LosslessSender(room, {} as MediaStreamTrack);
	ask("gfriend-1");

	await capture(10);

	expect(sent).toHaveLength(5);
	const blocks = sent.map((packet) => unpack(packet.bytes));
	blocks.forEach((block, b) => {
		expect(block.seq).toBe(b);
		expect(block.rate).toBe(48_000);
		const expected = [0, 1].map((c) =>
			Array.from({ length: FRAMES }, (_, i) => toInt24(Math.fround((((b * FRAMES + i) % 5000) - 2500) / (c ? 4096 : 8192)))),
		);
		block.channels.forEach((channel, c) => expect(Array.from(channel)).toEqual(expected[c]));
	});
	expect(sender.gaps).toBe(0);
	sender.stop();
});

it("stops sending to somebody who withdraws or leaves", async () => {
	const { room, sent, join, ask } = fakeRoom();
	join("gfriend-1");
	const sender = new LosslessSender(room, {} as MediaStreamTrack);
	ask("gfriend-1");
	await capture(2);
	expect(sent).toHaveLength(1);

	ask("gfriend-1", false);
	await capture(4, 2);
	expect(sent).toHaveLength(1);
	sender.stop();
});

it("counts a hole in the capture rather than passing over it", async () => {
	const { room, join, ask } = fakeRoom();
	join("gfriend-1");
	const sender = new LosslessSender(room, {} as MediaStreamTrack);
	ask("gfriend-1");

	await capture(6, 0, 3);

	expect(sender.gaps).toBe(1);
	sender.stop();
});

it("gives up, once, when the upload cannot keep up", async () => {
	const { room, join, ask } = fakeRoom(true);
	join("gfriend-1");
	const gaveUp = vi.fn();
	const sender = new LosslessSender(room, {} as MediaStreamTrack, gaveUp);
	ask("gfriend-1");

	// Four seconds of capture into a connection that never finishes a send.
	await capture(400);

	expect(gaveUp).toHaveBeenCalledTimes(1);
	sender.stop();
});

it("stops sending to somebody no longer in the room, and to an ask not repeated", async () => {
	const { room, sent, join, ask } = fakeRoom();
	join("gfriend-1");
	join("gother-2");
	const sender = new LosslessSender(room, {} as MediaStreamTrack);
	ask("gfriend-1");
	ask("gother-2");

	// Gone without a word: no disconnect event, just no longer listed.
	(room.remoteParticipants as Map<string, unknown>).delete("gother-2");
	await capture(2);
	expect(sent.at(-1)?.to).toEqual(["gfriend-1"]);

	// Fifteen seconds and more since the last ask.
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now + 16_000);
	await capture(2, 2);
	expect(sent).toHaveLength(1);

	clock.mockRestore();
	sender.stop();
});

it("turns floats into samples the way it was told to", async () => {
	const { room, sent, join, ask } = fakeRoom();
	join("gfriend-1");
	const sender = new LosslessSender(room, {} as MediaStreamTrack, () => {}, () => 4242);
	ask("gfriend-1");

	await capture(2);

	const [block] = sent.map((packet) => unpack(packet.bytes));
	expect(Array.from(block?.channels[0] ?? []).every((sample) => sample === 4242)).toBe(true);
	sender.stop();
});

it("as the song desk's music, answers only asks for the music, and only on the music's topic", async () => {
	const { room, sent, sentOn, join, ask } = fakeRoom();
	join("gfriend-1");
	const sender = new LosslessSender(room, {} as MediaStreamTrack, () => {}, toInt24, MUSIC);

	ask("gfriend-1");
	await capture(2);
	expect(sent).toHaveLength(0);

	ask("gfriend-1", true, MUSIC.ask);
	await capture(2, 2);
	expect(sent).toHaveLength(1);
	expect(new Set(sentOn)).toEqual(new Set([MUSIC.topic]));
	sender.stop();
});

