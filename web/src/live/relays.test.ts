/**
 * What these guard: measuring the relays is an optimisation, and an
 * optimisation that can stop a call from happening is worse than no
 * optimisation at all.
 *
 * Every failure below — an endpoint that is not there, a relay that never
 * answers, a body that is not what it should be — has to end with a join that
 * proceeds without a preference. The server falls back to keeping the room
 * together, which is a working call on a possibly worse route, and that is the
 * right end for anything that went wrong out here.
 *
 * And the rounds. Each relay is timed five times and given the median of the
 * rounds it answered, because the first reading over UDP comes back high and
 * one reading was enough to rank a near relay behind a far one. What would go
 * wrong silently: the rounds of one relay overlapping, so that all five pay for
 * the first packet together and the median is of five first readings; the
 * relays being timed one after another, so that a fleet of eight waits for
 * forty round trips; a relay that dropped most of its rounds being ranked on
 * the one that came back; a dead relay being waited on for all five timeouts;
 * and the two kinds of reading being mixed in one ranking after all.
 *
 * On a clock of the tests' own, so that a relay that never answers costs no
 * real time and every reading is exactly the delay it was given.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENOUGH, ROUNDS, fastest, forget, mainland, preferred, reading, relays, timings } from "./relays";

const sh = { name: "shanghai", url: "wss://sh.example.com" };
const hk = { name: "hongkong", url: "wss://hk.example.com" };
const jp = { name: "tokyo", url: "wss://jp.example.com" };

beforeEach(() => {
	forget();
	vi.restoreAllMocks();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

/** Let the clock run until nothing is waiting on it, and answer what was asked. */
async function settle<T>(pending: Promise<T>): Promise<T> {
	await vi.runAllTimersAsync();
	return pending;
}

/**
 * How many sockets were opened, so a test can say a measurement was not retaken.
 *
 * Counted rather than read off the fetch mock, because measuring no longer goes
 * through fetch: a probe opens the signalling socket, which is the request a
 * call actually begins with and, unlike a plain GET, not the shape of thing that
 * gets a relay in mainland China blocked.
 */
let opened: string[] = [];

/** The most sockets one host had open at once, by host. */
let overlap: Record<string, number> = {};

/**
 * A relay's answers: one delay for every round, or a delay per round, where a
 * missing entry is a round it did not answer and is left to the probe's own
 * timeout. A relay absent from the map never answers at all.
 */
type Answers = Record<string, number | Array<number | undefined>>;

function answerFor(answers: Answers, host: string, round: number): number | undefined {
	const said = answers[host];
	return Array.isArray(said) ? said[round] : said;
}

/** Serve the relay list over fetch, and answer each relay's socket as told. */
function serve(list: unknown, measure: boolean, delays: Answers) {
	opened = [];
	overlap = {};

	const open: Record<string, number> = {};

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string) => {
			if (input === "/api/relays") {
				return new Response(JSON.stringify({ relays: list, measure }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}

			throw new Error(`nothing should be fetched but the list, got ${input}`);
		}),
	);

	class Socket {
		onopen: (() => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		private done = false;
		private readonly host: string;

		constructor(url: string) {
			this.host = new URL(url).host;
			const round = opened.filter((one) => new URL(one).host === this.host).length;

			opened.push(url);
			const now = (open[this.host] ?? 0) + 1;
			open[this.host] = now;
			overlap[this.host] = Math.max(overlap[this.host] ?? 0, now);

			const delay = answerFor(delays, this.host, round);
			if (delay === undefined) return;

			// Closed rather than opened: with no token the relay refuses, and it
			// can only refuse after the same round trip that would have carried
			// a call. That refusal is the measurement.
			setTimeout(() => {
				this.end();
				this.onclose?.();
			}, delay);
		}

		close() {
			this.end();
		}

		private end() {
			if (this.done) return;
			this.done = true;
			open[this.host] = (open[this.host] ?? 1) - 1;
		}
	}

	vi.stubGlobal("WebSocket", Socket);
}

/** How many STUN requests went to each probe address, and how many are still open. */
let stunned: Record<string, number> = {};
let peersOpen = 0;

/**
 * Answer STUN as told: a delay per probe address, or per round. A round with no
 * answer either never answers — left to the timeout — or, where `quickly`
 * names the address, ends its gathering at once with nothing reflexive, which
 * is how a browser says a STUN server sent nothing back.
 */
function stun(answers: Answers, quickly: string[] = []) {
	stunned = {};
	peersOpen = 0;

	class Peer {
		onicecandidate: ((event: { candidate: { type: string } | null }) => void) | null = null;
		private closed = false;
		private readonly at: string;
		private readonly round: number;

		constructor(config: { iceServers: Array<{ urls: string }> }) {
			this.at = (config.iceServers[0]?.urls ?? "").replace(/^stun:/, "");
			this.round = stunned[this.at] ?? 0;
			stunned[this.at] = this.round + 1;
			peersOpen++;
		}

		createDataChannel() {}

		createOffer() {
			return Promise.resolve({});
		}

		setLocalDescription() {
			const delay = answerFor(answers, this.at, this.round);

			if (delay !== undefined) {
				setTimeout(() => !this.closed && this.onicecandidate?.({ candidate: { type: "srflx" } }), delay);
			} else if (quickly.includes(this.at)) {
				queueMicrotask(() => !this.closed && this.onicecandidate?.({ candidate: null }));
			}

			return Promise.resolve();
		}

		close() {
			if (this.closed) return;
			this.closed = true;
			peersOpen--;
		}
	}

	vi.stubGlobal("RTCPeerConnection", Peer);
}

