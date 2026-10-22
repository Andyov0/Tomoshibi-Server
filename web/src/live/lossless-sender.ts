import { type RemoteParticipant, type Room, RoomEvent } from "livekit-client";
import { ASK_EVERY, type Channel, FRAMES, SHARED, pack, toInt24 } from "./lossless";

/**
 * Sending shared sound without loss, alongside the Opus track that carries it
 * for everybody else.
 *
 * The samples are read off the captured track as the browser delivered them,
 * before any encoder has seen them, in blocks of FRAMES; each block is coded by
 * lossless.ts and sent over the reliable data channel to the people who asked
 * for it, and to nobody else. Asking is what keeps this from costing anything
 * where it is not used: a browser on an older version of the page, or one whose
 * owner has turned this person down, never asks, and the media server is never
 * handed a packet for it. An ask lasts ASK_LASTS and is repeated every
 * ASK_EVERY, so a listener who vanishes without a word stops being sent to
 * shortly after.
 *
 * The samples come from a MediaStreamTrackProcessor, which hands over each
 * chunk of capture exactly as the browser has it. It holds up to a second of
 * capture while the page is busy, so a stall on this thread is a delay rather
 * than a hole; a hole would still be noticed, by the timestamps, and counted.
 */

/** How long an ask lasts unrepeated. */
const ASK_LASTS = 3 * ASK_EVERY;

/**
 * How much sound may wait to be sent before this gives up.
 *
 * Reliable delivery is a promise to arrive late rather than not at all, and an
 * upload too slow for the stream turns that into a queue that only grows. Past
 * a few seconds, the people listening are better served by the Opus track they
 * fall back to than by a stream that will never catch up.
 */
const BACKLOG_SECONDS = 3;

interface Processor {
	readable: ReadableStream<AudioData>;
}

type ProcessorConstructor = new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => Processor;

function processorConstructor(): ProcessorConstructor | undefined {
	return (globalThis as { MediaStreamTrackProcessor?: ProcessorConstructor }).MediaStreamTrackProcessor;
}

/** Whether this browser can read raw samples off a track, which sending needs. */
export function canSendLossless(): boolean {
	return typeof processorConstructor() === "function";
}

export class LosslessSender {
	private readonly wanting = new Map<string, number>();
	private readonly queue: { bytes: Uint8Array; to: string[] }[] = [];
	private stopped = false;
	private sending = false;
	private reader?: ReadableStreamDefaultReader<AudioData>;

	private stream = randomStream();
	private seq = 0;

	/** Chunks of capture that were missing between two that arrived. */
	gaps = 0;

	constructor(
		private readonly room: Room,
		private readonly track: MediaStreamTrack,
		/** Called once, if the stream is given up on. */
		private readonly onGiveUp: () => void = () => {},
		/**
		 * How a float the browser hands over becomes the 24-bit sample sent: see
		 * decodedToInt24 for a file the browser decoded, whose own integers can be
		 * recovered exactly.
		 */
		private readonly toInt: (sample: number) => number = toInt24,
		/** Which of the two kinds of shared sound this is; their streams never mix. */
		private readonly channel: Channel = SHARED,
	) {
		room.on(RoomEvent.DataReceived, this.onAsk);
		room.on(RoomEvent.ParticipantDisconnected, this.onLeft);
		void this.read();
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.room.off(RoomEvent.DataReceived, this.onAsk);
		this.room.off(RoomEvent.ParticipantDisconnected, this.onLeft);
		this.queue.length = 0;
		void this.reader?.cancel().catch(() => {});
	}

	private readonly onAsk = (
		payload: Uint8Array,
		participant?: RemoteParticipant,
		_kind?: unknown,
		topic?: string,
	): void => {
		if (topic !== this.channel.ask || !participant) return;

		if (new TextDecoder().decode(payload) === "1") this.wanting.set(participant.identity, Date.now());
		else this.wanting.delete(participant.identity);
	};

