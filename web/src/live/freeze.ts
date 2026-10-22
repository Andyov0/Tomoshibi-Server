/**
 * A shared screen that has stopped moving for one viewer, asked for a rung
 * lower until it moves again.
 *
 * ## The fault
 *
 * The server chooses which rung of a share each viewer is sent, from its own
 * estimate of that viewer's line, and it can get stuck. Measured locally with
 * the relays' settings as they are after 2026-10-13 (the server estimating from
 * the sender's side): it judged a viewer's line congested three seconds into a
 * share, while the original was still climbing and cheap, and then let the
 * original grow to 48 Mb/s on a 30 Mb/s line without choosing again — its
 * allocator only reconsiders when its congestion state changes, and the state
 * had already changed. The viewer received 20 Mb/s for a minute, asked for a
 * keyframe a hundred times, and decoded none of it. Two of nine runs did this;
 * in the other, two sessions sharing a hotel-like line (20 Mb/s, 3% lost)
 * between them, neither decoded a frame in the minute measured.
 *
 * Nothing in the browser says so. The picture simply stops, the sound goes on,
 * and the person watching cannot tell a share that is frozen from one that is
 * still.
 *
 * ## What this does about it
 *
 * Reads this viewer's receiver every second, and when the share keeps arriving
 * but nothing new is decoded for two seconds — or a tenth of what was sent is
 * lost while the browser counts the picture freezing — asks for the next rung
 * down, for twenty seconds, and then asks for the original again. A second
 * freeze inside those twenty seconds steps down again, and a freeze soon after
 * asking for the original again makes the next wait longer; see "Asking for the
 * original again". The owner chose this on 2026-10-13 knowing it is an
 * automatic step down, and chose it because it is one viewer's, not anybody
 * else's:
 *
 *   - It never touches what the person sharing sends. The rule of 2026-09-07 —
 *     never lower the sharer's bitrate automatically — is about their encoder,
 *     and nothing here can reach it: only remote publications are read, and the
 *     only thing written is what this browser asks to receive.
 *   - It never touches what anybody else is sent. The request is this viewer's
 *     own subscription; the server answers it for this viewer alone.
 *
 * ## How it asks, and why not the way sharpness.ts did
 *
 * live/sharpness.ts raised a share's request by observing one more "element"
 * that claimed to be the size of the source, which worked because the SDK takes
 * the *largest* of what it observes (updateDimensions). That can only ever raise
 * a request; an extra element smaller than the real one is outvoted by it. What
 * lowers one is the publication's own requested dimensions: the SDK sends the
 * smaller of those and of what adaptive streaming measured
 * (RemoteTrackPublication.emitTrackUpdate, livekit-client.esm.mjs:31104-31112).
 * So the cap is `setVideoDimensions` with the lower rung's size, and lifting it
 * is the same call with a size no picture covers, after which the measurement
 * alone decides again.
 *
 * And only while the publication has a track. `setVideoDimensions` records the
 * size only `if (isRemoteVideoTrack(this.track))` (esm.mjs:30999) — and sends
 * the update anyway, so nothing says it was dropped. A share brought back to
 * the stage is wanted again the moment its picture mounts and receives its
 * track a round trip or two later; a lift told in between was dropped, recorded
 * here as told, and never told again, so the viewer stayed on the lower rung,
 * full screen included, until the share ended (found in review, 2026-10-14,
 * with a real RemoteTrackPublication — the fakes here took any call).
 *
 * Not `setVideoQuality`. It forgets the dimensions as it should, but it then
 * asks for its quality *by name* whenever the publication has no layer of that
 * name — and a share published with one rung beneath it has no HIGH — so every
 * viewer would ask for the original however small their picture, which is the
 * fault the measurement exists to fix.
 *
 * ## What it must not take for a freeze
 *
 *   - A still screen. It sends almost nothing, and what it sends decodes.
 *   - A share nobody here is looking at. The server pauses it; nothing arrives.
 *   - A share coming back from a pause, or switching rungs. Frames resume at the
 *     next keyframe, and bytes arrive meanwhile — so a stall is counted only
 *     across readings in which bytes kept arriving, and starts again whenever
 *     they did not, and nothing is judged for a few seconds after this file has
 *     itself changed what is asked for.
 *   - A tab in the background. Its timers run late and the SDK pauses its video
 *     anyway; readings there are not evidence of anything.
 *   - A line that loses packets and gets them back. See LOSSY.
 *
 * ## Which rung it steps down from
 *
 * The lower of two: the cap this file already asked for, and the rung this
 * viewer's picture asks for — adaptive streaming's measurement of it, which the
 * publication keeps (`videoDimensionsAdaptiveStream`, protected, read here and
 * by nothing else), put through the server's own rule for turning a size into
 * a rung (the smallest at least nine tenths as tall, mediatrackreceiver.go:1117).
 * The SDK sends the server the smaller of that and the cap, so the lower of the
 * two rungs is the one asked for. Where neither is known, the original: a
 * version of the SDK that renamed the field would cost a wasted step, below,
 * and not a wrong one, and the room tests here measure through the SDK's own
 * handler so that they would say so.
 *
 * Not the height of the frames arriving, which is what this read first, and
 * which says nothing reliable once the person sharing has changed their size.
 * The rungs are the sizes the share was *published* at; a share published at
 * 1440p and then set to 1080p from the menu, or by the hint in live/strain.ts,
 * sends its top at 1080 lines and its 1080p rung at 1080 lines too (retune
 * scales every rung against the capture as it is now). Read by its frames, a
 * viewer frozen on that top looked as though they were on the 1080p rung and
 * was stepped to the 720p rung — past the very rung built for them
 * (found in review, 2026-10-14). What is asked for has no such ambiguity: the
 * server answers a request in the published sizes, so a request is already in
 * the units a cap is.
 *
 * What that gives up: a viewer the server moved down on its own, from its
 * estimate, is not known to be lower than they asked for, and their first step
 * may ask for what they already receive. It costs one wait — SETTLE_MS and a
 * second stall — before the next step, which then finds the right rung.
 *
 * ## Asking for the original again
 *
 * Twenty seconds the first time, and then twice as long each time the original
 * freezes again inside two minutes of being asked for — forty, eighty, 160 —
 * up to five minutes; two minutes on the original without a freeze, and the
 * next wait is twenty again.
 *
 * It was twenty every time, and that was a freeze of its own making, measured
 * in the acceptance runs of 2026-10-14 (the person sharing 120 ms away losing
 * 0.2%, one viewer). With nobody else watching at full size, the step down
 * leaves the original with no subscriber, and dynacast stops the sharer's
 * encoder sending it. Asking for it again starts that layer from nothing: two
 * to three seconds of no frames at all while it restarts and climbs. Then, on
 * that line, the original froze again 18 to 47 seconds later in each of the
 * four runs that asked for it again, the step down followed, and twenty seconds after it the same again — a restart
 * and a freeze every forty seconds to a minute for as long as the share
 * lasted, the restart put there by nothing but the asking. Asking less often
 * cannot make the line better; it makes the asking cost less, on a line that
 * has already said it cannot carry the original. Measured on the same line
 * with the back-off, for five and a half minutes: the original froze again
 * 11, 22 and 36 seconds after each return, the waits between came out at 20,
 * 41 and 80, and the viewer was frozen 11.2 seconds in all.
 *
 * Doubling rather than a longer fixed wait, because one freeze is not a line:
 * a viewer whose trouble was a moment — a download on the same line that
 * finished — is back on the original after twenty seconds, as before. Five minutes as
 * the most, so that a line that recovers is found within a few minutes of
 * recovering, at the price of one restart per five minutes on a line that
 * never does. Two minutes as both measures, a freeze inside them failing and a
 * stretch without one forgiving, so that there is no third state between the
 * two to reason about.
 *
 * The two minutes are counted from the moment the original was asked for,
 * whether or not anybody was looking. A share that spent them on its card
 * comes back forgiven, and if the line is still bad that costs one wait of
 * twenty seconds to find out. What a card does not do is forget a failure
 * inside them: going to the card and back throws the readings away, never the
 * back-off. A new stream — a new share, or a full reconnection — starts at
 * twenty, because nothing about it has been tried yet.
 *
 * ## Which publication it speaks to
 *
 * The one in the room now. A full reconnection replaces every remote
 * participant and every publication with new objects under the same track
 * sids, often inside one tick; a watch keyed on the sid alone went on reading
 * the new receiver and capping the old, dead publication, so the fallback was
 * gone for the rest of the share for exactly the viewer whose line had just
 * failed (found in review, 2026-10-14). A publication that is not the one
 * remembered is a new stream, and starts from nothing.
 */

