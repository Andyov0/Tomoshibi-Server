import { Track } from "livekit-client";

/**
 * Sound carried without loss: the format.
 *
 * Every codec a browser will put on an audio track is a lossy one. Opus is very
 * good at sounding like the original, and at its ceiling nobody hears the
 * difference, but it is a model of what a listener will notice, and what it
 * sends is its own reconstruction. Somebody who asked for the sound they are
 * sharing to arrive as it left -- a lossless file playing at one end, the same
 * samples at the other -- cannot be given that on a media track at all. So the
 * samples go another way: as data, over the call's reliable data channel, which
 * retransmits until everything has arrived and delivers it in order. Nothing is
 * dropped, nothing is concealed, and what is played at the far end is, sample
 * for sample, what was captured here.
 *
 * This file is the part both ends agree on: the packet and the coding inside
 * it. It is the same idea as FLAC -- a fixed polynomial predictor chosen per
 * block, stereo optionally coded as mid and side, the prediction error written
 * in Rice codes with a parameter per partition and a verbatim escape -- written
 * out here rather than taken from a library, because the whole of it is a few
 * hundred lines, it has to be exactly invertible, and that is easier to know of
 * code that is short enough to read.
 *
 * Samples are 24-bit integers. The browser hands over 32-bit floats, whose
 * significand is 24 bits; for anything that came from a 16- or 24-bit source,
 * which is every file and every sound card, the conversion is exact. Going to
 * 16 bits would have rounded away the bottom byte of a 24-bit file, and keeping
 * the floats as they are would have cost a third more for bits no source has.
 */

/** Data-packet topics. One for the sound, one for asking for it. */
export const TOPIC = "lossless";
export const ASK_TOPIC = "lossless-ask";

/**
 * The name the Opus track of a lossless share is published under.
 *
 * The track goes out either way -- it is what everybody on an older page hears,
 * and what anybody hears if the lossless stream fails -- and its name is how a
 * listener learns there is a lossless stream to ask for. A share without it is
 * named LISTENING in sound.ts.
 */
export const LOSSLESS = "listening-lossless";

/**
 * One way of sharing sound by itself, and everything that tells it apart.
 *
 * There are two, and they are kept apart from top to bottom: sound captured
 * from an application or a tab, which goes out as a share's sound does, and
 * music played from the library by the song desk. They used to be one. The
 * desk published its music as a share's sound, and the SDK keeps one such
 * track per person: starting a screen share while a song played sent the
 * screen without its sound, and stopping it took the song with it, because
 * stopping a screen share unpublishes the share's sound as well. So the music
 * has a source of its own, Unknown, which nothing else here publishes, and its
 * own names and topics, so that a listener can hear both at once, losslessly,
 * and turn either down without the other.
 */
export interface Channel {
	/** What a listener's settings call it; see hearing.ts. */
	sound: "screen" | "music";
	source: Track.Source.ScreenShareAudio | Track.Source.Unknown;
	/** The Opus track's name when no lossless stream is offered beside it. */
	opus: string;
	/** Its name when one is: how a listener learns there is one to ask for. */
	lossless: string;
	/** Data-packet topics: the sound, and asking for it. */
	topic: string;
	ask: string;
}

/** Sound shared from an application or a tab. The names it has always had. */
export const SHARED: Channel = {
	sound: "screen",
	source: Track.Source.ScreenShareAudio,
	opus: "listening",
	lossless: LOSSLESS,
	topic: TOPIC,
	ask: ASK_TOPIC,
};

/** The song desk's music. */
export const MUSIC: Channel = {
	sound: "music",
	source: Track.Source.Unknown,
	opus: "music",
	lossless: "music-lossless",
	topic: "lossless-music",
	ask: "lossless-music-ask",
};

export const CHANNELS: readonly Channel[] = [SHARED, MUSIC];

/** Whether a publication is sound shared on this channel, in either form. */
export function onChannel(channel: Channel, publication: { source: Track.Source; trackName: string }): boolean {
	return (
		publication.source === channel.source &&
		(publication.trackName === channel.opus || publication.trackName === channel.lossless)
	);
}

/** How often a listener repeats its ask; an ask lasts three of these. */
export const ASK_EVERY = 5000;