	private readonly onLeft = (participant: RemoteParticipant): void => {
		this.wanting.delete(participant.identity);
	};

	/** Who to send the next block to: whoever has asked lately and is still here. */
	private recipients(): string[] {
		const now = Date.now();
		const out: string[] = [];

		for (const [identity, at] of this.wanting) {
			if (now - at > ASK_LASTS || !this.room.remoteParticipants.has(identity)) this.wanting.delete(identity);
			else out.push(identity);
		}

		return out;
	}

	private async read(): Promise<void> {
		const Processor = processorConstructor();
		if (!Processor) return;

		// A second of capture at the usual ten milliseconds a chunk.
		this.reader = new Processor({ track: this.track, maxBufferSize: 100 }).readable.getReader();

		let rate = 0;
		let channels = 0;
		let block: Int32Array[] = [];
		let filled = 0;
		let expected: number | undefined;

		while (!this.stopped) {
			let result: ReadableStreamReadResult<AudioData>;
			try {
				result = await this.reader.read();
			} catch {
				return;
			}
			if (result.done) return;

			const data = result.value;
			try {
				// A change of format is a new stream: the far end starts again
				// rather than playing samples at the wrong rate.
				const count = Math.min(2, data.numberOfChannels);
				if (data.sampleRate !== rate || count !== channels) {
					rate = data.sampleRate;
					channels = count;
					block = Array.from({ length: channels }, () => new Int32Array(FRAMES));
					filled = 0;
					expected = undefined;
					this.stream = randomStream();
					this.seq = 0;
				}

				// In microseconds, which is what the timestamps are. Anything
				// more than a millisecond off where the last chunk ended is
				// capture the browser did not hand over.
				if (expected !== undefined && Math.abs(data.timestamp - expected) > 1000) this.gaps++;
				expected = data.timestamp + (data.numberOfFrames / rate) * 1_000_000;

				const frames = data.numberOfFrames;

				let offset = 0;
				const copies = Array.from({ length: channels }, (_, c) => {
					const copy = new Float32Array(frames);
					data.copyTo(copy, { planeIndex: c, format: "f32-planar" });
					return copy;
				});

				while (offset < frames) {
					const take = Math.min(FRAMES - filled, frames - offset);
					for (let c = 0; c < channels; c++) {
						const from = copies[c] as Float32Array;
						const to = block[c] as Int32Array;
						for (let i = 0; i < take; i++) to[filled + i] = this.toInt(from[offset + i] as number);
					}
					filled += take;
					offset += take;

					if (filled === FRAMES) {
						this.emit(rate, block);
						block = Array.from({ length: channels }, () => new Int32Array(FRAMES));
						filled = 0;
					}
				}
			} finally {
				data.close();
			}
		}
	}

	private emit(rate: number, channels: Int32Array[]): void {
		const seq = this.seq++;
		const to = this.recipients();
		if (to.length === 0) return;

		this.queue.push({ bytes: pack({ rate, stream: this.stream, seq, channels }), to });

		if (this.queue.length > (BACKLOG_SECONDS * rate) / FRAMES) {
			this.stop();
			this.onGiveUp();
			return;
		}

		void this.pump();
	}

	private async pump(): Promise<void> {
		if (this.sending) return;
		this.sending = true;

		try {
			while (!this.stopped && this.queue.length > 0) {
				const next = this.queue.shift() as { bytes: Uint8Array; to: string[] };
				try {
					await this.room.localParticipant.publishData(next.bytes as Uint8Array<ArrayBuffer>, {
						reliable: true,
						topic: this.channel.topic,
						destinationIdentities: next.to,
					});
				} catch {
					// Not connected at this moment; the listeners notice the
					// gap and fall back, which is the right outcome for a
					// stream that could not be sent.
				}
			}
		} finally {
			this.sending = false;
		}
	}
}

function randomStream(): number {
	return crypto.getRandomValues(new Uint32Array(1))[0] as number;
}