import { type RemoteTrackPublication, RemoteVideoTrack, type Room, RoomEvent, Track } from "livekit-client";

/** How often the receiver is read. */
export const EVERY_MS = 1000;

/** How long frames have to stand still while bytes arrive before it is a freeze. */
export const STALL_MS = 2000;

/**
 * How long the lower rung is asked for before the original is asked for again,
 * the first time. See "Asking for the original again" in the header.
 */
export const HOLD_MS = 20_000;

/** The most it is ever asked for at a time, however often the original has failed. */
export const LONGEST_HOLD_MS = 300_000;

/**
 * How long after the original is asked for again that a freeze still says the
 * original could not be carried — and how long without one before the waits
 * start again from HOLD_MS.
 */
export const TRIED_MS = 120_000;

/**
 * How long after this file changes what is asked for before anything is judged
 * again: the server switches rungs at the next keyframe of the one asked for,
 * and until then the picture may stand still for reasons this caused.
 */
export const SETTLE_MS = 3000;

/**
 * The share of packets lost, over STALL_MS, that counts as a freeze — while the
 * browser also counts the picture freezing in the same window.
 *
 * Not on its own, which is how it was first written, because the browser's
 * `packetsLost` is not what the picture lost. Chrome counts a packet lost when
 * it is missing and keeps counting it after a retransmission has brought it
 * back. Measured on the acceptance runs of 2026-10-13 (a shaper dropping 3% at
 * random, ten milliseconds away): this ratio read 2.2 to 3.7 per cent in every
 * window while the picture froze for 0 to 0.32 seconds in a minute — nearly all
 * of it recovered. A short line losing twelve per cent and recovering all of it,
 * which a crowded 2.4 GHz Wi-Fi does, would have been stepped down, held, let
 * up, and stepped down again, spending most of its time on the 720p rung,
 * with a keyframe at every switch to make real freezes on a line that had
 * none.
 *
 * Not `retransmittedPacketsReceived` subtracted from it either, though that
 * reads like the answer. With the server estimating from the sender's side,
 * its probes for more room are earlier packets sent again on the
 * retransmission stream (livekit-server downtrack.go WriteProbePackets, the
 * branch the stream allocator takes) and the browser counts every one as a
 * retransmission. Subtracted, they would hide real loss exactly while the
 * server is probing, which is while it is deciding.
 *
 * So the evidence of harm is the browser's own: `freezeCount`, which it raises
 * when a frame comes far later than the ones before it. A browser that does
 * not report it is judged on the stall alone.
 */