/**
 * Samples per channel in a packet: 20 milliseconds at 48 kHz.
 *
 * Short enough that the largest packet, a block of full-scale noise that does
 * not compress at all, is about six kilobytes: well inside what a data message
 * is comfortable carrying through the media server. Longer blocks would code a
 * little tighter and be a little more expensive to lose a retransmission on.
 */
export const FRAMES = 960;

const VERSION = 1;
const HEADER = 16;

/** The largest and smallest 24-bit sample. */
const TOP = 8_388_607;
const BOTTOM = -8_388_608;

/** Partitions a channel's residual is split into, each with its own parameter. */
const PARTITIONS = 8;

/** One packet: who, which stream, where in it, and the samples. */
export interface Block {
	/** Samples a second. */
	rate: number;
	/** Chosen afresh each time somebody starts, so a restart is not a continuation. */
	stream: number;
	/** The packet's place in its stream. Consecutive from the first. */
	seq: number;
	/** One array per channel, 24-bit integers, all the same length. */
	channels: Int32Array[];
}

/** A float sample, as the browser has it, as a 24-bit integer. */
export function toInt24(sample: number): number {
	const scaled = Math.round(sample * 8_388_608);
	return scaled > TOP ? TOP : scaled < BOTTOM ? BOTTOM : scaled;
}

/** And back. Exact: every 24-bit integer over 2^23 is a 32-bit float. */
export function fromInt24(sample: number): number {
	return sample / 8_388_608;
}

/**
 * The 24-bit sample a file held, from the float Chrome decoded it to.
 *
 * Chrome turns a decoded integer into a float asymmetrically: a negative one is
 * divided by 2^(n-1) and a positive one by 2^(n-1) - 1, so that both rails land
 * on exactly -1 and 1. Found by printing what decodeAudioData made of a 16-bit
 * FLAC whose every sample was known: -24849 came back as -24849/32768 and 6827
 * as 6827/32767. Nothing is lost -- each integer still has its own float -- but
 * toInt24, which assumes one scale for both signs, moves every positive sample
 * a little, and three samples in four of a stereo file were reported changed.
 *
 * So for a 16-bit file the integer is recovered with the scale Chrome used for
 * its sign, and sent as the file's own sample shifted up eight bits.
 *
 * A 24-bit file needs nothing of the kind, and this says so rather than doing
 * something: Chrome decodes it through 32-bit integers, where the two scales
 * differ by one part in two thousand million, which moves a 24-bit sample by
 * less than a two-hundred-and-fifty-sixth of a step -- rounding takes it back
 * to the file's integer every time. A special case was written for it first,
 * and breaking it changed no result; the test that would have caught it now
 * holds toInt24 to every 24-bit value instead.
 *
 * Anything else -- a lossy file, captured sound -- was never integers, and
 * takes toInt24.
 */
export function decodedToInt24(bits: number): (sample: number) => number {
	if (bits === 16) {
		return (sample) => (sample > 0 ? Math.round(sample * 32_767) : Math.round(sample * 32_768)) * 256;
	}

	return toInt24;
}

/** Thrown for a packet that is not one of ours, or not whole. */
export class Malformed extends Error {
	constructor(why: string) {
		super(`not a lossless packet: ${why}`);
		this.name = "Malformed";
	}
}

/** A block, as bytes. */
export function pack(block: Block): Uint8Array {
	const count = block.channels.length;
	const frames = block.channels[0]?.length ?? 0;

	if (count < 1 || count > 2) throw new RangeError("one or two channels");
	if (frames < 1 || frames > 0xffff) throw new RangeError("between 1 and 65535 frames");
	for (const channel of block.channels) {
		if (channel.length !== frames) throw new RangeError("channels of different lengths");
		for (const sample of channel) {
			if (sample > TOP || sample < BOTTOM) throw new RangeError(`sample ${sample} is not 24-bit`);
		}
	}

	const bits = new BitWriter(HEADER + frames * count * 4);
	encodeChannels(bits, block.channels);
	const body = bits.finish();

	const out = new Uint8Array(HEADER + body.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, VERSION);
	view.setUint8(1, count);
	view.setUint16(2, frames, true);
	view.setUint32(4, block.rate, true);
	view.setUint32(8, block.stream >>> 0, true);
	view.setUint32(12, block.seq >>> 0, true);
	out.set(body, HEADER);

	return out;
}

