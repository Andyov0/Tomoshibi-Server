/**
 * Measuring the relays, so a call is held on whichever one is actually closest.
 *
 * A deployment can spread its media servers over several places and hand each
 * client to one of them. Which one is nearest is not something the server can
 * work out: it sees an address, and an address says where a network registered a
 * block, not how long a packet takes to get there. The browser about to make the
 * call is the only party that can answer, and it can answer by asking.
 *
 * So this opens the signalling socket to every relay at once, times it, and the
 * fastest name travels with the join. The server treats that name as a
 * preference and looks it up in its own list, so nothing here can send a meeting
 * anywhere the deployment did not already choose.
 *
 * Timed by opening the socket rather than by fetching a health endpoint, and the
 * health endpoint no longer exists. Two reasons, and the second is the one that
 * settled it. A WebSocket upgrade is the request a call actually begins with, so
 * it measures the thing being chosen between rather than something adjacent to
 * it. And a relay in mainland China is taken off the air by something that sends
 * an ordinary HTTPS request and reads the answer — an endpoint replying to
 * anybody who asks is that probe's evidence, served continuously and by us.
 *
 * Each relay is timed five times and given the median, not timed once. One
 * reading was what this took, and the first reading is the one that lies: over
 * UDP it reliably came back high (the owner's own measurements, 2026-10-19 —
 * "udp 第一次测试总是会偏高"), whether from the browser setting up its first peer
 * connection or the path setting up state for a new flow, and a single high
 * reading was enough to rank a near relay behind a far one. A median of five
 * shrugs off that one and any
 * other stray; an average would not. The native core takes the same five and
 * the same median, so that the app and this page say the same numbers about the
 * same relays.
 */

/** One relay, as the control node describes it. */
export interface Relay {
	name: string;
	url: string;
	region?: string;
	/** What a person is shown instead of the name, which is a key and not a word. */
	label?: string;
	/** Held in reserve: it works, and every byte of a call on it goes the long way. */
	fallback?: boolean;
	/** Only administrators are offered it, and only they may ask for it. */
	adminOnly?: boolean;
	/** Where it answers STUN binding requests, as host:port. */
	probe?: string;
	/** Here, but not taking calls. Shown greyed rather than hidden. */
	maintenance?: boolean;
	/**
	 * Where the machine is, in degrees, for the globe on the join screen.
	 *
	 * Absent where nobody has said. A relay without a place is left off the globe
	 * rather than guessed at from its region — a box dropped in the middle of a
	 * country it is not in looks exactly as authoritative as the ones that are
	 * right.
	 */
	lat?: number;
	lon?: number;
}

/**
 * Whether a relay's region puts it in mainland China.
 *
 * By the deployment's own labels, CN-East, CN-South and so on, read the way the
 * picker and the dictionaries read them: case aside, and "CN" alone or as the
 * first part of a path counting too. Nothing else is taken as a sign of it --
 * not a flag in a label, not an address -- because a guess that is wrong
 * here sends somebody abroad to the relay for every YouTube video, which costs
 * the deployment a stream nobody needed.
 */
export function mainland(region: string | undefined): boolean {
	return /^cn(?:$|[-/\s])/i.test((region ?? "").trim());
}

export interface RelayList {
	relays: Relay[];
	/** Whether this deployment will act on a measurement. */
	measure: boolean;
	/**
	 * How many relays there are and how many are answering.
	 *
	 * Both, because either alone says nothing: three answering is excellent out
	 * of three and alarming out of eleven.
	 */
	fleet?: { online: number; total: number };
}

/**
 * How long to wait for one reading before giving up on it.
 *
 * Short on purpose. This runs between somebody pressing join and their call
 * starting, and a relay that has not answered in a second and a half is not the
 * one to hold a conversation on. A reading that times out is a round the relay
 * did not answer; a relay that is down misses every round and is skipped
 * entirely, and the call goes elsewhere, which is the behaviour wanted from a
 * timeout that sits in front of a person waiting.
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * How many times each relay is timed, and how many of those it must answer to
 * be counted as answering at all.
 *
 * Five, because a median needs an odd number to land on a reading rather than
 * between two, three is too few to outvote a first reading and the one stray
 * beside it, and every round is a round trip somebody pressing Join waits for.
 * Three of the five, because a relay that answers fewer than that is one
 * dropping more than half of what it is sent — not a machine to put a call on
 * however quick the rounds that did come back — and because a median of one or
 * two readings is the single reading this replaced, back again.
 *
 * Which is also what bounds the wait. The rounds of one relay run one after
 * another, so that each is a fresh reading rather than five answers to the same
 * moment (five at once would all pay for the first packet together, and the
 * median would be of five first readings); the relays run side by side, so the
 * whole is the slowest relay's five rounds and not everybody's added up. And a
 * relay stops being timed the moment it has missed three, since it can no longer
 * reach three answers: a relay that is down costs three timeouts, not five.
 */
