/**
 * Telling somebody sharing their screen that their line cannot carry it.
 *
 * A hint and nothing more. A share asks for what its setting is worth and the
 * browser's own congestion control decides what goes out; when the line is
 * smaller than the ask, `maintain-resolution` keeps every frame sharp and drops
 * frames instead, and the share stutters for everybody watching while the
 * person sharing sees a perfectly smooth screen in front of them. Measured on a
 * real call: 2560x1440 at 120 asking 48.7 Mb/s, a home uplink carrying about 37,
 * and nobody at either end able to say why it juddered.
 *
 * So this reads the sender, and when the evidence is unambiguous it shows the
 * person sharing — them and nobody else — what the line is carrying, what the
 * share wants, and one setting that would fit, with a button that applies it
 * through the same mid-share retune the menu uses and a button that puts the
 * question away for the rest of the share.
 *
 * ## What this must never be again
 *
 * There was an automatic uplink follower (live/uplink.ts, deleted on
 * 2026-09-07 at the owner's order, "不允许自动降低码率"). It halved the share's
 * ceiling whenever it judged the share to be struggling and wrote the result to
 * local storage as the starting ceiling for every later share. It was wrong in
 * two silent ways, and both are answered here by construction:
 *
 *   - It took few frames sent as a sign of trouble, and a still screen sends
 *     almost none by design. Here a frame shortfall only counts when the
 *     capture is producing frames the encoder then does not send — measured
 *     against the capture, not against the setting.
 *   - It remembered a bad afternoon for ever. Here nothing outlives the share:
 *     no storage, no figure carried into the next one, and "Not now" lasts
 *     exactly as long as the share it was said about.
 *
 * And it changes nothing on its own. The ceiling, the size and the rate are
 * whatever somebody chose until they press the button.
 *
 * ## What Chrome actually reports, which is not what was expected
 *
 * Measured in Chrome 145 with a share-shaped sender — H.264, three simulcast
 * layers, `maintain-resolution` — over a loopback whose answer carried
 * `b=AS` to hold the line at 8 and 25 Mb/s:
 *
 *   - `qualityLimitationReason` reads "none" throughout, while the top layer
 *     sends 36 of 57 captured frames, or 1 of 56. The only time it read
 *     "bandwidth" was with layers switched off — paused by dynacast, nobody
 *     watching — which fits the reading of libwebrtc that has it count a layer
 *     the allocator disabled, or a quality scaler shrinking the picture, and
 *     not a layer starved while it keeps every pixel. maintain-resolution
 *     turns that scaler off. The obvious test — wait for it to say bandwidth —
 *     would never have fired for the case this exists for. It is used only to
 *     rule out: "cpu" or "other" means the line is not the explanation.
 *   - It reads "none" during the climb at the start, too. The estimate begins
 *     near 5 Mb/s and grows by about a twelfth a second: 48.7 was reached
 *     after 36 seconds, and through most of that the top layer dropped frames
 *     exactly as it does on a line that is genuinely full.
 *   - The encoder overshoots its targets, sometimes threefold, and the browser
 *     answers by lowering the target. So a target is a statement that the
 *     allotment is short, not a measure of what fits; what fits is worked out
 *     from the line's estimate and from what the other layers actually took.
 *
 * And then through this application end to end — the server, two browsers, a
 * share published by room.ts with its answer held to 25 Mb/s:
 *
 *   - A page of code scrolling at 1440p sixty, asking 34.4, went out at the full
 *     sixty frames inside 20 Mb/s. A ceiling is not a need, which is why a
 *     short allotment alone is never enough to speak: only frames that the
 *     capture offered and the encoder did not send are a stutter.
 *   - The same page under noise sent 18 to 20 frames of 60 with the reason
 *     still "none", and was told at 80 seconds — late, because a starved
 *     encoder sends little and the estimate climbs slowly behind it: it was
 *     still rising at 66 seconds, and that slope is what held the card back
 *     until the line had plainly stopped giving more.
 *
 * ## The rule
 *
 * Read every two seconds. One reading is *strained* when all of these hold:
 *
 *   - The top layer is being sent at all. dynacast pauses it when nobody is
 *     watching at full size, and a paused layer sends nothing for reasons that
 *     have nothing to do with the line.
 *   - The reason is "none" or "bandwidth".
 *   - The capture is moving: at least ten frames a second entering the encoder.
 *     A still screen is not evidence either way.
 *   - Frames are being dropped: the top layer sends at most three quarters of
 *     the frames the capture offered.
 *   - The allotment is short: the browser's target for the top layer is at most
 *     three quarters of its ceiling. A layer allotted its whole ceiling that
 *     still drops frames is a ceiling too low for the content, which a smaller
 *     setting would make worse — measured, after the cap above was lifted.
 *   - The layer spends what it is allotted: it sends at least four fifths of its
 *     target. A short target that is not being spent is an estimate that never
 *     had a reason to climb — a still screen, or a machine too busy to encode —
 *     and not a line that is full.
 *
 * Nothing is read at all for the first thirty seconds of a share or the first
 * fifteen after any change to it, and what was read before a change is thrown
 * away. Then the share is said to be struggling when, over the last twenty
 * seconds, at least four readings in five were strained, the latest among
 * them; the line's estimate was flat rather than climbing (the newest third no
 * more than 15% above the oldest); the line was full (what went out on it, at
 * the median, at least 85% of the estimate); the encoder was carrying the
 * setting the menu shows; and what the line carries is less than the share
 * asks for. Once said, it is withdrawn the same way: four readings in five
 * *clear* over twenty seconds — moving, measured, and not strained. A still
 * screen neither raises it nor takes it down.
 *
 * The line has to be full because a flat estimate is not, on its own, a line
 * that will give no more. The estimate only climbs while it is being tested —
 * libwebrtc's rate control holds it to about one and a half times what is
 * actually getting through — so an encoder starved for a while holds the
 * estimate down with it, and the estimate sits still at about two thirds full
 * on a line with room to spare. End to end, at 25 Mb/s held, the estimate stood
 * at 6.4 for sixteen seconds and at 11.6 for ten while the share climbed; the
 * same kind of stall replayed after the quiet time, on a 60 Mb/s line, passed
 * every other test here and offered 1080p at fifteen. A line that is genuinely
 * full is used: the recorded one at 25 carried 88 to 97% of it in the share's
 * own layers alone.
 *
 * And the quiet time is owed to a connection rather than to a share. A full
 * reconnect publishes the same share again on a new connection whose estimate
 * starts from nothing, so a new publication of a share is left alone for thirty
 * seconds as a new share would be — while "Not now" stays said, because it is
 * still the same share.
 *
 * Every missing figure makes a reading say nothing, and a reading that says
 * nothing cannot make up four in five. Firefox (157, measured) reports the
 * frames and the bytes but no target, no limitation reason and no estimate of
 * the line, so it is never told anything; Safari is told whatever its reports
 * carry, and nothing where they do not. A browser that reports less than Chrome
 * is told less, never something else.
 */