/** Bytes, as a block. Throws Malformed for anything else. */
export function unpack(bytes: Uint8Array): Block {
	if (bytes.length < HEADER) throw new Malformed("shorter than its header");

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== VERSION) throw new Malformed(`version ${view.getUint8(0)}`);

	const count = view.getUint8(1);
	const frames = view.getUint16(2, true);
	if (count < 1 || count > 2) throw new Malformed(`${count} channels`);
	if (frames < 1) throw new Malformed("no frames");

	const channels = decodeChannels(new BitReader(bytes.subarray(HEADER)), count, frames);

	return {
		rate: view.getUint32(4, true),
		stream: view.getUint32(8, true),
		seq: view.getUint32(12, true),
		channels,
	};
}

/*
 * The coding.
 *
 * Per packet: for two channels, one bit saying whether they are coded as left
 * and right or as mid and side. Then per coded channel: five bits of wasted low
 * bits, three bits of predictor order, that many warm-up samples verbatim, and
 * the residual in partitions, each opening with five bits of Rice parameter --
 * or 31, then five bits of width, for values written plainly.
 *
 * The wasted bits are the low bits every sample in the channel has clear, and
 * they are the usual case rather than a corner: a 16-bit source in this 24-bit
 * container leaves the bottom eight empty in every sample. They are shifted
 * out before prediction and back in after, which is a third of the stream for
 * most music and costs five bits a packet where there is nothing to save.
 */

function encodeChannels(bits: BitWriter, channels: Int32Array[]): void {
	if (channels.length === 1) {
		encodeChannel(bits, channels[0] as Int32Array);
		return;
	}

	const left = channels[0] as Int32Array;
	const right = channels[1] as Int32Array;
	const mid = new Int32Array(left.length);
	const side = new Int32Array(left.length);
	for (let i = 0; i < left.length; i++) {
		const l = left[i] as number;
		const r = right[i] as number;
		mid[i] = (l + r) >> 1;
		side[i] = l - r;
	}

	// Whichever pair predicts more cheaply. Mid and side wins on most music,
	// where the channels are mostly the same; left and right wins on anything
	// with the two sides doing different things, such as a test signal.
	const apart = bestOrder(left).cost + bestOrder(right).cost;
	const together = bestOrder(mid).cost + bestOrder(side).cost;

	if (together < apart) {
		bits.write(1, 1);
		encodeChannel(bits, mid);
		encodeChannel(bits, side);
	} else {
		bits.write(0, 1);
		encodeChannel(bits, left);
		encodeChannel(bits, right);
	}
}

function decodeChannels(bits: BitReader, count: number, frames: number): Int32Array[] {
	if (count === 1) return [decodeChannel(bits, frames)];

	const joint = bits.read(1) === 1;
	const a = decodeChannel(bits, frames);
	const b = decodeChannel(bits, frames);
	if (!joint) return [a, b];

	const left = new Int32Array(frames);
	const right = new Int32Array(frames);
	for (let i = 0; i < frames; i++) {
		const side = b[i] as number;
		// The bit the halving dropped is the low bit of the side: the sum and
		// the difference of two integers are both odd or both even.
		const doubled = (a[i] as number) * 2 + (side & 1);
		left[i] = (doubled + side) / 2;
		right[i] = (doubled - side) / 2;
	}

	return [left, right];
}

/** The residual of one fixed predictor at one position. */
function residual(x: Int32Array, i: number, order: number): number {
	switch (order) {
		case 0:
			return x[i] as number;
		case 1:
			return (x[i] as number) - (x[i - 1] as number);
		case 2:
			return (x[i] as number) - 2 * (x[i - 1] as number) + (x[i - 2] as number);
		case 3:
			return (x[i] as number) - 3 * (x[i - 1] as number) + 3 * (x[i - 2] as number) - (x[i - 3] as number);
		default:
			return (
				(x[i] as number) -
				4 * (x[i - 1] as number) +
				6 * (x[i - 2] as number) -
				4 * (x[i - 3] as number) +
				(x[i - 4] as number)
			);
	}
}