export const ROUNDS = 5;
export const ENOUGH = 3;

/**
 * How long a measurement is trusted before it is taken again.
 *
 * Long enough that joining three rooms in a row does not measure three times,
 * short enough that a route which changed during a working day is noticed.
 * Kept in memory rather than in storage: a measurement is about the network this
 * tab is on, and a laptop that moved between two networks would otherwise carry
 * the old answer to the new one.
 */
const CACHE_MS = 5 * 60 * 1000;

let cached: { name: string; at: number } | undefined;

/** What the control node offers, or nothing if it does not answer. */
export async function relays(): Promise<RelayList> {
	try {
		const response = await fetch("/api/relays", { headers: { accept: "application/json" } });
		if (!response.ok) return { relays: [], measure: false };

		const body = (await response.json()) as Partial<RelayList>;

		return {
			relays: Array.isArray(body.relays) ? body.relays : [],
			measure: body.measure === true,
			// Carried through rather than dropped. The lobby's indicator waits on
			// this and nothing else, so leaving it out did not make the light say
			// something wrong — it made the whole light, its three colours and its
			// polling, never appear at all.
			fleet: body.fleet,
		};
	} catch {
		// A deployment that does not serve this endpoint is an older one, or a
		// full deployment holding its own media. Either way there is nothing to
		// choose between and the join proceeds exactly as it did before.
		return { relays: [], measure: false };
	}
}

/**
 * Time one relay, returning how long it took or nothing if it failed.
 *
 * Opened as a WebSocket rather than fetched over HTTPS, and the reason is not
 * that it is tidier. A relay in mainland China is probed by something that sends
 * an ordinary HTTPS request and reads what comes back; a port that answers is a
 * website, and an unregistered one is taken off the air. Every client measuring
 * every relay with a plain fetch before every join is that probe, arriving from
 * the deployment's own users, continuously.
 *
 * The upgrade is also the honest measurement. It is the exact request the call
 * is about to make, so what is timed is the path that will carry it rather than
 * one that merely runs alongside — a relay can serve a small GET quickly and
 * still refuse or stall the signalling socket.
 *
 * No token is sent, so the relay refuses and closes. That refusal is a complete
 * round trip, which is all this needs.
 */
/**
 * Time one round trip over UDP, the way the call will go.
 *
 * The other measurement below opens the signalling socket, which is TCP: a
 * handshake, a TLS handshake and an HTTP upgrade, so about three round trips
 * before anything comes back. It ranks relays correctly — every one pays the
 * same — and it reads as three times too slow, which is a number nobody
 * believes and therefore nobody uses.
 *
 * A browser cannot open a UDP socket, but it can be given a STUN server and
 * asked to find its own address, and the time to that answer is one round trip
 * on exactly the path the media will take. The relay answers binding requests
 * for this and nothing else.
 *
 * Nothing is connected and nothing is sent. The peer connection exists to make
 * the browser send one STUN request, and it is closed the moment the answer
 * comes back.
 */
function overUDP(relay: Relay, stop?: AbortSignal): Promise<number | undefined> {
	if (!relay.probe || stop?.aborted) return Promise.resolve(undefined);

	return new Promise((resolve) => {
		let peer: RTCPeerConnection;
		try {
			peer = new RTCPeerConnection({
				iceServers: [{ urls: `stun:${relay.probe}` }],
				// Only the one server's answer is wanted. Left to itself the
				// browser would also gather host candidates, which cost nothing
				// but arrive first and would be timed instead.
				iceTransportPolicy: "all",
			});
		} catch {
			resolve(undefined);
			return;
		}

		const started = performance.now();

		let settled = false;
		const finish = (took: number | undefined) => {
			if (settled) return;
			settled = true;

			clearTimeout(timer);
			stop?.removeEventListener("abort", abandon);
			try {
				peer.close();
			} catch {
				// Already closing, which is one of the ways this ends.
			}

			resolve(took);
		};

		const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);

		// Called off when the measurement it belongs to has been given up,
		// rather than left to run out its timeout with a peer connection open.
		const abandon = () => finish(undefined);
		stop?.addEventListener("abort", abandon, { once: true });

		peer.onicecandidate = (event) => {
			// The reflexive one, which is the relay's answer. Host candidates
			// are local and arrive immediately; relay candidates need TURN,
			// which this is deliberately not.
			if (event.candidate?.type === "srflx") finish(performance.now() - started);

			// End of gathering with nothing reflexive means no answer came.
			if (event.candidate === null) finish(undefined);
		};

		// A channel so there is something to gather for.
		try {
			peer.createDataChannel("probe");
			void peer.createOffer().then((offer) => peer.setLocalDescription(offer));
		} catch {
			finish(undefined);
		}
	});
}