export const LOSSY = 0.1;

/**
 * Bytes a reading has to bring for the share to count as still arriving.
 *
 * Small, because the point is only to tell a stream that is coming in from one
 * that is not: a paused or still share brings nothing at all, and a frozen one
 * brings megabits. Padding the server sends to probe the line is not counted in
 * `bytesReceived`, so it cannot pass for a picture.
 */
const ARRIVING = 4000;

/** Packets a loss figure has to be taken over before it means anything. */
const COUNTED = 100;

/**
 * What is sent to lift the cap: larger than any picture covers, so that the
 * smaller of it and the measurement is always the measurement.
 */
export const UNCAPPED = { width: 16384, height: 16384 } as const;

/** A rung of a share, as its publication describes it. */
export interface Rung {
	width: number;
	height: number;
}

/** One reading of this viewer's receiver, reduced to what the rule needs. */
export interface Reading {
	at: number;
	/** Payload bytes received so far. */
	bytes?: number;
	/** Frames decoded so far. */
	frames?: number;
	/** Packets received so far. */
	received?: number;
	/** Packets lost so far, counting those a retransmission brought back. */
	lost?: number;
	/** Freezes the browser has counted in the picture so far. */
	freezes?: number;
}

/** What is known about one share, between readings. */
export interface Watch {
	last?: Reading;
	/** Since when frames have stood still while bytes kept arriving. */
	stalled?: number;
	/** Packets and freezes over the last STALL_MS, reading by reading. */
	recent: { at: number; received: number; lost: number; froze: number }[];
	/** The rung asked for instead of the measurement, and until when. */
	cap?: { rung: Rung; until: number };
	/** Nothing is judged before this. */
	quiet: number;
	/** How long the next cap is held: HOLD_MS, doubled for every failed return. */
	hold: number;
	/**
	 * When the original was last asked for again, while that is still being
	 * tried. Never set under a cap: taking one clears it, so a second step
	 * under the same cap is not taken for a second failed return.
	 */
	returned?: number;
}