import { type Room, Track } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { actionFailed } from "./notices";
import {
	type Capture,
	type Running,
	SMALL,
	type ShareSetting,
	askOf,
	ladderAt,
	retune,
	runningShare,
	sizeOf,
	stepsDown,
	watchRunning,
} from "./room";

/** How often the sender is read. */
export const EVERY_MS = 2000;

/** How long a new share is left alone: the estimate starts low and climbs. */
export const QUIET_AFTER_START_MS = 30_000;

/** How long a changed share is left alone, for the same reason on a smaller scale. */
export const QUIET_AFTER_CHANGE_MS = 15_000;

/** How much evidence it takes, in either direction. */
export const WINDOW_MS = 20_000;

/** The share of readings in the window that have to agree. */
const MOST = 0.8;

/*
 * A window with fewer readings than this has gaps in it — reads that failed, a
 * tab the browser stopped running — and four in five of not very many is not
 * twenty seconds of anything.
 */
const AT_LEAST = Math.floor((WINDOW_MS / EVERY_MS) * 0.75);

/** Frames a second entering the encoder below which the picture is still. */
const MOVING = 10;

/** The top layer sends at most this share of the frames it was offered. */
const DROPPING = 0.75;

/** The browser allots the top layer at most this share of its ceiling. */
const SHORT = 0.75;