function overSignalling(relay: Relay, stop?: AbortSignal): Promise<number | undefined> {
	if (stop?.aborted) return Promise.resolve(undefined);

	return new Promise((resolve) => {
		const started = performance.now();

		let socket: WebSocket;
		try {
			socket = new WebSocket(`${relay.url.replace(/\/+$/, "")}/rtc`);
		} catch {
			resolve(undefined);
			return;
		}

		let settled = false;
		const finish = (took: number | undefined) => {
			if (settled) return;
			settled = true;

			clearTimeout(timer);
			stop?.removeEventListener("abort", abandon);
			// Closed in every outcome. A socket left open holds a connection on a
			// relay this client may not even use, once per relay per join.
			try {
				socket.close();
			} catch {
				// Already closing, which is one of the outcomes that gets here.
			}

			resolve(took);
		};

		const timer = setTimeout(() => finish(undefined), PROBE_TIMEOUT_MS);

		const abandon = () => finish(undefined);
		stop?.addEventListener("abort", abandon, { once: true });

		// Either of these is the relay answering. `open` means it accepted the
		// upgrade; `close` arrives when it refused the missing token, which it
		// can only do after the same round trip. `error` fires alongside a close
		// for a refusal, so the timing is taken from whichever lands first.
		socket.onopen = () => finish(performance.now() - started);
		socket.onclose = () => finish(performance.now() - started);
		socket.onerror = () => finish(performance.now() - started);
	});
}

/**
 * Measure every relay at once and name the fastest.
 *
 * In parallel rather than in turn, because in turn the wait is the sum of every
 * relay's latency and the slowest one is paid for even though it will not be
 * chosen. In parallel it is the slowest relay's rounds, each bounded by the
 * timeout above (see [ROUNDS]).
 *
 * Returns nothing when there is nothing to choose or nothing answered. The
 * caller joins without a preference, and the server falls back to keeping the
 * room together — which is a worse route but a working call, and that is the
 * right trade for a measurement that did not come back.
 */
export async function fastest(list: Relay[]): Promise<string | undefined> {
	// Never the ones kept for administrators, and never one out of service.
	//
	// Automatic is for somebody who did not choose, so choosing something they
	// will be refused at the door is worse than not choosing at all — the
	// measurement would land on a relay reserved for somebody else and the join
	// would come back Access denied, for a machine they never asked for.
	//
	// An administrator who wants one asks for it by name, which is honoured.
	const usable = list.filter((relay) => !relay.adminOnly && !relay.maintenance);

	if (usable.length < 2) return usable[0]?.name;

	list = usable;

	const now = Date.now();
	if (cached && now - cached.at < CACHE_MS && list.some((relay) => relay.name === cached?.name)) {
		return cached.name;
	}

	const took = await measure(list);

	let best: { name: string; took: number } | undefined;
	for (const [name, one] of took) {
		if (one === undefined) continue;
		if (!best || one < best.took) best = { name, took: one };
	}

	if (!best) return undefined;

	cached = { name: best.name, at: now };
	return best.name;
}

/**
 * Time every relay and say how long each took, or nothing where it did not
 * answer.
 *
 * The same measurement [fastest] makes, kept rather than reduced to a winner.
 * Somebody choosing a relay by hand is entitled to the numbers the automatic
 * choice is made from — without them the picker is a list of place names, and
 * the person reading it is being asked to guess at exactly the thing this
 * already knows.
 *
 * Uncached on purpose. This runs because somebody opened the picker, which is
 * usually because the automatic answer has just disappointed them; handing back
 * a reading from five minutes ago would be answering a question they did not
 * ask.
 */
export async function timings(list: Relay[]): Promise<Map<string, number | undefined>> {
	// A relay out of service is left out of the measurement rather than given a
	// reading: it is shown so somebody can see it is still there, and a
	// connection spent on a machine nobody may be sent to buys a number that
	// cannot be acted on. Left out of the choice of measurement, too — a
	// machine nobody is measuring should not decide how everybody else is.
	const measurable = list.filter((relay) => !relay.maintenance);
	const took = await measure(measurable);

	return new Map(list.map((relay) => [relay.name, took.get(relay.name)] as const));
}