export type Act = { kind: "cap"; rung: Rung } | { kind: "release" };

/**
 * A watch with no evidence in it — keeping, from `from`, what is not evidence
 * about the picture but about the line: the cap asked for, and how the original
 * has fared when it was asked for again. Every path that throws readings away
 * goes through here, so none of them forgets the back-off; one that did would
 * put a viewer whose share went to its card and back on twenty seconds again.
 */
export function fresh(now: number, from?: Pick<Watch, "cap" | "hold" | "returned">): Watch {
	return { recent: [], quiet: now, cap: from?.cap, hold: from?.hold ?? HOLD_MS, returned: from?.returned };
}

/** The rungs of a share, smallest first, one per height. */
export function rungsOf(publication: Pick<RemoteTrackPublication, "trackInfo">): Rung[] {
	const rungs: Rung[] = [];

	for (const layer of publication.trackInfo?.layers ?? []) {
		if (!layer.width || !layer.height || rungs.some((rung) => rung.height === layer.height)) continue;
		rungs.push({ width: layer.width, height: layer.height });
	}

	return rungs.sort((a, b) => a.height - b.height);
}

/** How far short of a request a rung may be and still serve it: the server's own. */
const TOLERANCE = 0.9;

/**
 * Which rung a request for `asking` is answered with, by the server's rule
 * (mediatrackreceiver.go:1060-1125): the smallest rung at least nine tenths as
 * tall as asked, or the top. A share taller than it is wide is compared by the
 * request's width, because the server compares it so. Undefined where nothing
 * is known, which the caller reads as the top.
 */
export function rungAsked(
	rungs: readonly Rung[],
	asking: Rung | undefined,
	portrait = false,
): number | undefined {
	if (!asking || !rungs.length) return undefined;

	const size = (portrait ? asking.width : asking.height) * TOLERANCE;
	const found = rungs.findIndex((rung) => rung.height >= size);
	return found < 0 ? rungs.length - 1 : found;
}

/** Reduce a receiver's stats report to a reading. */
export function readInbound(
	report: { forEach(callback: (entry: Record<string, unknown>) => void): void },
	at: number,
): Reading {
	let inbound: Record<string, unknown> | undefined;

	// One inbound video stream per receiver; the largest, should there ever be
	// more, because it is the one being drawn.
	report.forEach((entry) => {
		if (entry.type !== "inbound-rtp" || entry.kind !== "video") return;
		if (!inbound || (numeric(entry.bytesReceived) ?? 0) > (numeric(inbound.bytesReceived) ?? 0)) inbound = entry;
	});

	return {
		at,
		bytes: numeric(inbound?.bytesReceived),
		frames: numeric(inbound?.framesDecoded),
		received: numeric(inbound?.packetsReceived),
		lost: numeric(inbound?.packetsLost),
		freezes: numeric(inbound?.freezeCount),
	};
}

/**
 * Decide, from one more reading, whether to ask for something else.
 *
 * `reading` is undefined when there is nothing to read — the share is not
 * subscribed, or the tab is in the background. Then only the clock is looked at:
 * a cap that has run its time is lifted whether or not anybody is watching, so
 * that coming back to the share finds the original asked for.
 *
 * `asked` is the index of the rung this viewer's subscription asks for, where
 * that is known (see rungAsked); unknown is the top.
 */