describe("relays", () => {
	it("reports what the control node offers", async () => {
		serve([sh, hk], true, {});

		const offered = await relays();

		expect(offered.measure).toBe(true);
		expect(offered.relays.map((relay) => relay.name)).toEqual(["shanghai", "hongkong"]);
	});

	it("treats a missing endpoint as nothing to choose", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		expect(await relays()).toEqual({ relays: [], measure: false });
	});

	it("treats an unreadable body as nothing to choose", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("<html>a proxy error page</html>", { status: 200 })),
		);

		expect(await relays()).toEqual({ relays: [], measure: false });
	});
});

/*
 * What a relay's rounds come to. The numbers the native core settles its rounds
 * by are the same, so that the app and the page say the same thing about a relay.
 */
describe("reading", () => {
	it("is five rounds and three of them answering", () => {
		expect(ROUNDS).toBe(5);
		expect(ENOUGH).toBe(3);
	});

	it("is the median, which a first reading far above the rest does not move", () => {
		expect(reading([400, 30, 50, 40, 35])).toBe(40);
	});

	it("is the median of the rounds that answered, a miss being no reading rather than a slow one", () => {
		expect(reading([undefined, 30, 50, 40, undefined])).toBe(40);
	});

	it("is the mean of the middle two of four", () => {
		expect(reading([40, undefined, 10, 30, 20])).toBe(25);
	});

	it("is nothing where fewer than three rounds answered", () => {
		expect(reading([undefined, 30, undefined, 40, undefined])).toBeUndefined();
		expect(reading([20])).toBeUndefined();
		expect(reading([])).toBeUndefined();
		expect(reading([30, 40, 50])).toBe(40);
	});
});

describe("the rounds", () => {
	it("time each relay five times, one round after another, and every relay at once", async () => {
		serve([sh, hk, jp], true, {
			"sh.example.com": 100,
			"hk.example.com": 100,
			"jp.example.com": 100,
		});

		const began = performance.now();
		const took = await settle(timings([sh, hk, jp]));
		const spent = performance.now() - began;

		for (const host of ["sh.example.com", "hk.example.com", "jp.example.com"]) {
			expect(opened.filter((url) => new URL(url).host === host)).toHaveLength(5);
			// Never two of one relay's rounds at once, which would make them five
			// answers to one moment.
			expect(overlap[host]).toBe(1);
		}

		expect([...took.values()]).toEqual([100, 100, 100]);

		// Side by side: the slowest relay's five rounds, not fifteen.
		expect(spent).toBeLessThan(600);
	});

	it("rank a relay by its median and not by a first reading far above it", async () => {
		serve([sh, hk], true, {
			// Nearest, and its first answer is slow, as the first over UDP is.
			"sh.example.com": [400, 30, 30, 30, 30],
			"hk.example.com": 60,
		});

		expect(await settle(fastest([sh, hk]))).toBe("shanghai");
	});

	it("count a relay that answers fewer than three of five as not answering", async () => {
		serve([sh, hk], true, {
			"sh.example.com": [10, undefined, 10, undefined, undefined],
			"hk.example.com": 50,
		});

		const took = await settle(timings([sh, hk]));

		expect(took.get("shanghai")).toBeUndefined();
		expect(took.get("hongkong")).toBe(50);
	});

	it("stop timing a relay once it cannot reach three answers", async () => {
		serve([sh, hk], true, { "hk.example.com": 40 });

		const began = performance.now();
		const took = await settle(timings([sh, hk]));
		const spent = performance.now() - began;

		expect(took.get("shanghai")).toBeUndefined();
		expect(opened.filter((url) => new URL(url).host === "sh.example.com")).toHaveLength(3);

		// Three timeouts, not five.
		expect(spent).toBeLessThanOrEqual(3 * 1500 + 50);
	});
});