/** The top layer sends at least this share of what it was allotted. */
const SPENDING = 0.8;

/** How much the estimate may rise across the window and still be a ceiling. */
const CLIMBING = 1.15;

/**
 * How much of the line's estimate has to be going out on it for the line to be
 * the limit.
 *
 * Between the two things measured: a full line carried 88 to 97% of its
 * estimate in the share's own layers, and an estimate held down by a starved
 * encoder sits near two thirds, where libwebrtc's rate control stops it. Below
 * the full line's lowest reading, because where the browser does not count the
 * whole line the share's layers stand in for it, and they leave out the camera
 * and the voice — which must not be what pushes a real limit under the bar.
 */
const FULL = 0.85;

/**
 * How far above what the menu's setting would set the encoder's ceiling may be
 * and still be that setting: room for rounding, and nothing more.
 */
const CARRYING = 1.02;

/**
 * The share of the line a suggestion may use.
 *
 * Four fifths, so the setting offered fits with room left for the camera and
 * the voice, which are not counted, and for the estimate being an estimate.
 */
const HEADROOM = 0.8;

/** A suggestion has to cost at least this much less than now, as actually sent. */
const CHEAPER = 0.95;

/**
 * The share of its ceiling Chrome allots the 1080p rung while the top layer is
 * on: 8.5 of 11.3 Mb/s at sixty frames and 6.0 of 8 at thirty (Chrome 145,
 * 2026-10-14, a 1440p share with a full-size viewer). The 720p rung was allotted
 * its whole 2.5, but no setting lowers that one's ceiling, so this is only ever
 * asked about the rung that a step below sixty frames does lower.
 */
const ALLOTTED = 0.75;

/** One reading of the share's sender, reduced to what the rule needs. */
export interface Sample {
	/** When, on the caller's clock. */
	at: number;
	/** Whether the top layer is being sent at all. */
	active: boolean;
	/** Frames a second entering the encoder. */
	source?: number;
	/** Frames a second the top layer sent. */
	sent?: number;
	/** Bits a second the top layer sent. */
	spent?: number;
	/** Bits a second every other layer of the share sent. */
	rest?: number;
	/**
	 * The layers beneath the top one by one, in the order of their encodings —
	 * the order `retune` names their rungs by: each one's ceiling and the bits a
	 * second it sent. What a step to fewer frames would give back to the top.
	 */
	rungs?: { ceiling?: number; spent?: number }[];
	/**
	 * Bits a second that went out on the line, everything on it: the share,
	 * and the camera and the voice that share its connection.
	 */
	carried?: number;
	/** What the browser allotted the top layer. */
	target?: number;
	/** What the top layer may send at most. */
	ceiling?: number;
	/** What every active layer may send, together: what the share asks of the line. */
	asked?: number;
	/** The browser's estimate of what the line carries. */
	available?: number;
	/** Why the encoder says it is held back, where it says. */
	reason?: string;
	/** The picture entering the encoder. */
	width?: number;
	height?: number;
}

/** What one reading leaves for the next, so rates can be changes rather than totals. */
export interface Counters {
	at: number;
	frames?: number;
	layers: Map<string, { frames?: number; bytes?: number }>;
	/** The line's own count, by the pair it was counted on. */
	line?: { pair: string; bytes?: number };
}

/** What is said to the person sharing. */
export interface Hint {
	/** What the line carries, in bits a second. */
	have: number;
	/** What the share asks for, in bits a second. */
	need: number;
	/** The setting that would fit. */
	to: ShareSetting;
}

type Entry = Record<string, unknown> & { type?: string; id?: string };

/**
 * Reduce one stats report to a reading.
 *
 * Every figure is read only if the browser gave it, and a figure that is not a
 * number is not a figure. The top layer is found by the rid of the last
 * encoding, which is how the SDK orders them; the picture entering the encoder
 * by the media-source entry, which Chrome links from only one of the three
 * layers — measured, and the reason this does not insist on the link.
 */