export function judge(
	given: Watch,
	reading: Reading | undefined,
	rungs: readonly Rung[],
	now: number,
	asked?: number,
): { watch: Watch; act?: Act } {
	// Long enough on the original without a freeze, and what went wrong before
	// is forgiven: the next cap is held for HOLD_MS again. See the header.
	const watch =
		given.returned !== undefined && now - given.returned >= TRIED_MS
			? { ...given, hold: HOLD_MS, returned: undefined }
			: given;

	if (watch.cap && now >= watch.cap.until) {
		return {
			watch: { ...fresh(now + SETTLE_MS, { hold: watch.hold, returned: now }), last: reading },
			act: { kind: "release" },
		};
	}

	if (!reading) return { watch: fresh(watch.quiet, watch) };

	const last = watch.last;

	// A counter that went backwards is a stream that was replaced — a
	// resubscription, a new receiver. What was known about the old one is not
	// about this one.
	if (last && (backwards(reading.frames, last.frames) || backwards(reading.bytes, last.bytes))) {
		return { watch: { ...fresh(watch.quiet, watch), last: reading } };
	}

	// Nothing gathered while it is quiet, either: what happens then may be the
	// switch this file asked for, and a stall that began inside it would
	// otherwise be judged the moment the quiet ended.
	if (now < watch.quiet) return { watch: { ...watch, last: reading, stalled: undefined, recent: [] } };

	const moved = gain(reading.frames, last?.frames) > 0;
	const arriving = gain(reading.bytes, last?.bytes) >= ARRIVING;

	// From the last reading, or from the end of the quiet if that is later: a
	// stall that began inside it is counted from where it ended.
	const stalled =
		last && !moved && arriving && reading.frames !== undefined
			? (watch.stalled ?? Math.max(last.at, watch.quiet))
			: undefined;

	const recent =
		last && reading.received !== undefined && last.received !== undefined && reading.lost !== undefined && last.lost !== undefined
			? [
					...watch.recent,
					{
						at: now,
						received: gain(reading.received, last.received),
						lost: gain(reading.lost, last.lost),
						froze: gain(reading.freezes, last.freezes),
					},
				].filter((one) => one.at > now - STALL_MS)
			: watch.recent.filter((one) => one.at > now - STALL_MS);

	const next: Watch = { ...watch, last: reading, stalled, recent };

	const frozen = stalled !== undefined && now - stalled >= STALL_MS;

	// Loss counts only where the picture shows it; see LOSSY.
	const lost = recent.reduce((sum, one) => sum + one.lost, 0);
	const counted = lost + recent.reduce((sum, one) => sum + one.received, 0);
	const harmed = recent.some((one) => one.froze > 0);
	const lossy = harmed && counted >= COUNTED && lost / counted > LOSSY;

	if (!frozen && !lossy) return { watch: next };

	// The step is from the lower of the cap already asked for — a cap that has
	// not taken yet is still a step that was taken — and the rung this viewer's
	// subscription asks for. Not from the frames arriving; see the header.
	const top = rungs.length - 1;
	const capped = watch.cap ? rungs.findIndex((rung) => rung.height === watch.cap?.rung.height) : -1;
	const from = Math.min(capped < 0 ? top : capped, asked ?? top);
	const lower = from > 0 ? rungs[from - 1] : undefined;

	// Already at the bottom, or a share with no rungs beneath it: there is
	// nothing smaller to ask for, and asking again every second would only be
	// noise. The evidence starts again.
	if (!lower) return { watch: { ...next, stalled: undefined, recent: [], quiet: now + STALL_MS } };

	// Frozen again while the original is still being tried, after it was asked
	// for again: it could not be carried, and it is asked for again twice as
	// late. A further step under the cap this takes is not a return — the cap
	// clears `returned` — and leaves the wait as it is.
	const hold = watch.returned !== undefined ? Math.min(watch.hold * 2, LONGEST_HOLD_MS) : watch.hold;

	return {
		watch: {
			...next,
			stalled: undefined,
			recent: [],
			cap: { rung: lower, until: now + hold },
			hold,
			returned: undefined,
			quiet: now + SETTLE_MS,
		},
		act: { kind: "cap", rung: lower },
	};
}

/**
 * Watch every share this browser receives, and step one down while it freezes.
 *
 * Returns the unsubscribe; the room's own lifetime is the subscription's
 * otherwise.
 */