/** What the residual is added to on the way back. The same polynomials. */
function prediction(x: Int32Array, i: number, order: number): number {
	switch (order) {
		case 0:
			return 0;
		case 1:
			return x[i - 1] as number;
		case 2:
			return 2 * (x[i - 1] as number) - (x[i - 2] as number);
		case 3:
			return 3 * (x[i - 1] as number) - 3 * (x[i - 2] as number) + (x[i - 3] as number);
		default:
			return 4 * (x[i - 1] as number) - 6 * (x[i - 2] as number) + 4 * (x[i - 3] as number) - (x[i - 4] as number);
	}
}

const MAX_ORDER = 4;

/** The order whose residual is smallest in sum, as FLAC chooses it. */
function bestOrder(x: Int32Array): { order: number; cost: number } {
	const top = Math.min(MAX_ORDER, x.length - 1);
	let best = { order: 0, cost: Number.POSITIVE_INFINITY };

	for (let order = 0; order <= Math.max(0, top); order++) {
		let cost = 0;
		for (let i = order; i < x.length; i++) cost += Math.abs(residual(x, i, order));
		if (cost < best.cost) best = { order, cost };
	}

	return best;
}

/** Signed to unsigned, small magnitudes to small numbers. */
function zigzag(value: number): number {
	return value >= 0 ? value * 2 : -value * 2 - 1;
}