export function readSample(
	report: { forEach(callback: (entry: Entry) => void): void },
	encodings: readonly RTCRtpEncodingParameters[],
	previous: Counters | undefined,
	now: number,
): { sample: Sample; counters: Counters } {
	const entries: Entry[] = [];
	report.forEach((entry) => entries.push(entry));

	const outbound = entries.filter((entry) => entry.type === "outbound-rtp" && entry.kind !== "audio");
	const top = encodings[encodings.length - 1];
	const topRid = top?.rid;

	// By rid where there is one. A single encoding has none, and then there is
	// only one layer to be.
	const layer =
		(topRid !== undefined ? outbound.find((entry) => entry.rid === topRid) : undefined) ??
		(outbound.length === 1 ? outbound[0] : undefined);

	const linked = entries.find((entry) => entry.type === "media-source" && entry.id === layer?.mediaSourceId);
	const source = linked ?? entries.find((entry) => entry.type === "media-source" && entry.kind === "video");

	// The pair the transport says it chose, and otherwise the one nominated.
	const transport = entries.find((entry) => entry.type === "transport" && typeof entry.selectedCandidatePairId === "string");
	const pair =
		entries.find((entry) => entry.type === "candidate-pair" && entry.id === transport?.selectedCandidatePairId) ??
		entries.find((entry) => entry.type === "candidate-pair" && entry.nominated === true && entry.state === "succeeded");

	const stamp = numeric(layer?.timestamp) ?? now;
	const seconds = previous ? (stamp - previous.at) / 1000 : 0;

	// A change over the gap, or nothing: a counter that went backwards belongs
	// to a stream that was replaced, and a gap of nothing divides by nothing.
	const rate = (value: number | undefined, was: number | undefined): number | undefined => {
		if (value === undefined || was === undefined || seconds <= 0 || value < was) return undefined;
		return (value - was) / seconds;
	};

	const key = (entry: Entry) => String(entry.rid ?? entry.id ?? "");
	const layers = new Map<string, { frames?: number; bytes?: number }>();

	for (const entry of outbound) {
		layers.set(key(entry), {
			frames: numeric(entry.framesSent) ?? numeric(entry.framesEncoded),
			bytes: numeric(entry.bytesSent),
		});
	}

	// What the pair has sent, which counts every sender on the connection —
	// measured in Chrome 145, where it ran ahead of the share's own layers by a
	// second sender's worth. Only against a reading of the same pair: a
	// connection that moved to another pair is a different count, and the
	// difference between the two would be nothing at all.
	const line = typeof pair?.id === "string" ? { pair: pair.id, bytes: numeric(pair.bytesSent) } : undefined;
	const counters: Counters = { at: stamp, frames: numeric(source?.frames), layers, line };
	const carriedBytes =
		line && previous?.line?.pair === line.pair ? rate(line.bytes, previous.line.bytes) : undefined;

	const was = layer ? previous?.layers.get(key(layer)) : undefined;
	const mine = layer ? layers.get(key(layer)) : undefined;

	// Every other layer's bits, or nothing if any of them cannot be said: a
	// partial sum would understate what the rest of the share takes and offer
	// a setting that does not fit.
	let rest: number | undefined = 0;
	for (const entry of outbound) {
		if (entry === layer) continue;
		const bits = rate(layers.get(key(entry))?.bytes, previous?.layers.get(key(entry))?.bytes);
		rest = bits === undefined || rest === undefined ? undefined : rest + bits * 8;
	}

	const spentBytes = rate(mine?.bytes, was?.bytes);

	// By rid, as the top layer is found, and a rung with no entry of its own
	// sent nothing anybody can count: no figure, rather than a zero that would
	// read as a rung known to be idle.
	const rungs = encodings.slice(0, -1).map((encoding) => {
		const entry = encoding.rid === undefined ? undefined : outbound.find((one) => one.rid === encoding.rid);
		const bytes = entry ? rate(layers.get(key(entry))?.bytes, previous?.layers.get(key(entry))?.bytes) : undefined;
		return { ceiling: numeric(encoding.maxBitrate), spent: bytes === undefined ? undefined : bytes * 8 };
	});

	const sample: Sample = {
		at: now,
		active: top !== undefined && top.active !== false && layer !== undefined && layer.active !== false,
		source: rate(counters.frames, previous?.frames) ?? numeric(source?.framesPerSecond),
		sent: rate(mine?.frames, was?.frames) ?? numeric(layer?.framesPerSecond),
		spent: spentBytes === undefined ? undefined : spentBytes * 8,
		rest,
		rungs,
		carried: carriedBytes === undefined ? undefined : carriedBytes * 8,
		target: numeric(layer?.targetBitrate),
		ceiling: numeric(top?.maxBitrate),
		asked: encodings.every((encoding) => encoding.active === false || numeric(encoding.maxBitrate) !== undefined)
			? encodings.reduce((sum, encoding) => sum + (encoding.active === false ? 0 : (encoding.maxBitrate ?? 0)), 0)
			: undefined,
		available: numeric(pair?.availableOutgoingBitrate),
		reason: typeof layer?.qualityLimitationReason === "string" ? layer.qualityLimitationReason : undefined,
		width: numeric(source?.width) ?? numeric(layer?.frameWidth),
		height: numeric(source?.height) ?? numeric(layer?.frameHeight),
	};

	return { sample, counters };
}