export function watchShareFreezes(room: Room): () => void {
	interface Entry {
		publication: RemoteTrackPublication;
		watch: Watch;
		/**
		 * What this file last told the publication at a moment it could take
		 * it, if anything. Never a telling the SDK dropped: see tell.
		 */
		told?: Rung;
		/**
		 * Whether this file has ever asked this publication for anything. A
		 * publication never capped is never touched, so a share that never
		 * freezes is subscribed exactly as it would be without this file.
		 */
		touched: boolean;
	}

	const entries = new Map<string, Entry>();
	let reading = false;

	/*
	 * The entry for a publication, made afresh for one not seen before — or for
	 * one under a known sid that is not the object remembered, which is a full
	 * reconnection and a new stream. See the header.
	 */
	const entryFor = (publication: RemoteTrackPublication): Entry => {
		const known = entries.get(publication.trackSid);
		if (known?.publication === publication) return known;

		const entry: Entry = { publication, watch: fresh(performance.now()), touched: false };
		entries.set(publication.trackSid, entry);
		return entry;
	};

	/*
	 * Tell the publication what the watch wants, if that is not what it was last
	 * told. Only while the share is wanted and its track is here: the SDK refuses
	 * a request for a track not subscribed to (isManualOperationAllowed), drops
	 * one that comes before the track while saying nothing (see the header), and
	 * keeps what it was told before through both — so a cap set before the share
	 * went off the stage would otherwise survive it coming back.
	 *
	 * Then by the tick as well as by the room saying the track arrived, because
	 * the room does not always say so at once: during a reconnection it holds
	 * TrackSubscribed back until it has reconnected (emitWhenConnected,
	 * esm.mjs:33444), while the track is already here to be told.
	 */
	const tell = (entry: Entry) => {
		const wanted = entry.watch.cap?.rung ?? (entry.touched ? UNCAPPED : undefined);
		if (!wanted || !entry.publication.isDesired || !(entry.publication.videoTrack instanceof RemoteVideoTrack)) return;
		if (entry.told && entry.told.width === wanted.width && entry.told.height === wanted.height) return;

		entry.publication.setVideoDimensions({ width: wanted.width, height: wanted.height });
		entry.told = wanted;
		entry.touched = true;
	};

	const tick = async () => {
		// Never two at once: a slow getStats would otherwise have two readings
		// judged against the same last one.
		if (reading) return;
		reading = true;

		try {
			const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
			const present = new Set<string>();

			for (const participant of room.remoteParticipants.values()) {
				for (const publication of participant.trackPublications.values()) {
					if (publication.source !== Track.Source.ScreenShare || publication.kind !== Track.Kind.Video) continue;

					present.add(publication.trackSid);

					const entry = entryFor(publication);
					const track = publication.videoTrack;
					const receiver = track instanceof RemoteVideoTrack ? track.receiver : undefined;

					let read: Reading | undefined;
					if (!hidden && publication.isSubscribed && receiver) {
						try {
							read = readInbound((await receiver.getStats()) as never, performance.now());
						} catch {
							// A reading that failed says nothing either way.
						}
					}

					// Replaced while the stats were being read: what was read
					// belongs to a stream that is gone.
					if (entries.get(publication.trackSid) !== entry) continue;

					const rungs = rungsOf(publication);
					const info = publication.trackInfo;
					const portrait = !!info && info.width < info.height;
					const asked = rungAsked(rungs, measured(publication), portrait);
					const { watch } = judge(entry.watch, read, rungs, performance.now(), asked);
					entry.watch = watch;
					tell(entry);
				}
			}

			// A share that ended takes what was known about it with it.
			for (const sid of entries.keys()) if (!present.has(sid)) entries.delete(sid);
		} finally {
			reading = false;
		}
	};

	// Coming back on to the stage is a new subscription with the old request
	// still on the publication. Put the right one on it at once rather than at
	// the next tick, so the first keyframe is of the rung that is wanted.
	const onSubscribed = (_track: unknown, publication: RemoteTrackPublication) => {
		if (publication.source !== Track.Source.ScreenShare || publication.kind !== Track.Kind.Video) return;

		const entry = entryFor(publication);
		entry.watch = fresh(entry.watch.quiet, entry.watch);
		tell(entry);
	};

	room.on(RoomEvent.TrackSubscribed, onSubscribed);
	const timer = setInterval(() => void tick(), EVERY_MS);

	return () => {
		clearInterval(timer);
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
		entries.clear();
	};
}

/** What adaptive streaming last measured the picture at, where the SDK says. See the header. */
function measured(publication: RemoteTrackPublication): Rung | undefined {
	const dimensions = (publication as unknown as { videoDimensionsAdaptiveStream?: Partial<Rung> })
		.videoDimensionsAdaptiveStream;
	return dimensions?.width && dimensions.height ? { width: dimensions.width, height: dimensions.height } : undefined;
}

/** A change in a counter, or nothing where either end is unknown or it went backwards. */
function gain(value: number | undefined, was: number | undefined): number {
	if (value === undefined || was === undefined || value < was) return 0;
	return value - was;
}

function backwards(value: number | undefined, was: number | undefined): boolean {
	return value !== undefined && was !== undefined && value < was;
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
