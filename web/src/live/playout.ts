/**
 * Playing lossless sound out: the buffer between the network and the speakers.
 *
 * Packets arrive in bursts -- a retransmission holds up everything behind it,
 * and then it all arrives at once -- and the sound card asks for 128 frames at a
 * steady pace. Something has to absorb the difference, and the usual something,
 * the jitter buffer every browser runs on an audio track, absorbs it by
 * stretching and squeezing the sound and inventing what never arrived. That is
 * the thing this whole path exists to avoid. So this one only ever waits:
 *
 * - It does not start until it holds TARGET frames, and while it plays, every
 *   frame it puts out is the next frame that arrived, unaltered.
 * - If it runs dry it says so and goes quiet, and waits for TARGET again before
 *   resuming. A gap, never an invention. With a reliable channel the only way to
 *   run dry is for the sender's connection to stall for longer than TARGET.
 * - If it holds more than CEILING frames it drops whole packets from the front,
 *   back to TARGET. Two machines' clocks never agree exactly, and a sender a
 *   hair faster than this sound card would otherwise build a backlog for as
 *   long as the music played. At the usual tens of parts per million that is
 *   one skip in some hours; the alternative, resampling to track the drift,
 *   would alter every sample to avoid altering a few.
 *
 * Kept free of anything the audio thread lacks, because it runs there: the
 * worklet in playout.worklet.ts is a thin shell around it.
 */

export interface Counts {
	/** Times it ran dry while playing. */
	underruns: number;
	/** Frames dropped to stay within the ceiling. */
	skipped: number;
	/** Frames it holds now. */
	held: number;
	/** Frames played since it started. */
	played: number;
	playing: boolean;
}

export class Playout {
	private queue: Float32Array[][] = [];
	/** How far into the first block of the queue playback has got. */
	private offset = 0;
	private held = 0;
	private playing = false;
	private underruns = 0;
	private skipped = 0;
	private played = 0;

	constructor(
		private readonly channels: number,
		readonly target: number,
		readonly ceiling: number,
	) {}

	/** Add a block: one array per channel, all the same length. */
	push(block: Float32Array[]): void {
		const frames = block[0]?.length ?? 0;
		if (frames === 0) return;

		this.queue.push(block);
		this.held += frames;

		if (this.held > this.ceiling) {
			while (this.held > this.target && this.queue.length > 1) {
				const first = this.queue.shift() as Float32Array[];
				const dropped = (first[0]?.length ?? 0) - this.offset;
				this.offset = 0;
				this.held -= dropped;
				this.skipped += dropped;
			}
		}

		if (!this.playing && this.held >= this.target) this.playing = true;
	}

	/** Fill `out` -- one array per output channel -- with the next frames, or silence. */
	pull(out: Float32Array[]): void {
		const frames = out[0]?.length ?? 0;
		let written = 0;

		if (this.playing) {
			while (written < frames && this.queue.length > 0) {
				const first = this.queue[0] as Float32Array[];
				const length = first[0]?.length ?? 0;
				const take = Math.min(frames - written, length - this.offset);

				for (let c = 0; c < out.length; c++) {
					// A mono stream goes to both speakers; a stereo one to its own.
					const source = first[Math.min(c, this.channels - 1)] as Float32Array;
					(out[c] as Float32Array).set(source.subarray(this.offset, this.offset + take), written);
				}

				written += take;
				this.offset += take;
				this.held -= take;
				if (this.offset === length) {
					this.queue.shift();
					this.offset = 0;
				}
			}

			this.played += written;

			if (written < frames) {
				this.playing = false;
				this.underruns++;
			}
		}

		for (const channel of out) channel.fill(0, written);
	}

	counts(): Counts {
		return {
			underruns: this.underruns,
			skipped: this.skipped,
			held: this.held,
			played: this.played,
			playing: this.playing,
		};
	}
}