/**
 * Work out which relay to ask for, doing nothing when the deployment does not
 * want a measurement.
 *
 * The whole of what a join needs from this module. Failure at any point here is
 * answered with an empty preference rather than an error, because none of this
 * is required for a call to happen: it decides which of several working relays
 * is used, and a deployment with one relay, or none, is unaffected.
 */
export async function preferred(): Promise<string> {
	try {
		const offered = await relays();
		if (!offered.measure) return "";

		return (await fastest(offered.relays)) ?? "";
	} catch {
		return "";
	}
}

/**
 * Forget the last measurement.
 *
 * Called when a call drops, which is the moment the held reading is worst: it
 * names as fastest the machine that has just stopped carrying a conversation.
 * Also by tests, which is all it was for when the drop path did not call it.
 */
export function forget(): void {
	cached = undefined;
}

/** One reading of one relay, or nothing where it did not answer in time. */
export type Probe = (relay: Relay, stop?: AbortSignal) => Promise<number | undefined>;

/**
 * What a relay's rounds come to: the median of those it answered, or nothing
 * where it answered fewer than [ENOUGH].
 *
 * The median of what answered rather than of all five with the misses counted
 * as slow, because a miss is not a long reading — it is no reading, and a relay
 * that answered four times in thirty milliseconds and once not at all is a
 * thirty-millisecond relay that dropped a packet. Of an even number, the mean
 * of the middle two, which is what a median of four is.
 */
export function reading(rounds: ReadonlyArray<number | undefined>): number | undefined {
	const answered = rounds.filter((one): one is number => one !== undefined).sort((a, b) => a - b);

	if (answered.length < ENOUGH) return undefined;

	const middle = answered.length >> 1;

	return answered.length % 2 === 1
		? answered[middle]
		: ((answered[middle - 1] as number) + (answered[middle] as number)) / 2;
}

/**
 * Time every relay in rounds, one probe, and give each relay its [reading].
 *
 * Side by side across relays and one after another within each, for the reasons
 * at [ROUNDS]; and a relay's rounds stop once it has missed more than it can
 * afford to. With `together`, the first relay to be counted as not answering
 * stops everybody's rounds as well — the readings are then going to be thrown
 * away for being incomplete (see [measure]), and every further round is a wait
 * for nothing in front of somebody pressing Join.
 */
export async function inRounds(
	list: Relay[],
	probe: Probe,
	together = false,
): Promise<Map<string, number | undefined>> {
	const stop = new AbortController();

	const readings = await Promise.all(
		list.map(async (relay) => {
			const rounds: Array<number | undefined> = [];
			let missed = 0;

			for (let round = 0; round < ROUNDS && !stop.signal.aborted; round++) {
				const took = await probe(relay, stop.signal);

				// A round called off is not a round the relay missed.
				if (stop.signal.aborted) break;

				rounds.push(took);

				if (took === undefined && ++missed > ROUNDS - ENOUGH) {
					if (together) stop.abort();
					break;
				}
			}

			return reading(rounds);
		}),
	);

	return new Map(list.map((relay, at) => [relay.name, readings[at]] as const));
}

/**
 * Time a relay, over UDP where it will let us and over the socket otherwise.
 *
 * The UDP answer is one round trip and the TCP one is about three, so they are
 * not the same number and must not be mixed in one ranking — a relay that
 * answers STUN would beat a nearer one that does not, on nothing but the
 * measurement it happened to allow. Which is why this is chosen per list rather
 * than per relay: [timings] and [fastest] both ask for one kind and use it for
 * everybody, falling back only where no relay offers the better one.
 *
 * Every relay in rounds, whichever kind, and what is compared is each relay's
 * median (see [inRounds]).
 */
async function measure(list: Relay[]): Promise<Map<string, number | undefined>> {
	// Only where every one of them offers it, so what comes back is a set of
	// readings rather than a mixture.
	//
	// This used to be decided one relay at a time, immediately under the
	// paragraph above explaining why it must not be: whichever relays had a
	// probe port got a one-round-trip number and the rest got a three, and the
	// ranking went to whoever had been configured rather than to whoever was
	// near. On a fleet where the enrolment script never writes a probe port —
	// which is this one — that is most of the machines losing to a few.
	if (list.length > 0 && list.every((relay) => relay.probe)) {
		const took = await inRounds(list, overUDP, true);

		if ([...took.values()].every((one) => one !== undefined)) return took;

		// One of them did not answer enough of its rounds, and keeping the rest
		// would compare the ones that answered quickly against nothing. A relay
		// that advertises a probe port which does not work is worth finding out
		// about, and the way to find out is that everybody is measured the
		// slower way and the numbers are all still comparable.
	}

	return inRounds(list, overSignalling);
}