/** What one reading says about the line. */
export function classify(sample: Sample): "strained" | "clear" | "unknown" {
	const { source, sent, spent, target, ceiling, available, reason } = sample;

	if (!sample.active) return "unknown";
	if (
		source === undefined ||
		sent === undefined ||
		spent === undefined ||
		target === undefined ||
		ceiling === undefined ||
		available === undefined ||
		reason === undefined
	) {
		return "unknown";
	}

	// The machine, or something the browser will not name. Neither is the
	// line, and a hint about the line would send somebody to the wrong place.
	if (reason !== "none" && reason !== "bandwidth") return "unknown";

	if (source < MOVING) return "unknown";

	const dropping = sent <= DROPPING * source;
	const short = target <= SHORT * ceiling;
	const spending = spent >= SPENDING * target;

	return dropping && short && spending ? "strained" : "clear";
}

/**
 * How much of the line's estimate went out on it, or nothing.
 *
 * The line's own count where the browser keeps one. Otherwise the share's
 * layers, which leave out the camera and the voice and so can only say the line
 * is emptier than it is: a missing figure makes this quieter, never louder.
 */
function fullness(sample: Sample): number | undefined {
	const { carried, spent, rest, available } = sample;
	if (available === undefined || available <= 0) return undefined;

	const out = carried ?? (spent === undefined ? undefined : spent + (rest ?? 0));
	return out === undefined ? undefined : out / available;
}

/** The middle value of what is there, or nothing. */
function median(values: (number | undefined)[]): number | undefined {
	const known = values.filter((value): value is number => value !== undefined).sort((a, b) => a - b);
	if (known.length === 0) return undefined;

	const middle = Math.floor(known.length / 2);
	return known.length % 2 ? known[middle] : ((known[middle - 1] ?? 0) + (known[middle] ?? 0)) / 2;
}

/**
 * The setting to offer, or nothing.
 *
 * The one worth most — by the same price `bitrateFor` puts on a picture — whose
 * ceiling fits in four fifths of the line once the rest of the share has taken
 * what it takes: `budget`, plus whatever `back` says the rungs beneath would
 * give back under that setting (see `givenBack`). Never larger and never
 * faster than what was chosen, which is `stepsDown`'s promise. Priced twice:
 * at its ceiling, which is what retune will
 * set and what has to fit; and at the frames the capture actually offers, which
 * is what it would change. A display that gives sixty frames shared at 120
 * gains nothing from being offered sixty, and an offer that changes nothing is
 * a wrong hint.
 *
 * Nothing, rather than the smallest, when even the smallest does not fit. A card
 * whose only button is a dismissal is a warning nobody can act on from inside
 * the call, and the figures it would have to quote are ceilings, not needs: the
 * lightest setting often runs comfortably on less than its ceiling, so "even
 * that will not fit" could easily be false.
 */
export function suggest(
	from: ShareSetting,
	budget: number,
	capture: Capture,
	back: (step: ShareSetting) => number = () => 0,
): ShareSetting | undefined {
	const now = askOf(from, capture);
	let best: { step: ShareSetting; worth: number } | undefined;

	for (const step of stepsDown(from)) {
		if (askOf(step, { width: capture.width, height: capture.height }) > budget + back(step)) continue;

		const worth = askOf(step, capture);
		if (worth >= now * CHEAPER) continue;

		if (!best || worth > best.worth || (worth === best.worth && area(step) < area(best.step))) {
			best = { step, worth };
		}
	}

	return best?.step;
}

