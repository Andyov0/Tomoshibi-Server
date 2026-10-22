/**
 * How the call is actually going, measured rather than assumed.
 *
 * Somebody whose picture is breaking up wants to know one thing before anything
 * else: is it me, or is it them. Nothing on the screen answered that. The
 * meeting either looked fine or looked bad, and every explanation for looking
 * bad — a slow room, a far relay, a laptop out of headroom, somebody else's
 * upload — produced the same picture.
 *
 * So this reads the connection this browser actually has. Three numbers carry
 * most of the answer and they say different things:
 *
 *   Round trip is distance. It barely moves with load and it cannot be fixed by
 *   sending less, which is what makes it the number that says "you are on the
 *   wrong relay" rather than "your network is busy".
 *
 *   Loss is the network refusing to carry what was sent. It is what breaks a
 *   voice, and it is the one that gets worse the harder you push.
 *
 *   Rate is what is being pushed. On its own it says almost nothing; beside the
 *   other two it separates a quiet call from a starved one.
 *
 * The media server publishes a verdict of its own, and it is used as a floor
 * rather than as the answer. It sees this participant from the far side and
 * knows things this browser cannot — but it grades on its own scale, and the
 * numbers below are what somebody can act on.
 */

import { ConnectionQuality, type Room, RoomEvent, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

/** How good the connection is, in the three states a light can be. */
export type Grade = "good" | "fair" | "poor" | "lost";

export interface Reading {
	grade: Grade;
	/** Round trip to the relay, in milliseconds. */
	rttMs?: number;
	/** Of what this browser sent, the share the far end never received. */
	lossPercent?: number;
	/** What is being sent and received, in kilobits per second. */
	upKbps?: number;
	downKbps?: number;
	/** How unevenly packets are arriving, in milliseconds. */
	jitterMs?: number;
	/**
	 * What the screen share is actually managing, where one is running.
	 *
	 * Asked for because the settings are a request and not a promise: somebody
	 * chose 4K at sixty and the encoder may be sending 4K at nineteen, and
	 * nothing else on the screen would say so. The number that matters is what
	 * is leaving this machine, not what was asked for.
	 *
	 * Absent when nothing is being shared, so the row is not a permanent dash.
	 */
	share?: {
		width?: number;
		height?: number;
		fps?: number;
		sending: boolean;
		limited?: "cpu" | "bandwidth" | "other";
	};
	/**
	 * This browser's own address, as the relay sees it.
	 *
	 * Their own and nobody else's. It is the useful half of what a candidate
	 * pair holds: somebody trying to work out why a call is bad wants to know
	 * which network they are actually leaving from — a phone that fell back to
	 * mobile data, a laptop that picked the guest wifi — and that is a question
	 * about them.
	 *
	 * The other half, the relay's address, is deliberately not shown. It is not
	 * a secret from anybody in the call, but putting it on screen makes it one
	 * more thing to read off somebody's window, and the machine's name says
	 * everything a person in a call needs.
	 */
	ownAddress?: string;
	/**
	 * What the machine holding this call calls itself.
	 *
	 * Reported by the node that answered the join, which is the node the room
	 * lives on rather than necessarily the one this browser dialled. Empty on a
	 * relay that has not been given a name to report.
	 */
	holding?: string;
	/** Whether anything has been measured yet. */
	measured: boolean;
}

/**
 * How often to look.
 *
 * Two seconds. Every reading walks the whole stats report for every published
 * track, which is not free, and a number that moves faster than somebody can
 * read it is a number nobody reads. Rates are means across the gap for the same
 * reason: an instantaneous bitrate on a screen is a flicker.
 */
const EVERY_MS = 2000;

/*
 * How many samples with nothing to say about the reason keep the last one.
 *
 * Two, which is four seconds: long enough to ride out a report taken while the
 * encoder is reconfiguring, short enough that a browser which has genuinely
 * stopped reporting does not go on being quoted for the rest of the call.
 */
const MISSING_FOR = 2;

/**
 * Where the bands are.
 *
 * Round trip first, because it is the one somebody can do something about — a
 * relay on the wrong continent shows up here and nowhere else. A hundred and
 * fifty milliseconds is about where a conversation starts to feel like people
 * talking over each other; four hundred is where they give up and take turns.
 *
 * Loss matters at lower numbers than people expect. Two per cent is audible on
 * a voice; eight per cent is a call somebody is going to leave.
 */
const GOOD_RTT_MS = 150;
const FAIR_RTT_MS = 400;
const GOOD_LOSS = 2;
const FAIR_LOSS = 8;

/** What was true last time, so that rates and loss can be a change rather than a total. */
interface Previous {
	at: number;
	bytesSent: number;
	bytesReceived: number;
	packetsSent: number;
	packetsLost: number;
}

/**
 * Watch the connection this room is running on.
 *
 * Returns a reading that updates on its own. Safe to call with no room: before
 * one is connected there is nothing to measure and the reading says so, rather
 * than reporting a healthy zero — which is how a disconnected call comes to
 * show three green bars.
 */
export function useConnectionQuality(room: Room | undefined): Reading {
	const [reading, setReading] = useState<Reading>({ grade: "good", measured: false });
	const previous = useRef<Previous>();
	// The last numbers a share reported, so a sample that lacks them does not
	// empty the row.
	const held = useRef<{
		id?: string;
		width?: number;
		height?: number;
		fps?: number;
		sending: boolean;
		limited?: "cpu" | "bandwidth" | "other" | "none";
		/* How many samples in a row have had nothing to say about the reason. */
		missing: number;
	}>();

	// The server's own verdict, kept apart from the numbers because it arrives
	// on an event rather than on the clock.
	const published = useRef<ConnectionQuality>(ConnectionQuality.Excellent);

	useEffect(() => {
		// Whatever the last room said is not about this one. This used to be
		// cleared only on leaving, so a call joined straight from another kept
		// the other's warning until its own first sample said otherwise.
		previous.current = undefined;
		held.current = undefined;

		if (!room) {
			setReading({ grade: "good", measured: false });
			return;
		}

		let live = true;

		const onQuality = (quality: ConnectionQuality, participant?: { isLocal?: boolean }) => {
			// Only this browser's own. Somebody else's bad connection is their
			// news, and putting it in this reading would tell the wrong person
			// to go and find a better network.
			if (participant && participant.isLocal === false) return;
			published.current = quality;
		};

		room.on(RoomEvent.ConnectionQualityChanged, onQuality as never);

		const look = async () => {
			const now = Date.now();
			const stats = await gather(room);

			// Asked of the relay itself where the candidates could not say;
			// see addressSeenBy. Once per relay, so every pass after the first
			// is answered from what the first one learned.
			const address = stats.ownAddress ?? (stats.askAt ? await addressSeenBy(stats.askAt) : undefined);

			if (!live) return;

			const was = previous.current;
			previous.current = { at: now, ...stats.totals };

			// The first pass has nothing to compare against, so it establishes
			// the baseline and says only what it can say without one.
			const seconds = was ? (now - was.at) / 1000 : 0;

			const upKbps =
				was && seconds > 0
					? Math.max(0, ((stats.totals.bytesSent - was.bytesSent) * 8) / seconds / 1000)
					: undefined;

			const downKbps =
				was && seconds > 0
					? Math.max(0, ((stats.totals.bytesReceived - was.bytesReceived) * 8) / seconds / 1000)
					: undefined;

			// Loss over the interval rather than since the call began. A call
			// that lost badly for ten seconds an hour ago is fine now, and a
			// lifetime average would go on reporting the ten seconds all evening.
			let lossPercent: number | undefined;
			if (was) {
				const sent = stats.totals.packetsSent - was.packetsSent;
				const lost = stats.totals.packetsLost - was.packetsLost;

				if (sent > 0) lossPercent = Math.max(0, Math.min(100, (lost / (sent + lost)) * 100));
			}

			const server = (room as { serverInfo?: { region?: string } }).serverInfo;

			// Carried forward. The size and rate blink out of the report from time
			// to time — a sample taken while the encoder was reconfiguring — and
			// a row that empties and refills is read as a fault rather than as a
			// gap in the measurement.
			// The same track as last time, in the same direction. Nothing is
			// carried across a change of either: a new share starts with a clean
			// row, and a share being watched does not inherit what this
			// machine's encoder said about the one it was sending.
			const same =
				stats.share !== undefined &&
				held.current !== undefined &&
				held.current.id === stats.share.id &&
				held.current.sending === stats.share.sending;

			// The reason, in three states. Said: taken as said, including
			// "none", which clears it. Not said: the last answer is kept for a
			// couple of samples, because a report taken while the encoder is
			// reconfiguring has no answer and a warning that blinks is read as a
			// fault. Not said for longer than that: it is gone, because a
			// browser that has stopped reporting is not still reporting "cpu".
			let limited = stats.share?.limited;
			let missing = 0;

			if (stats.share && limited === undefined && same) {
				missing = (held.current?.missing ?? 0) + 1;
				limited = missing <= MISSING_FOR ? held.current?.limited : undefined;
			}

			const share = stats.share
				? {
						id: stats.share.id,
						sending: stats.share.sending,
						fps: stats.share.fps ?? (same ? held.current?.fps : undefined),
						width: stats.share.width ?? (same ? held.current?.width : undefined),
						height: stats.share.height ?? (same ? held.current?.height : undefined),
						limited,
						missing,
					}
				: undefined;

			held.current = share;

			setReading({
				grade: grade(published.current, stats.rttMs, lossPercent),
				holding: server?.region || undefined,
				rttMs: stats.rttMs,
				jitterMs: stats.jitterMs,
				// "none" is a fact for the merge above and nothing for the screen:
				// a share that is not held back has no reason to show.
				share: share && {
					sending: share.sending,
					fps: share.fps,
					width: share.width,
					height: share.height,
					limited: share.limited === "none" ? undefined : share.limited,
				},
				ownAddress: address,
				lossPercent,
				upKbps,
				downKbps,
				measured: was !== undefined,
			});
		};

		void look();
		const timer = setInterval(() => void look(), EVERY_MS);

		return () => {
			live = false;
			clearInterval(timer);
			room.off(RoomEvent.ConnectionQualityChanged, onQuality as never);
		};
	}, [room]);

	return reading;
}

/** What the bands come out as, with the server's verdict as a floor. */
export function grade(
	published: ConnectionQuality,
	rttMs: number | undefined,
	lossPercent: number | undefined,
): Grade {
	if (published === ConnectionQuality.Lost) return "lost";

	let own: Grade = "good";

	if (rttMs !== undefined) {
		if (rttMs > FAIR_RTT_MS) own = "poor";
		else if (rttMs > GOOD_RTT_MS) own = "fair";
	}

	if (lossPercent !== undefined) {
		if (lossPercent > FAIR_LOSS) own = "poor";
		else if (lossPercent > GOOD_LOSS && own === "good") own = "fair";
	}

	// The server sees this participant from the other side and knows things this
	// browser cannot. Where it is less happy than the numbers here, believe it:
	// a reading that says everything is fine while the call is visibly not is
	// worse than no reading, because it sends somebody looking in the wrong
	// place.
	if (published === ConnectionQuality.Poor && own === "good") return "fair";

	return own;
}

interface Gathered {
	rttMs?: number;
	jitterMs?: number;
	ownAddress?: string;
	/** The relay to ask for this browser's address, where nothing here said. */
	askAt?: string;
	share?: {
		width?: number;
		height?: number;
		fps?: number;
		sending: boolean;
		/*
		 * Three states, not two. "none" is the browser saying the limitation
		 * has gone, and it is kept apart from a sample that had nothing to say
		 * — the two used to collapse into one `undefined` on the way in, and a
		 * warning that had been cleared went on being carried forward as if it
		 * were a gap in the measurement.
		 */
		limited?: "cpu" | "bandwidth" | "other" | "none";
		/* Which track this is, so nothing is carried from one to the next. */
		id?: string;
	};
	totals: {
		bytesSent: number;
		bytesReceived: number;
		packetsSent: number;
		packetsLost: number;
	};
}

/**
 * Read every published and subscribed track's stats and add them up.
 *
 * Per track rather than per connection because that is what the SDK exposes;
 * the reports overlap, so the transport-level figures are taken once and the
 * per-stream ones are summed.
 */
async function gather(room: Room): Promise<Gathered> {
	const out: Gathered = {
		totals: { bytesSent: 0, bytesReceived: 0, packetsSent: 0, packetsLost: 0 },
	};

	const reports: RTCStatsReport[] = [];

	for (const publication of room.localParticipant.trackPublications.values()) {
		const report = await publication.track?.getRTCStatsReport?.();
		if (!report) continue;

		reports.push(report);

		// The share is read from its own publication rather than from the pooled
		// numbers below, because those are summed across every track and a frame
		// rate is not a thing that can be added up. A camera at thirty beside a
		// share at fifteen would otherwise read as forty-five.
		if (publication.source === Track.Source.ScreenShare) {
			readShare(report, "outbound-rtp", true, out);
		}
	}

	for (const participant of room.remoteParticipants.values()) {
		for (const publication of participant.trackPublications.values()) {
			const report = await publication.track?.getRTCStatsReport?.();
			if (!report) continue;

			reports.push(report);

			// Somebody else's share, read the same way and reported the same
			// way. The person watching has the same question as the person
			// sharing — is this as smooth as it should be — and until now only
			// the sharer could answer it. Which is the wrong way round: the
			// watcher is the one seeing it go wrong.
			//
			// Not overwritten if this browser is sending one. Somebody sharing
			// their own screen is asking about their own encoder.
			if (publication.source === Track.Source.ScreenShare && !out.share?.sending) {
				readShare(report, "inbound-rtp", false, out);
			}
		}
	}

	// Counted once each, because a track's report describes its whole peer
	// connection: two tracks on one connection would otherwise double every
	// byte, and the bitrate would read as twice what is being sent.
	const seen = new Set<string>();

	// Collected as they are met and resolved afterwards, because the pair that
	// names a candidate and the candidate itself arrive in whichever order the
	// report happens to hold them.
	const locals = new Map<string, Candidate>();
	let nominated: string | undefined;

	for (const report of reports) {
		report.forEach((entry: Record<string, unknown> & { type?: string; id?: string }) => {
			const id = String(entry.id ?? "");
			if (id && seen.has(id)) return;
			if (id) seen.add(id);

			switch (entry.type) {
				case "local-candidate": {
					// Kept by id so the pair below can name the one in use. Every
					// candidate ever considered appears here and most of them
					// lost, so which one won cannot be read from this alone.
					if (typeof entry.id === "string" && typeof entry.address === "string") {
						locals.set(entry.id, {
							address: entry.address,
							kind: typeof entry.candidateType === "string" ? entry.candidateType : "",
							related: typeof entry.relatedAddress === "string" ? entry.relatedAddress : undefined,
							url: typeof entry.url === "string" ? entry.url : undefined,
							relayed:
								entry.candidateType === "relay" ||
								typeof entry.relayProtocol === "string" ||
								(typeof entry.url === "string" && entry.url.startsWith("turn")),
						});
					}

					return;
				}

				case "candidate-pair": {
					// The one in use. A connection collects several and reports
					// them all, and the ones that lost the race have stale or
					// absent timings.
					if (entry.state !== "succeeded" || entry.nominated !== true) return;

					const rtt = numeric(entry.currentRoundTripTime);
					if (rtt !== undefined) out.rttMs = Math.round(rtt * 1000);

					if (typeof entry.localCandidateId === "string") {
						nominated = entry.localCandidateId;
					}

					return;
				}

				case "outbound-rtp": {
					out.totals.bytesSent += numeric(entry.bytesSent) ?? 0;
					out.totals.packetsSent += numeric(entry.packetsSent) ?? 0;
					return;
				}

				case "remote-inbound-rtp": {
					// What the far end says it did not get. The near side cannot
					// know this — a packet that never arrived leaves no trace
					// here — which is why loss is read from the report that came
					// back rather than from the one written locally.
					out.totals.packetsLost += Math.max(0, numeric(entry.packetsLost) ?? 0);

					const jitter = numeric(entry.jitter);
					if (jitter !== undefined) out.jitterMs = Math.round(jitter * 1000);

					// Some browsers report a round trip here and nowhere else.
					if (out.rttMs === undefined) {
						const rtt = numeric(entry.roundTripTime);
						if (rtt !== undefined) out.rttMs = Math.round(rtt * 1000);
					}

					return;
				}

				case "inbound-rtp": {
					out.totals.bytesReceived += numeric(entry.bytesReceived) ?? 0;
					return;
				}
			}
		});
	}

	if (nominated) {
		out.ownAddress = ownAddress(locals, nominated);
		if (!out.ownAddress) out.askAt = relayToAsk(locals.get(nominated));
	}

	return out;
}

/** A local candidate, as much of it as the address on the panel needs. */
export interface Candidate {
	address: string;
	kind: string;
	/** The address this one was derived from, where the browser says. */
	related?: string;
	/** Whether it reaches the far end through a TURN relay. */
	relayed: boolean;
	/** The server it was gathered from, as the browser was given it. */
	url?: string;
}

/**
 * This browser's own public address, from the candidate in use, or nothing.
 *
 * Reflexive candidates -- server- or peer- -- are the address the far end sees,
 * and on a direct path the far end is the machine holding the call, so that is
 * this browser's address. A host candidate is the private address of whatever
 * network card won, and telling somebody they are 192.168.1.24 answers no
 * question they had.
 *
 * Through a relay it is neither. The candidate in use is then the relay's own
 * address, or a peer-reflexive one learned at the far end of the relay's path,
 * which is wherever that path comes out: for a mainland relay forwarding to a
 * machine abroad, the exchange the relays cross the border through. That was
 * shown as somebody's own address, and read, correctly, as a stranger's. What
 * the relay itself sees is the related address of its relay candidate -- the
 * address the allocation was made from -- and that is this browser's.
 *
 * The browser does not always say. A call forwarded through a relay is told to
 * use relays only, and in that mode the browser withholds every related
 * address -- the point of relay-only is that the far end learns nothing else --
 * so the relay is asked directly instead; see addressSeenBy. Until it answers,
 * and if it never does, nothing is shown: an empty row is better than somebody
 * else's address under the words "your address".
 */
export function ownAddress(locals: Map<string, Candidate>, nominated: string): string | undefined {
	const local = locals.get(nominated);
	if (!local || local.kind === "host") return undefined;
	if (!local.relayed) return local.address;

	// A peer-reflexive candidate on a relayed path is derived from the relay
	// candidate it went out through, and names it as its related address.
	const allocation =
		local.kind === "relay" ? local : [...locals.values()].find((one) => one.kind === "relay" && one.address === local.related);

	return seen(allocation?.related);
}

/** An address the browser actually disclosed, rather than its placeholder. */
function seen(address: string | undefined): string | undefined {
	if (!address || address === "0.0.0.0" || address === "::") return undefined;
	return address;
}

/**
 * Read a screen share's size and frame rate out of one track's report.
 *
 * The same two numbers whichever direction it is going, from a different entry:
 * what an encoder produced, or what a decoder received. Read per publication
 * rather than from the pooled figures below, because a frame rate is not a thing
 * that can be added up — a camera at thirty beside a share at fifteen would
 * otherwise read as forty-five.
 */
function readShare(
	report: RTCStatsReport,
	kind: "outbound-rtp" | "inbound-rtp",
	sending: boolean,
	out: Gathered,
): void {
	/*
	 * The biggest one, because there is more than one now.
	 *
	 * A share is published as a ladder, so a sender's report holds an
	 * `outbound-rtp` per rung — 360, 720 and the chosen size. This loop used to
	 * assign `out.share` on every match, so whichever rung the report happened
	 * to yield last became the reading, and `RTCStatsReport` promises no order:
	 * somebody sharing at 1440p was shown "360p" because the bottom rung came
	 * last that time. It was right for as long as a share was a single encode
	 * and became wrong the moment it stopped being one.
	 *
	 * Largest by area rather than first or last, and it is the honest answer in
	 * both directions: it is the picture the person chose, and it is the one a
	 * viewer able to take it receives. A rung dynacast has paused never gets a
	 * frame, so it never has dimensions, so it cannot win.
	 */
	let best: (Record<string, unknown> & { type?: string }) | undefined;
	let widest = -1;

	report.forEach((entry: Record<string, unknown> & { type?: string }) => {
		if (entry.type !== kind) return;

		const area = (numeric(entry.frameWidth) ?? 0) * (numeric(entry.frameHeight) ?? 0);

		// Ties keep the first, so an entry with no size yet cannot displace one
		// that has arrived.
		if (area > widest) {
			widest = area;
			best = entry;
		} else if (!best) {
			best = entry;
		}
	});

	{
		const entry = best;
		if (!entry) return;

		// Taken one field at a time, and the row exists as soon as the track
		// does.
		//
		// Requiring all three together is why the line used to come and go while
		// a share was running: `framesPerSecond` is a rate and is simply absent
		// until two samples have been taken, and the frame size is absent until
		// the encoder has produced one. Both fill in within a second or two, and
		// insisting on them meant a share that was plainly on screen had no line
		// at all — which reads as the reading being broken rather than as it
		// still arriving.
		out.share = {
			sending,
			fps: numeric(entry.framesPerSecond),
			width: numeric(entry.frameWidth),
			height: numeric(entry.frameHeight),
			// Why the encoder is not doing what it was asked, straight from the
			// encoder. Only the sending side has it — the receiving side is being
			// told what somebody else's machine decided — and it is the one
			// figure that turns "it keeps stuttering" into something anybody can
			// act on: a shortfall in the network and a shortfall in the machine
			// look identical on screen and want opposite answers.
			limited: sending ? limitation(entry.qualityLimitationReason) : undefined,
			id: String(entry.ssrc ?? entry.trackIdentifier ?? entry.id ?? ""),
		};
	}
}

/**
 * Why the encoder is holding back, where it is holding back for a reason.
 *
 * "none" is the ordinary state and is dropped rather than reported: a line that
 * says nothing is wrong is a line somebody reads every time to learn nothing.
 * "other" is kept, because it is the browser saying it knows and will not say —
 * which is worth seeing precisely once, when everything else looks fine.
 */
function limitation(value: unknown): "cpu" | "bandwidth" | "other" | "none" | undefined {
	switch (value) {
		case "cpu":
		case "bandwidth":
		case "other":
		case "none":
			return value;
		default:
			return undefined;
	}
}

/** A stats field, where it is a number and not something else. */
function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The STUN address of the relay a relayed candidate went through, or nothing.
 *
 * Only a plain TURN server over UDP or TCP: a relay answers STUN on the port it
 * answers TURN on, and over UDP, whichever transport the allocation used. One
 * reached over TLS is left alone, because STUN to it in the clear would go
 * somewhere the browser was told not to send anything in the clear.
 */
export function relayToAsk(candidate: Candidate | undefined): string | undefined {
	if (!candidate?.relayed || !candidate.url) return undefined;

	const match = /^turn:([^?]+)/.exec(candidate.url);
	return match ? `stun:${match[1]}` : undefined;
}

const askedOf = new Map<string, Promise<string | undefined>>();

/** How long a relay is given to answer before the row stays empty. */
export const ASK_FOR = 5000;

/**
 * This browser's public address as the given STUN server sees it.
 *
 * For a call that goes through a relay, where the candidates will not say. A
 * connection of its own, with no peer, gathers one server-reflexive candidate
 * from the relay -- the same relay, over the same kind of path, as the call --
 * and that candidate's address is what the relay sees. It is then closed. The
 * answer is kept for as long as the page is open, failure included, so a relay
 * that will not answer is asked once rather than on every reading.
 */
export function addressSeenBy(stun: string): Promise<string | undefined> {
	const known = askedOf.get(stun);
	if (known) return known;

	const asking = new Promise<string | undefined>((resolve) => {
		let pc: RTCPeerConnection;
		try {
			pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
		} catch {
			resolve(undefined);
			return;
		}

		const done = (address?: string) => {
			clearTimeout(timer);
			pc.onicecandidate = null;
			pc.close();
			resolve(address);
		};
		const timer = setTimeout(() => done(undefined), ASK_FOR);

		pc.onicecandidate = (event) => {
			const candidate = event.candidate;
			if (!candidate) return done(undefined);
			if (candidate.type === "srflx" && candidate.address) done(candidate.address);
		};

		// Something to negotiate, or nothing is gathered.
		pc.createDataChannel("address");
		pc.createOffer()
			.then((offer) => pc.setLocalDescription(offer))
			.catch(() => done(undefined));
	});

	askedOf.set(stun, asking);
	return asking;
}