describe("over UDP", () => {
	const sh = { name: "shanghai", url: "wss://sh.example.com", probe: "sh.example.com:3478" };
	const hk = { name: "hongkong", url: "wss://hk.example.com", probe: "hk.example.com:3478" };

	it("measures every relay over UDP where each answers enough rounds, and opens no socket", async () => {
		serve([sh, hk], true, { "sh.example.com": 300, "hk.example.com": 300 });
		stun({ "sh.example.com:3478": [200, 20, 20, 20, 20], "hk.example.com:3478": 30 });

		const took = await settle(timings([sh, hk]));

		expect(took.get("shanghai")).toBe(20);
		expect(took.get("hongkong")).toBe(30);
		expect(stunned).toEqual({ "sh.example.com:3478": 5, "hk.example.com:3478": 5 });
		expect(opened).toEqual([]);
		expect(peersOpen).toBe(0);
	});

	it("measures everybody over the socket when one relay answers too few UDP rounds", async () => {
		serve([sh, hk], true, { "sh.example.com": 90, "hk.example.com": 120 });
		stun({ "sh.example.com:3478": [20, undefined, undefined, 20, undefined], "hk.example.com:3478": 30 });

		const took = await settle(timings([sh, hk]));

		// The socket's numbers for both, never a UDP reading beside a TCP one.
		expect(took.get("shanghai")).toBe(90);
		expect(took.get("hongkong")).toBe(120);
	});

	it("gives up everybody's UDP rounds as soon as one relay is out", async () => {
		serve([sh, hk], true, { "sh.example.com": 90, "hk.example.com": 120 });
		// Shanghai's STUN answers nothing, said at once; Hong Kong is slow.
		stun({ "hk.example.com:3478": 1000 }, ["sh.example.com:3478"]);

		const pending = timings([sh, hk]);

		// Shanghai is out before Hong Kong's first round has come back, and
		// nothing is left waiting on Hong Kong's.
		await vi.advanceTimersByTimeAsync(50);
		expect(stunned["sh.example.com:3478"]).toBe(3);
		expect(stunned["hk.example.com:3478"]).toBe(1);
		expect(peersOpen).toBe(0);

		const took = await settle(pending);
		expect(took.get("hongkong")).toBe(120);
	});
});

describe("fastest", () => {
	it("names the relay that answered soonest", async () => {
		serve([sh, hk, jp], true, {
			"sh.example.com": 40,
			"hk.example.com": 5,
			"jp.example.com": 60,
		});

		expect(await settle(fastest([sh, hk, jp]))).toBe("hongkong");
	});

	it("skips a relay that does not answer", async () => {
		serve([sh, hk, jp], true, {
			// Shanghai is down; it would have been nearest had it been up.
			"hk.example.com": 30,
			"jp.example.com": 50,
		});

		expect(await settle(fastest([sh, hk, jp]))).toBe("hongkong");
	});

	it("names nothing when no relay answers", async () => {
		serve([sh, hk], true, {});

		expect(await settle(fastest([sh, hk]))).toBeUndefined();
	});

	it("does not measure when there is no choice", async () => {
		serve([sh], true, { "sh.example.com": 5 });

		expect(await fastest([sh])).toBe("shanghai");
		forget();
		expect(await fastest([])).toBeUndefined();

		// Not one socket opened. Measuring a list of one costs a round trip and
		// cannot change the answer.
		expect(opened).toEqual([]);
	});

	it("reuses a recent measurement rather than taking it again", async () => {
		serve([sh, hk], true, { "sh.example.com": 40, "hk.example.com": 5 });

		expect(await settle(fastest([sh, hk]))).toBe("hongkong");

		const before = opened.length;
		expect(await settle(fastest([sh, hk]))).toBe("hongkong");

		expect(opened.length).toBe(before);
	});

	// A cached name that is no longer offered must not be sent: the deployment
	// has changed its relays and the old name would be ignored by the server,
	// silently costing this client the measurement it thought it had.
	it("measures again when the cached relay is gone from the list", async () => {
		serve([sh, hk], true, { "sh.example.com": 40, "hk.example.com": 5 });
		expect(await settle(fastest([sh, hk]))).toBe("hongkong");

		serve([sh, jp], true, { "sh.example.com": 40, "jp.example.com": 5 });
		expect(await settle(fastest([sh, jp]))).toBe("tokyo");
	});
});

describe("preferred", () => {
	it("is empty when the deployment does not want a measurement", async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(JSON.stringify({ relays: [sh, hk], measure: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetcher);

		expect(await preferred()).toBe("");
		// The list was asked for, and nothing was measured after it said no.
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("is empty when nothing answered", async () => {
		serve([sh, hk], true, {});

		expect(await settle(preferred())).toBe("");
	});

	it("is empty when the whole thing throws", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);

		expect(await preferred()).toBe("");
	});

	it("names the fastest when there is one", async () => {
		serve([sh, hk], true, { "sh.example.com": 50, "hk.example.com": 5 });

		expect(await settle(preferred())).toBe("hongkong");
	});
});

/*
 * Which regions are mainland China, which decides whether a viewer is sent
 * straight to the relay for YouTube. Wrong one way, a viewer in Shanghai waits
 * for a player that never comes; wrong the other, somebody abroad is streamed
 * every video through the deployment for nothing.
 */
describe("mainland", () => {
	it("is the deployment's CN regions, however they are typed", () => {
		for (const region of ["CN-East", "cn-south", "CN-Southwest", "CN", " CN-North ", "CN/Shanghai"]) {
			expect(mainland(region), region).toBe(true);
		}
	});

	it("is nothing else", () => {
		for (const region of [undefined, "", "HK", "JP-Tokyo", "Oversea/Asia", "CNX", "SG-CN"]) {
			expect(mainland(region), String(region)).toBe(false);
		}
	});
});