/*
 * Of two settings that come to the same, the smaller picture by name.
 *
 * Two sizes only price the same when the capture is no larger than the smaller
 * of them, so both send the same pixels and only the label differs — and the
 * label is what the card says. Somebody sharing a 1080p display on Automatic was
 * offered "1440p at 15", which reads as asking for more; it is 1080p at fifteen
 * that would be sent either way. Two rates of one size that price the same are
 * left as stepsDown lists them, the higher first: the capture's rate is whatever
 * the content gave while it was measured, and the next minute may give more.
 */
function area(setting: ShareSetting): number {
	const size = sizeOf(setting.quality);
	return size.width * size.height;
}

/**
 * What the rungs beneath the top would give back to it under `step`, by one
 * reading, or nothing where the reading cannot say.
 *
 * A rung gives back only where `step` lowers its ceiling, and then only what it
 * was sending above what Chrome would allot it under the lower one. Measured
 * rather than priced: a rung on calm content sending less than that allotment
 * would go on sending the same, and crediting it the difference in ceilings
 * would offer a setting that does not fit. A rung whose ceiling stays gives
 * nothing, however much it sends — three quarters of the 720p rung's 2.5 is
 * less than it is allotted, and counting the gap would credit every step,
 * sixty frames included, with something nobody gives back.
 *
 * The ladder is the one for `step`'s own rate, where retune takes the one for
 * the rate the capture gives under it, which is never more. A display that gives
 * thirty to a step of sixty is therefore counted the 11.3 Mb/s rung it will
 * not carry — less given back than will be, never more.
 */
function givenBack(sample: Sample, step: ShareSetting): number | undefined {
	if (!sample.rungs) return undefined;

	const ladder = ladderAt(step.frameRate);
	let back = 0;

	sample.rungs.forEach((rung, index) => {
		// The rung retune would write at this place: `ladder[index] ?? SMALL`.
		const then = (ladder[index] ?? SMALL).encoding.maxBitrate;
		if (rung.ceiling === undefined || rung.spent === undefined || then === undefined || then >= rung.ceiling) return;

		back += Math.max(0, rung.spent - ALLOTTED * then);
	});

	return back;
}

/**
 * Decide, from the readings so far, what should be showing now.
 *
 * Returns the hint to show, `null` to take it down, or `undefined` to leave
 * whatever is there. `settled` is the moment readings start to count: thirty
 * seconds after the share began or fifteen after it last changed, whichever is
 * later. Readings from before it are not looked at.
 */
