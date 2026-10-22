import { describe, expect, it } from "vitest";
import { type Block, FRAMES, Malformed, decodedToInt24, fromInt24, pack, toInt24, unpack } from "./lossless";

/*
 * The lossless format.
 *
 * The one property that matters is that what comes out is what went in, every
 * sample, for every kind of signal -- and the kinds that break a coder like this
 * are not the musical ones. They are the shapes that push a branch to its edge:
 * full-scale noise that does not compress, a square wave at both rails whose
 * fourth-order residual is the largest one possible, a single spike in silence
 * that only the verbatim escape can write sensibly, blocks too short to have
 * partitions, and a mono stream. Each is round-tripped and compared exactly.
 */

const TOP = 8_388_607;
const BOTTOM = -8_388_608;

/** A seeded generator, so a failure is the same failure on the next run. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state / 2 ** 32;
	};
}

function block(channels: number[][], seq = 7): Block {
	return { rate: 48_000, stream: 0xdeadbeef, seq, channels: channels.map((c) => Int32Array.from(c)) };
}

function roundTrip(input: Block): Block {
	return unpack(pack(input));
}

function expectSame(input: Block) {
	const output = roundTrip(input);
	expect(output.rate).toBe(input.rate);
	expect(output.stream).toBe(input.stream);
	expect(output.seq).toBe(input.seq);
	expect(output.channels.length).toBe(input.channels.length);
	input.channels.forEach((channel, c) => expect(Array.from(output.channels[c] as Int32Array)).toEqual(Array.from(channel)));
	return output;
}

const frames = (make: (i: number) => number, n = FRAMES) => Array.from({ length: n }, (_, i) => make(i));

describe("a block comes back exactly as it went", () => {
	it("silence", () => {
		expectSame(block([frames(() => 0), frames(() => 0)]));
	});

	it("music-like stereo, the channels mostly alike", () => {
		const left = frames((i) => Math.round(3_000_000 * Math.sin(i / 7) + 800_000 * Math.sin(i / 1.3)));
		const right = left.map((v, i) => v + Math.round(40_000 * Math.sin(i / 3)));
		expectSame(block([left, right]));
	});

	it("channels doing different things", () => {
		expectSame(
			block([frames((i) => Math.round(TOP * Math.sin(i / 5))), frames((i) => Math.round(BOTTOM * Math.cos(i / 11)))]),
		);
	});

	it("full-scale noise, which does not compress", () => {
		const next = random(1);
		const noise = () => Math.floor(next() * (TOP - BOTTOM + 1)) + BOTTOM;
		expectSame(block([frames(noise), frames(noise)]));
	});

	it("a square wave at both rails, the largest residual there is", () => {
		const rail = (i: number) => (i % 2 ? TOP : BOTTOM);
		expectSame(block([frames(rail), frames((i) => rail(i + 1))]));
	});

	it("one spike in silence, in a packet still small", () => {
		const spike = block([frames((i) => (i === 500 ? TOP : 0)), frames((i) => (i === 501 ? BOTTOM : 0))]);
		expectSame(spike);
		expect(pack(spike).length).toBeLessThan(1024);
	});

	it("mono", () => {
		const next = random(2);
		expectSame(block([frames(() => Math.floor(next() * 2_000_000) - 1_000_000)]));
	});

	it("blocks too short for partitions, down to one frame", () => {
		const next = random(3);
		for (const n of [1, 2, 3, 4, 5, 9, 63, 64, 65, 961]) {
			const sample = () => Math.floor(next() * (TOP - BOTTOM + 1)) + BOTTOM;
			expectSame(block([frames(sample, n), frames(sample, n)]));
		}
	});

	it("a thousand random blocks of every character", () => {
		const next = random(4);
		for (let round = 0; round < 1000; round++) {
			const scale = 2 ** Math.floor(next() * 24);
			const shape = Math.floor(next() * 3);
			const make = (i: number) => {
				const v =
					shape === 0
						? Math.floor((next() - 0.5) * scale)
						: shape === 1
							? Math.round(scale * Math.sin(i / (1 + next() * 50)))
							: (i % 97 === 0 ? 1 : 0) * Math.floor((next() - 0.5) * 2 * TOP);
				return Math.max(BOTTOM, Math.min(TOP, v));
			};
			const n = 1 + Math.floor(next() * 1200);
			const stereo = next() < 0.8;
			expectSame(block(stereo ? [frames(make, n), frames(make, n)] : [frames(make, n)], round));
		}
	});
});

describe("the format earns its keep", () => {
	it("codes music-like sound in well under the raw size", () => {
		const left = frames((i) => Math.round(2_000_000 * Math.sin(i / 9) + 300_000 * Math.sin(i / 2.1)));
		const right = left.map((v, i) => v + Math.round(20_000 * Math.sin(i / 4)));
		const raw = FRAMES * 2 * 3;

		expect(pack(block([left, right])).length).toBeLessThan(raw * 0.6);
	});

	it("drops the eight empty bits of a 16-bit source, the commonest case there is", () => {
		const next = random(6);
		const noise16 = () => (Math.floor(next() * 65_536) - 32_768) * 256;
		const raw16 = FRAMES * 2 * 2;
		const sixteen = block([frames(noise16), frames(noise16)]);

		expectSame(sixteen);
		// 16-bit noise coded as 16-bit, not as 24.
		expect(pack(sixteen).length).toBeLessThan(raw16 * 1.03);
	});

	it("keeps noise, which cannot be predicted, within a percent and a half of its raw size", () => {
		// 0.6% over with the verbatim escape; 2.4% over in Rice codes alone.
		const next = random(5);
		const noise = () => Math.floor(next() * (TOP - BOTTOM + 1)) + BOTTOM;
		const raw = FRAMES * 2 * 3;

		expect(pack(block([frames(noise), frames(noise)])).length).toBeLessThan(raw * 1.015);
	});
});

describe("what it refuses", () => {
	it("a sample that is not 24-bit, rather than wrapping it", () => {
		expect(() => pack(block([[TOP + 1]]))).toThrow(RangeError);
		expect(() => pack(block([[BOTTOM - 1]]))).toThrow(RangeError);
	});

	it("a packet cut short, with a reason rather than garbage", () => {
		const bytes = pack(block([frames((i) => i * 1000), frames((i) => -i * 1000)]));
		expect(() => unpack(bytes.subarray(0, bytes.length - 40))).toThrow(Malformed);
		expect(() => unpack(bytes.subarray(0, 10))).toThrow(Malformed);
	});

	it("a packet from another version", () => {
		const bytes = pack(block([[1, 2, 3]]));
		bytes[0] = 9;
		expect(() => unpack(bytes)).toThrow(Malformed);
	});
});

describe("the float a browser has, as a 24-bit integer", () => {
	it("is exact for every sample a 16- or 24-bit source can produce", () => {
		for (const v of [0, 1, -1, 12_345, -8_388_608, 8_388_607, 256, -256]) {
			expect(toInt24(Math.fround(fromInt24(v)))).toBe(v);
		}
		for (let v = -32_768; v < 32_768; v += 97) {
			expect(toInt24(Math.fround(v / 32_768))).toBe(v * 256);
		}
	});

	it("rounds a float between two samples to the nearer, on either side of zero", () => {
		const step = 1 / 8_388_608;
		expect(toInt24(1000.6 * step)).toBe(1001);
		expect(toInt24(1000.4 * step)).toBe(1000);
		expect(toInt24(-1000.6 * step)).toBe(-1001);
		expect(toInt24(-1000.4 * step)).toBe(-1000);
	});

	it("clips rather than wraps a float past full scale", () => {
		expect(toInt24(1.5)).toBe(TOP);
		expect(toInt24(-1.5)).toBe(BOTTOM);
		expect(toInt24(1)).toBe(TOP);
	});
});

describe("a sample Chrome decoded, back to the integer the file held", () => {
	// What Chrome does: negative over 2^(n-1), positive over 2^(n-1) - 1, to a 32-bit float.
	const chrome16 = (v: number) => Math.fround(v < 0 ? v / 32_768 : v / 32_767);
	const chrome24 = (v: number) => {
		const wide = v * 256;
		return Math.fround(wide < 0 ? wide / 2_147_483_648 : wide / 2_147_483_647);
	};

	it("is every 16-bit sample, exactly, shifted into 24 bits", () => {
		const recover = decodedToInt24(16);
		for (let v = -32_768; v <= 32_767; v++) {
			if (recover(chrome16(v)) !== v * 256) throw new Error(`16-bit ${v} came back as ${recover(chrome16(v)) / 256}`);
		}
	});

	it("is every 24-bit sample, exactly, across the range and at both rails", () => {
		const recover = decodedToInt24(24);
		const next = random(7);
		const values = [-8_388_608, -8_388_607, -1, 0, 1, 4_194_303, 4_194_304, 8_388_606, 8_388_607];
		for (let i = 0; i < 200_000; i++) values.push(Math.floor(next() * 16_777_216) - 8_388_608);
		for (const v of values) {
			if (recover(chrome24(v)) !== v) throw new Error(`24-bit ${v} came back as ${recover(chrome24(v))}`);
		}
	});

	it("is not what the one-scale conversion gives, which is why it exists", () => {
		expect(toInt24(chrome16(6827))).not.toBe(6827 * 256);
	});

	it("leaves 24-bit files, and anything that was never integers, to the one-scale conversion", () => {
		expect(decodedToInt24(24)).toBe(toInt24);
		expect(decodedToInt24(0)).toBe(toInt24);
		expect(decodedToInt24(32)).toBe(toInt24);
	});
});