function unzigzag(value: number): number {
	return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

/** Bits a warm-up sample is written in: a side channel is 25 bits signed. */
const WARMUP_BITS = 27;
const WARMUP_OFFSET = 2 ** (WARMUP_BITS - 1);

/** Where each partition starts and ends, the first shortened by the warm-up. */
function partitions(frames: number, order: number): [number, number][] {
	const count = frames >= PARTITIONS * 8 ? PARTITIONS : 1;
	const size = Math.floor(frames / count);
	const out: [number, number][] = [];

	for (let p = 0; p < count; p++) {
		const start = p === 0 ? order : p * size;
		const end = p === count - 1 ? frames : (p + 1) * size;
		out.push([start, end]);
	}

	return out;
}

const ESCAPE = 31;

/** Low bits clear in every sample, at most 24; none for silence. */
function wastedBits(x: Int32Array): number {
	let all = 0;
	for (const sample of x) all |= sample;
	if (all === 0) return 0;

	let shift = 0;
	while ((all & 1) === 0 && shift < 24) {
		all >>= 1;
		shift++;
	}

	return shift;
}

function encodeChannel(bits: BitWriter, samples: Int32Array): void {
	const shift = wastedBits(samples);
	bits.write(shift, 5);
	const x = shift === 0 ? samples : samples.map((sample) => sample / 2 ** shift);

	const { order } = bestOrder(x);
	bits.write(order, 3);
	for (let i = 0; i < order; i++) bits.write((x[i] as number) + WARMUP_OFFSET, WARMUP_BITS);

	for (const [start, end] of partitions(x.length, order)) {
		const values: number[] = [];
		let sum = 0;
		let largest = 0;
		for (let i = start; i < end; i++) {
			const u = zigzag(residual(x, i, order));
			values.push(u);
			sum += u;
			if (u > largest) largest = u;
		}

		// The parameter near log2 of the mean, tried a step either side and
		// against writing the values plainly; whichever is shortest. Plain wins
		// on sound with nothing to predict -- noise near full scale, where the
		// unary bit Rice spends on every value is pure overhead -- and keeps
		// such a block within a percent of its raw size rather than two and a
		// half. It is not needed to contain a spike: a parameter chosen from a
		// mean that includes the spike bounds its unary run at twice the
		// partition's length.
		const width = largest === 0 ? 0 : Math.floor(Math.log2(largest)) + 1;
		let choice = { k: ESCAPE, cost: 5 + values.length * width };

		const mean = values.length ? sum / values.length : 0;
		const guess = mean < 1 ? 0 : Math.floor(Math.log2(mean));
		for (let k = Math.max(0, guess - 1); k <= Math.min(30, guess + 1); k++) {
			let cost = 0;
			for (const u of values) cost += Math.floor(u / 2 ** k) + 1 + k;
			if (cost < choice.cost) choice = { k, cost };
		}

		if (choice.k === ESCAPE) {
			bits.write(ESCAPE, 5);
			bits.write(width, 5);
			for (const u of values) bits.write(u, width);
		} else {
			bits.write(choice.k, 5);
			for (const u of values) bits.rice(u, choice.k);
		}
	}
}

function decodeChannel(bits: BitReader, frames: number): Int32Array {
	const shift = bits.read(5);
	if (shift > 24) throw new Malformed(`${shift} wasted bits`);

	const order = bits.read(3);
	if (order > MAX_ORDER || order > frames) throw new Malformed(`predictor order ${order}`);

	const x = new Int32Array(frames);
	for (let i = 0; i < order; i++) x[i] = bits.read(WARMUP_BITS) - WARMUP_OFFSET;

	for (const [start, end] of partitions(frames, order)) {
		const k = bits.read(5);
		const width = k === ESCAPE ? bits.read(5) : 0;

		for (let i = start; i < end; i++) {
			const u = k === ESCAPE ? bits.read(width) : bits.unrice(k);
			const value = unzigzag(u) + prediction(x, i, order);
			if (value > 2 ** 25 || value < -(2 ** 25)) throw new Malformed("a sample out of range");
			x[i] = value;
		}
	}

	if (shift > 0) for (let i = 0; i < frames; i++) x[i] = (x[i] as number) * 2 ** shift;

	return x;
}

/*
 * Bits.
 *
 * Arithmetic rather than shifts wherever a value can reach 2^31, because a
 * JavaScript shift is a 32-bit signed operation and turns the top bit into a
 * sign. Values are written most significant bit first.
 */

class BitWriter {
	private bytes: Uint8Array;
	private length = 0;
	private pending = 0;
	private count = 0;

	constructor(capacity: number) {
		this.bytes = new Uint8Array(Math.max(64, capacity));
	}

	/** Write `width` bits of a value that fits in them; up to 32. */
	write(value: number, width: number): void {
		if (width > 16) {
			const low = width - 16;
			const unit = 2 ** low;
			this.put(Math.floor(value / unit), 16);
			this.put(value % unit, low);
			return;
		}

		this.put(value, width);
	}

	/** A Rice code: the quotient in unary, ones-terminated, then k bits. */
	rice(value: number, k: number): void {
		const unit = 2 ** k;
		let quotient = Math.floor(value / unit);
		while (quotient >= 16) {
			this.put(0, 16);
			quotient -= 16;
		}
		this.put(1, quotient + 1);
		if (k > 0) this.write(value % unit, k);
	}

	private put(value: number, width: number): void {
		if (width === 0) return;
		this.pending = this.pending * 2 ** width + value;
		this.count += width;

		while (this.count >= 8) {
			this.count -= 8;
			const unit = 2 ** this.count;
			const byte = Math.floor(this.pending / unit);
			this.pending -= byte * unit;
			this.push(byte);
		}
	}

	private push(byte: number): void {
		if (this.length === this.bytes.length) {
			const grown = new Uint8Array(this.bytes.length * 2);
			grown.set(this.bytes);
			this.bytes = grown;
		}
		this.bytes[this.length++] = byte;
	}

	finish(): Uint8Array {
		if (this.count > 0) {
			this.push(this.pending * 2 ** (8 - this.count));
			this.pending = 0;
			this.count = 0;
		}

		return this.bytes.slice(0, this.length);
	}
}

class BitReader {
	private position = 0;

	constructor(private readonly bytes: Uint8Array) {}

	private bit(): number {
		const at = this.position >> 3;
		if (at >= this.bytes.length) throw new Malformed("cut short");
		const value = ((this.bytes[at] as number) >> (7 - (this.position & 7))) & 1;
		this.position++;
		return value;
	}

	read(width: number): number {
		let value = 0;
		for (let i = 0; i < width; i++) value = value * 2 + this.bit();
		return value;
	}

	unrice(k: number): number {
		let quotient = 0;
		while (this.bit() === 0) {
			quotient++;
			// No residual this coding writes is anywhere near this long; a run
			// of zeros past it is a packet that is not one.
			if (quotient > 1 << 26) throw new Malformed("a runaway code");
		}

		return quotient * 2 ** k + (k > 0 ? this.read(k) : 0);
	}
}