export function judge(
	samples: readonly Sample[],
	settled: number,
	setting: ShareSetting | undefined,
	showing: boolean,
): Hint | null | undefined {
	const counted = samples.filter((sample) => sample.at >= settled);
	const latest = counted[counted.length - 1];
	const first = counted[0];

	// Not until the readings reach back a whole window, all of it after the
	// quiet time.
	if (!latest || !first || latest.at - first.at < WINDOW_MS - EVERY_MS / 2) return undefined;

	const window = counted.filter((sample) => sample.at > latest.at - WINDOW_MS);
	if (window.length < AT_LEAST) return undefined;

	const said = window.map(classify);
	const strained = said.filter((one) => one === "strained").length;
	const clear = said.filter((one) => one === "clear").length;
	const now = said[said.length - 1];

	if (showing) {
		return now === "clear" && clear >= MOST * window.length ? null : undefined;
	}

	if (now !== "strained" || strained < MOST * window.length) return undefined;

	// Flat rather than climbing. The estimate's climb at the start of a share
	// looks exactly like a full line, reading by reading; the difference is
	// only visible across time.
	const third = Math.max(1, Math.floor(window.length / 3));
	const early = median(window.slice(0, third).map((sample) => sample.available));
	const late = median(window.slice(-third).map((sample) => sample.available));

	if (early === undefined || late === undefined || late > early * CLIMBING) return undefined;

	// And full rather than merely flat. See the header: an estimate also stops
	// climbing when nothing is testing it, and then the line is not the limit
	// however still the figure stands.
	const full = median(window.map(fullness));
	if (full === undefined || full < FULL) return undefined;

	if (!setting) return undefined;

	// The encoder carrying something other than the setting it is supposed to
	// be carrying — a publication that came back with its first options, and a
	// retune that did not take — makes every figure below about one setting and
	// every word on the card about another. Only above it counts: what settle and
	// retune write is the setting's price or less, never more.
	if (
		latest.ceiling === undefined ||
		latest.ceiling > CARRYING * askOf(setting, { width: latest.width, height: latest.height })
	) {
		return undefined;
	}

	const have = median(window.map((sample) => sample.available));
	const need = latest.asked;

	// What the rungs take now, under the setting being sent.
	const rest = median(window.map((sample) => sample.rest));

	// What would make the sentence false: a line that carries what the share
	// asks is not the reason it stutters.
	if (have === undefined || need === undefined || rest === undefined || have >= need) return undefined;

	// And what they would take under the setting offered, which is not always
	// the same. Since 2026-10-14 the 1080p rung follows the share's rate —
	// sixty frames and 11.3 Mb/s for a share at sixty or more, thirty and 8
	// below — and retune moves it, so a setting under sixty leaves the top
	// about two and a half megabits more than `rest` counts. Counted from
	// 2026-10-14 after review: without it, a 1440p share at sixty on a 30 Mb/s
	// line was offered 1080p at fifteen, when 1080p at thirty fitted once the
	// rung had come down — half the frames for nothing.
	const back = (step: ShareSetting) => median(window.map((sample) => givenBack(sample, step))) ?? 0;

	const to = suggest(
		setting,
		HEADROOM * have - rest,
		{
			width: latest.width,
			height: latest.height,
			frameRate: median(window.map((sample) => sample.source)),
		},
		back,
	);

	return to ? { have, need, to } : undefined;
}

/** A figure in megabits, the way the connection reading says it. */
export function megabits(bits: number): string {
	const mega = bits / 1_000_000;
	return mega >= 10 ? String(Math.round(mega)) : mega.toFixed(1);
}

/** What is being watched, and what has been said about it. */
interface Watch {
	/** Which share: `Running.id`. Everything below belongs to it alone. */
	share: number;
	/** Which publication of it. A full reconnect publishes one share again. */
	sid: string;
	/** Which setting of it: `Running.since`. */
	since: number;
	/** When the connection carrying it began estimating the line from nothing. */
	fresh: number;
	samples: Sample[];
	counters?: Counters;
	/** "Not now", for the rest of this share. */
	dismissed: boolean;
	showing: boolean;
}

/**
 * Watch this browser's own share, and say so when its line cannot carry it.
 *
 * Only ever about the share this browser is sending, so only the person sharing
 * is ever told. Starts again from nothing for every share — a new share is a new
 * `Running.id` — and nothing is carried from one share to the next.
 *
 * The watch is held outside the effect that reads, and is not keyed on the
 * track. `sharing` follows the room's pictures and the sid follows the
 * publication, and a full reconnect changes both in the middle of one share:
 * the SDK unpublishes the capture and publishes it again. Keyed that way, the
 * watch took the reconnect for a new share and forgot "Not now" — replayed
 * through this hook, the card was back twenty-two seconds after it — while
 * owing the new connection, whose estimate climbs from nothing again, none of
 * the quiet time a new share is given.
 */
export function useShareStrain(room: Room, sharing: boolean) {
	const [hint, setHint] = useState<Hint>();
	const [busy, setBusy] = useState(false);

	const watch = useRef<Watch>();

	/*
	 * Down the moment the share changes, rather than at the next reading.
	 *
	 * Two seconds is long enough to press a button in. With the card left up
	 * after the setting was changed from the menu, Switch applied what had been
	 * worked out for the old setting — 1440p at thirty, pressed just after
	 * somebody chose 1080p at fifteen — which is a change upward that nobody
	 * asked for, made by a card about a setting no longer being sent.
	 */
	useEffect(
		() =>
			watchRunning(() => {
				const current = watch.current;
				const running = runningShare(room);

				if (!current || (running?.id === current.share && running.since === current.since)) return;

				current.samples = [];
				current.counters = undefined;
				if (current.showing) {
					current.showing = false;
					setHint(undefined);
				}
			}),
		[room],
	);

	useEffect(() => {
		// What was measured was measured against something no longer being
		// sent, and whatever was said about it no longer applies.
		const reset = (current: Watch) => {
			current.samples = [];
			current.counters = undefined;
			if (current.showing) {
				current.showing = false;
				setHint(undefined);
			}
		};

		if (!sharing) {
			// Down with the share's picture. The watch stays: this is also what a
			// reconnect looks like from here, half way through a share, and what
			// was said about that share — "Not now" — still stands when it is back.
			if (watch.current) reset(watch.current);
			setHint(undefined);
			return;
		}

		let live = true;

		const look = async () => {
			const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
			const sender = publication?.videoTrack?.sender;
			const running = runningShare(room);

			if (!publication || !sender || !running) return;

			const now = performance.now();

			// A different share from the last reading's: nothing said about that
			// one is about this one.
			if (watch.current?.share !== running.id) {
				watch.current = {
					share: running.id,
					sid: publication.trackSid,
					since: running.since,
					fresh: running.started,
					samples: [],
					dismissed: false,
					showing: false,
				};
				setHint(undefined);
			}

			const current = watch.current;

			// The same share published again, on a new connection: owed the
			// quiet time a new share is owed, and still the same share.
			if (current.sid !== publication.trackSid) {
				current.sid = publication.trackSid;
				current.fresh = now;
				reset(current);
			}

			// A change of setting, from the menu or from the hint itself.
			if (current.since !== running.since) {
				current.since = running.since;
				reset(current);
			}

			if (current.dismissed) return;

			let report: RTCStatsReport;
			try {
				report = await sender.getStats();
			} catch {
				// A reading that failed is a gap, and the window allows for gaps.
				return;
			}

			if (!live || watch.current !== current) return;

			const at = performance.now();
			const { sample, counters } = readSample(
				report as never,
				sender.getParameters().encodings ?? [],
				current.counters,
				at,
			);

			current.counters = counters;
			current.samples = [...current.samples.filter((one) => one.at > at - 2 * WINDOW_MS), sample];

			const settled = Math.max(current.fresh + QUIET_AFTER_START_MS, running.since + QUIET_AFTER_CHANGE_MS);
			const said = judge(current.samples, settled, running, current.showing);

			if (said === null) {
				current.showing = false;
				setHint(undefined);
			} else if (said) {
				current.showing = true;
				setHint(said);
			}
		};

		const timer = setInterval(() => void look(), EVERY_MS);

		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [room, sharing]);

	/** Apply the setting offered, through the same retune the menu uses. */
	const accept = useCallback(async () => {
		const current = watch.current;
		if (!hint || busy || !current?.showing) return;

		// The press is for the setting the card was worked out against. A share
		// that moved since — the menu, in the moment before the card went down
		// — is not what the card is about, so the press is dropped rather than
		// applied to it.
		const running: Running | undefined = runningShare(room);
		if (running?.id !== current.share || running.since !== current.since) {
			current.showing = false;
			setHint(undefined);
			return;
		}

		setBusy(true);

		try {
			const took = await retune(room, hint.to.frameRate, hint.to.quality);

			// Down at once rather than at the next reading, which would see the
			// change and take it down anyway: a button that is pressed and then
			// sits there for two seconds reads as a button that did not work.
			// Left up if the change did not take, beside the notice that says so,
			// so the same press is there to try again.
			if (took) {
				if (watch.current) watch.current.showing = false;
				setHint(undefined);
			} else {
				actionFailed(t("That could not be changed. Try again."));
			}
		} finally {
			setBusy(false);
		}
	}, [busy, hint, room]);

	/** Put the question away until this share ends. */
	const decline = useCallback(() => {
		if (watch.current) {
			watch.current.dismissed = true;
			watch.current.showing = false;
		}
		setHint(undefined);
	}, []);

	return { hint, busy, accept, decline };
}

/** A stats field, where it is a number and not something else. */
function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
