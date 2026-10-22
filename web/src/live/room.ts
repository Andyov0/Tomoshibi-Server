import {
	type LocalTrackPublication,
	type Participant,
	Room,
	RoomEvent,
	type ScreenShareCaptureOptions,
	Track,
	type TrackPublishOptions,
	type VideoCodec,
	VideoPreset,
	VideoPresets,
} from "livekit-client";
import {
	MUSIC_CAPTURE,
	MUSIC_PUBLISH,
	listening,
	rememberedOriginal,
	voiceCapture,
	voicePublish,
} from "./sound";
import type { Join } from "./api";
import { installNoValidate } from "./novalidate";
import { seal, sealing } from "./secrecy";
import { keep, recall } from "@/lib/storage";

/**
 * What a screen share is, as two questions.
 *
 * How large a picture, and how many frames of it. They were one choice once and
 * that was wrong in both directions: asking for smooth motion also fixed the
 * resolution and the ceiling, and asking for a sharp picture fixed the frame
 * rate at thirty. They are independent — the size follows from the display, the
 * rate follows from what is on it — so they are asked separately, with the rates
 * a given size can actually carry.
 *
 * And an automatic setting, which is the only one that gives ground. Everything
 * else is somebody saying what they want and is sent at the ceiling for it.
 */
export const SHARE_QUALITIES = ["auto", "1080p", "1440p", "4k"] as const;
export type ShareQuality = (typeof SHARE_QUALITIES)[number];

export const SHARE_FRAME_RATES = [15, 30, 60, 120, 240] as const;
export type ShareFrameRate = (typeof SHARE_FRAME_RATES)[number];

/**
 * How many frames each size can be asked for.
 *
 * Ceilings rather than preferences, and they come from what an encoder can
 * actually do rather than from taste. Every rate below a size's ceiling is
 * offered, because a slow rate is always available: somebody sharing a page of
 * code at 4K wants fifteen frames and the sharpest possible picture, and
 * refusing them that would be refusing the better answer.
 *
 * What is not offered is a combination that cannot be delivered. 4K at 120
 * frames is a billion pixels a second; the encoder does not fail loudly, it
 * falls behind, and a share that drifts further behind the longer it runs is
 * worse than one that was never offered.
 */
const RATES_FOR: Record<Exclude<ShareQuality, "auto">, readonly ShareFrameRate[]> = {
	"1080p": [15, 30, 60, 120, 240],
	"1440p": [15, 30, 60, 120],
	"4k": [15, 30, 60],
};

/** The frame rates this size may be asked for. */
export function ratesFor(quality: ShareQuality): readonly ShareFrameRate[] {
	return quality === "auto" ? SHARE_FRAME_RATES : RATES_FOR[quality];
}

/** Whether a pairing is one this offers at all. */
export function offers(quality: ShareQuality, frameRate: ShareFrameRate): boolean {
	return ratesFor(quality).includes(frameRate);
}

interface Size {
	width: number;
	height: number;
}

const SIZES: Record<Exclude<ShareQuality, "auto">, Size> = {
	"1080p": { width: 1920, height: 1080 },
	"1440p": { width: 2560, height: 1440 },
	"4k": { width: 3840, height: 2160 },
};

/**
 * What automatic sends.
 *
 * A ceiling of 1440p at sixty, which is what most people get, because most
 * people never open this menu.
 *
 * It was 1080p at thirty, and both halves cost the person who never chose. The
 * size is a ceiling rather than a target, so a 1080p display was already
 * captured at its own size — but a 1440p or 4K display, which is most desks
 * now, had its screen reduced to 1080p before encoding and its text softened
 * for nothing. And thirty frames is visibly less smooth on anything that
 * scrolls or plays, for want of a setting nobody knew to change.
 *
 * It no longer gives ground either: like every other setting it holds the
 * picture and lets the frames bend, and it publishes one encode. The old
 * distinction — automatic adapts, named sizes do not — is gone, because
 * adapting meant quietly handing somebody a smaller picture than the one they
 * are trying to read.
 *
 * What is left of it is only this: automatic is a ceiling that suits any
 * display, and the named sizes are for somebody who has decided.
 */
const AUTOMATIC = { width: 2560, height: 1440, frameRate: 60 as ShareFrameRate };

/**
 * How many bits a picture of this size and rate is worth.
 *
 * About a fifth of a bit per pixel per frame — 0.22 — which is twice what H.264
 * needs for screen content on purpose. It was a tenth, chosen as what text and
 * flat colour cost at the moment a page scrolls, and it was raised on
 * 2026-09-07 together with the cap below, when the person sharing asked that
 * the picture never be trimmed and the asks go up rather than down. A ceiling is
 * not a target: a still page spends a fraction of it, and the extra is there for
 * the busy seconds. This comment went on saying "a tenth" for a month after the
 * number changed, which is how a reader comparing 1440p at 120's 48.7 Mb/s
 * against it concluded the arithmetic was wrong.
 *
 * Scaled with both dimensions rather than set per size, because the failure it
 * prevents is the same either way: four times the pixels at the same ceiling is
 * not a sharper picture but the same bitrate spread thinner, and eight times the
 * frames at the same ceiling is every frame getting an eighth of the data.
 *
 * Capped, because the curve keeps going and networks do not. 1080p at 240 and 4K
 * at 60 both land near the cap, which is the right place for them to land: past
 * it, the limit is not this number.
 */
const BITS_PER_PIXEL_PER_FRAME = 0.22;
const BITRATE_CAP = 80_000_000;
/*
 * There was a floor of eight megabits here, and it did nothing on the way in
 * and harm on the way out.
 *
 * Every size and rate the menu offers computes above it — the smallest,
 * 1080p at fifteen, is 9.68 Mb/s — so it never once raised a request. The only
 * place it bound was `settle`, whose entire job is handing back upload when the
 * capture turned out smaller than the request, and there it truncated the
 * refund: a shared 800x600 window is worth 2.24 Mb/s by the line below and was
 * given eight, and the ratio grows without bound as the window shrinks.
 *
 * Nothing that anybody chose can be lowered by removing it, because it was
 * never reached by anything anybody chose.
 */

/**
 * The frame rate the cost is measured against.
 *
 * Thirty, because that is what a screen share was before anybody offered more,
 * and so it is the rate the pixels-per-frame figure was chosen to be right at.
 */
const BASE_RATE = 30;

/**
 * The smaller copies of a share, beneath the one that was chosen.
 *
 * A share used to be published as a single encode, and the argument for that
 * was wrong in a way worth writing down, because it reads as sound and is not.
 * It said that simulcast divides the allowance between the layers, so a smaller
 * copy would be paid for out of the picture everybody is looking at. It does
 * not: `encodingsFromPresets` in the SDK hands the top layer the encoding it
 * was given and gives each smaller layer the bitrate its own preset names.
 *
 * What the single encode produced is the fault this exists for. A media server
 * holding one layer has two moves for a subscriber who cannot take it — forward
 * it anyway, or pause the track — and both are a black rectangle. Measured on a
 * live call: a room held a long way from half the people in it, the leg out of
 * it carrying two megabits a second with a tenth of the packets lost, and a
 * share asking thirty-eight. The share did not soften. It disappeared, while the
 * audio went on perfectly, which is why it was reported as the sharing being
 * broken rather than as a slow network.
 *
 * ## Why these
 *
 * They were 640x360 at half a megabit and fifteen frames and 1280x720 at two and
 * a half and thirty, and the gap above them was the next fault. The top of a
 * share asks 34 to 49 Mb/s, fourteen to nineteen times the rung beneath it, so
 * anybody whose line carried less than the whole share — a hotel's Wi-Fi at
 * twenty, two of somebody's own devices watching on one line — was handed 720p
 * at best and read blurred type. And the way back up meant the server proving
 * thirty-odd megabits of headroom, which it almost never could: it swung between
 * the two, waiting for a keyframe at every swing, and that is the share that
 * "jumps to 360p every so often" (2026-10-13). Measured locally, with the server
 * estimating from the sender's side: a 1080p rung at eight to nine megabits held
 * thirty frames on 20 to 30 Mb/s downlinks where the old ladder fell to 720p at
 * fifteen.
 *
 * So, as the owner chose that evening and settled the day after (2026-10-14):
 *
 *   - 1280x720 at 2.5 Mb/s and thirty frames, for a small picture and a short
 *     line. For a day it was 1.5 and fifteen, and under moving content that
 *     came out at six to eleven frames a second — which, for two sessions
 *     sharing a 20 Mb/s line that lost 3%, was all either of them received for
 *     the whole minute measured. At 2.5 the same busy test picture went out at
 *     seventeen.
 *   - 1920x1080 at sixty frames when the share itself is sent at sixty or more,
 *     at 11.3 Mb/s — eight priced up for the extra frames by the top layer's
 *     own curve (`forRate`) — and at thirty and 8 Mb/s otherwise. At thirty for
 *     everybody, the rung made a sixty-frame share half as smooth for whoever
 *     watched it in an ordinary window: a 2560x1440 window whose picture covers
 *     1925x1083 device pixels is sent this rung rather than the original, and
 *     it received thirty frames where the day before it had received sixty.
 *     Sixty rather than the share's own 120 or 240, because the rung is for a
 *     line that cannot carry the original, and at 120 it would ask sixteen.
 *   - The original on top, exactly as chosen.
 *
 * Which one somebody receives follows from the device pixels their picture
 * covers (see `create`), and below that from the server's estimate of their
 * line. The server takes the smallest layer at least nine tenths as tall as
 * what was asked for (livekit-server mediatrackreceiver.go:1117), so 720 serves
 * a picture up to 800 device pixels tall, 1080 one up to 1200, and anything
 * larger — a stage on most screens, and full screen on every one — is sent the
 * original.
 *
 * A rung that is not smaller than the capture is not published at all; see
 * `rungsBeneath`.
 *
 * ## What they cost the person sharing
 *
 * Up to 13.8 Mb/s whenever anybody is watching a share sent at sixty or more at
 * full size, and up to 10.5 at fewer frames: 10.8 and 7.5 more than the three of
 * the ladder before 2026-10-13, which the owner accepted knowingly on 2026-10-14
 * — and the mechanism is worth stating exactly, because this paragraph said the
 * opposite for a while.
 *
 * dynacast does pause rungs nobody has asked for — but it enables a *prefix*,
 * not a set. The server reduces every subscriber's demand to one number and
 * sends `Enabled: q <= quality` for LOW, MEDIUM and HIGH together
 * (dynacastmanagervideo.go:249-255, the maximum taken in
 * dynacastqualityvideo.go:194-204), and the publisher applies it verbatim. There
 * is no way for the server to say "the top one only". So one viewer on a full
 * stage turns on all three, and the case where a single encode goes out is
 * everybody watching *small* — the reverse of what was written here.
 *
 * The cost is a constant rather than a proportion: SMALL and MIDDLE name their
 * own bitrates and `encodingsFromPresets` copies them verbatim, whatever the top
 * layer is set to. Those are ceilings, and what goes out is near them on a busy
 * picture. Measured on a 1440p share at sixty with one viewer at full size
 * (Chrome 145, 2026-10-14, a synthetic picture busy in every frame): the
 * original 33.9 Mb/s at sixty frames, the 1080p rung 8.4 at 58 — Chrome allots
 * a lower layer three quarters of its ceiling while the top is on — and the
 * 720p rung 2.5 at seventeen, its frames held down by its ceiling on content
 * that busy. 10.8 for the two rungs, where the ladder of 2026-10-13 measured
 * 7.4 the same way. With the 1080p rung the most anybody wanted — an ordinary
 * window — Chrome gave it its whole 11.3, and the viewer received 57 frames a
 * second where on 2026-10-13 it had received thirty.
 *
 * And it is not free on a short uplink. Chrome's simulcast allocator fills the
 * layers from the bottom, so a line that cannot carry all three gives the
 * original whatever the rungs leave; for somebody whose line was already short
 * of the original, the original gets up to 10.8 Mb/s less than it did before
 * 2026-10-13. Nobody's choice is changed by this, and the hint in
 * live/strain.ts counts the rungs as part of what the share asks of the line.
 *
 * It is paid once, not once per viewer. That was measured on the old ladder and
 * nothing about it depends on the sizes: one viewer 21.8 Mb/s, five 22.3, ten
 * 22.3.
 *
 * The sizes are absolute rather than relative — `scaleResolutionDownBy` is
 * worked out from the capture's smaller dimension — so these come out 1280x720
 * and 1920x1080 whether the screen behind them is 1440p or 4K.
 */
export const SMALL = new VideoPreset(1280, 720, 2_500_000, 30);
export const MIDDLE = new VideoPreset(1920, 1080, 8_000_000, 30);

/** The share's rate at and above which its middle rung is sent at sixty. */
const FAST = 60;

/** The middle rung of a share sent at sixty frames or more. See SMALL and MIDDLE. */
export const MIDDLE_FAST = new VideoPreset(1920, 1080, Math.round(forRate(MIDDLE.encoding.maxBitrate, FAST)), FAST);

/**
 * What can go beneath the top layer of a share sent at `frameRate`, smallest
 * first — the order the SDK sorts presets into, by bitrate, and therefore the
 * order the encodings come back in.
 *
 * `frameRate` is what the top layer is sent at: the setting's, or the
 * capture's where the capture says it gives fewer. A display that gives thirty
 * to a share set to sixty has thirty frames for every layer, and a middle rung
 * priced for sixty would be eleven megabits of ceiling for eight megabits'
 * worth of picture.
 */
export function ladderAt(frameRate: number): VideoPreset[] {
	return [SMALL, frameRate >= FAST ? MIDDLE_FAST : MIDDLE];
}

/**
 * The rungs a capture of this size is published with: those smaller than it.
 *
 * A rung that is not smaller is a copy of the original. The SDK works a rung's
 * scale out as the capture's shorter side over the rung's and stops at one, so
 * a 1080p display shared at 1080p would carry the middle rung at 1920x1080 —
 * the same picture as the top, at eleven megabits where the top might be
 * nineteen, both at sixty. Whenever anybody watched at full size, dynacast's
 * prefix would turn it on and the person sharing would pay for it, for nothing.
 * A 1080p capture is therefore published with SMALL alone, and a window of 720
 * lines or less with no rung at all.
 *
 * Measured against the shorter side, as the SDK scales: a window taller than it
 * is wide is still 720 across at its smallest.
 *
 * Decided once, from the capture as it is when the share is published, because
 * the number of encodings cannot change without publishing again. That has a
 * consequence in each direction, and both are accepted rather than overlooked:
 *
 *   - Smaller afterwards — from the menu, or by the hint — keeps the rungs it
 *     was published with, and one that is no longer smaller than the picture
 *     goes on as a cheaper copy of it until the share is restarted.
 *   - Larger afterwards has no rung it was not published with. A share that
 *     started at 1080 lines or less — the menu remembering 1080p, a 1600x900
 *     window — and is then set to automatic or 1440p, or has its window
 *     maximised, is the original over SMALL alone: 720p at 2.5 Mb/s and then
 *     everything, with no 1080p between, which is the gap the ladder of
 *     2026-10-13 exists to close. A viewer on a 20 to 30 Mb/s line gets 720p,
 *     and live/freeze.ts can only step them from the original straight to it.
 *     Found in review on 2026-10-14; the way out is to stop and start the
 *     share at the larger size, which publishes it with both rungs.
 *
 * Publishing again from here would drop every viewer's picture for a keyframe
 * and change the track under them — their pin, their freeze watch, their
 * subscription — at the moment somebody adjusted a setting, which is a worse
 * trade than either of the two above.
 *
 * The frame rate is not decided once. Which middle rung a share carries follows
 * the rate it is sent at, and that can change mid-share without publishing
 * again: an encoding's bitrate and rate are parameters, and `retune` writes
 * them.
 *
 * Every rung, when the capture will not say how large it is: the SDK scales none
 * of them above the capture either way.
 */
export function rungsBeneath(capture: Capture, frameRate: number): VideoPreset[] {
	const ladder = ladderAt(sentAt(capture, frameRate));
	const shorter = Math.min(capture.width ?? 0, capture.height ?? 0);
	if (!shorter) return ladder;

	return ladder.filter((rung) => Math.min(rung.width, rung.height) < shorter);
}

/**
 * The rate a share's top layer goes out at: the setting's, or fewer where the
 * capture says it gives fewer — never more, by the rule `settle` keeps.
 */
function sentAt(capture: Capture, frameRate: number): number {
	return Math.min(capture.frameRate || frameRate, frameRate);
}

/**
 * What to ask for, given a size and a rate.
 *
 * The rate counts for far less than the size, and the first version had them
 * counting the same. Multiplying by frames a second assumes each frame costs
 * what the first one did, which is true of a camera pointed at a room and
 * emphatically false of a screen: at a hundred and twenty frames a second, one
 * frame differs from the last by a moved cursor and a line of text, and a codec
 * spends almost nothing on it.
 *
 * So the rate enters under a square root — doubling it costs about forty per
 * cent more rather than twice as much, which is roughly what encoders actually
 * do with this material. Linear, the high settings asked for forty-four and
 * fifty megabits a second, which no ordinary path carries: the estimator finds
 * out, clamps hard, and the encoder answers by dropping frames. That arrives as
 * a share that stutters while the throughput reading looks entirely healthy,
 * which is exactly the complaint this is here to answer.
 */
function bitrateFor(width: number, height: number, frameRate: number): number {
	const perFrame = width * height * BITS_PER_PIXEL_PER_FRAME;
	const wanted = forRate(perFrame * BASE_RATE, frameRate);

	return Math.round(Math.min(BITRATE_CAP, wanted));
}

/**
 * What a picture worth `atBase` at thirty frames is worth at `frameRate`: the
 * square root above, on its own, so that the middle rung's sixty is priced by
 * the same curve as the top layer's. Two copies of it would be two curves the
 * first time one of them changed.
 */
function forRate(atBase: number, frameRate: number): number {
	return atBase * Math.sqrt(frameRate / BASE_RATE);
}

/**
 * What to send, given both choices.
 *
 * H.264 throughout. It has hardware encoding on essentially every machine, and
 * above 1080p or above thirty frames the alternative is not a softer picture
 * but an encoder falling behind — which arrives as a share that stutters and
 * drifts, and never announces itself.
 *
 * VP8 used to be kept for 1080p at fifteen or thirty, because it honours the
 * `text` content hint and a hardware H.264 encoder tuned for faces makes small
 * type the first thing to go soft. It is not any more, and this paragraph said
 * it still was for long enough to be worth correcting rather than deleting: a
 * comment describing a branch that is not there sends the next reader looking
 * for it.
 *
 * Nothing here is a promise. The heights are what the browser is asked to
 * capture: a smaller display gives its own size, and a machine that cannot
 * encode what it captured will scale down on its own.
 */
export function settingsForTest(frameRate: ShareFrameRate, quality: ShareQuality) {
	return settingsFor(frameRate, quality);
}

/** Both choices together, the way a share is started and changed. */
export interface ShareSetting {
	quality: ShareQuality;
	frameRate: ShareFrameRate;
}

/** What a capture turned out to be, as far as anything has said. */
export interface Capture {
	width?: number;
	height?: number;
	frameRate?: number;
}

/**
 * The ceiling a setting comes to against a capture, by the arithmetic `retune`
 * applies.
 *
 * Shared rather than repeated, because the one other thing that asks this
 * question — live/strain.ts, which checks whether a setting would fit a line
 * before offering it — is only right while it gets the answer retune will get.
 * Two copies of a formula are two formulas the first time one of them changes.
 *
 * The capture is clamped to the setting's size before it is priced, which is
 * what applyConstraints does to it on the way in: a 4K display stepped down to
 * 1080p is captured at 1080p, and a 1080p display chosen at 1440p stays 1080p.
 */
export function askOf(setting: ShareSetting, capture: Capture = {}): number {
	const profile = settingsFor(setting.frameRate, setting.quality);

	return worthOf(profile, {
		width: Math.min(capture.width ?? profile.width, profile.width),
		height: Math.min(capture.height ?? profile.height, profile.height),
		frameRate: capture.frameRate,
	});
}

/** The ceiling for a profile against what the capture says it is. Downward only. */
function worthOf(profile: ReturnType<typeof settingsFor>, settled: Capture): number {
	const rate = sentAt(settled, profile.frameRate);

	return Math.min(
		profile.maxBitrate,
		bitrateFor(settled.width ?? profile.width, settled.height ?? profile.height, rate),
	);
}

/** The picture a setting asks the capture for; automatic asks for what it sends. */
export function sizeOf(quality: ShareQuality): Size {
	return quality === "auto" ? { width: AUTOMATIC.width, height: AUTOMATIC.height } : SIZES[quality];
}

/**
 * Every setting the menu offers that asks for less than this one in both
 * directions: never a larger picture and never more frames.
 *
 * Largest first, and within a size the most frames first, so that a caller
 * taking the first of several equal answers takes the one nearest to what was
 * chosen. Automatic is never among them — it is not a smaller thing, it is a
 * different question — and counts as what it sends, 1440p at sixty.
 */
export function stepsDown(from: ShareSetting): ShareSetting[] {
	const top =
		from.quality === "auto"
			? { width: AUTOMATIC.width, height: AUTOMATIC.height, frameRate: AUTOMATIC.frameRate }
			: { ...SIZES[from.quality], frameRate: from.frameRate };

	const steps: ShareSetting[] = [];
	const named = (Object.keys(SIZES) as Exclude<ShareQuality, "auto">[]).sort(
		(a, b) => SIZES[b].width * SIZES[b].height - SIZES[a].width * SIZES[a].height,
	);

	for (const quality of named) {
		const size = SIZES[quality];
		if (size.width > top.width || size.height > top.height) continue;

		for (const frameRate of [...RATES_FOR[quality]].sort((a, b) => b - a)) {
			if (frameRate > top.frameRate) continue;
			if (quality === from.quality && frameRate === from.frameRate) continue;

			steps.push({ quality, frameRate });
		}
	}

	return steps;
}

function settingsFor(frameRate: ShareFrameRate, quality: ShareQuality) {
	if (quality === "auto") {
		return {
			...AUTOMATIC,
			frameRate: AUTOMATIC.frameRate,
			maxBitrate: bitrateFor(AUTOMATIC.width, AUTOMATIC.height, AUTOMATIC.frameRate),
			videoCodec: "h264" as VideoCodec,
			contentHint: "detail" as const,
			// Nothing gives up the picture, here or anywhere else. A share is
			// read rather than watched: a frame that arrives late is late, and
			// a line of type scaled to two thirds of its size is unreadable and
			// nobody at the other end can undo it.
			degradationPreference: "maintain-resolution" as RTCDegradationPreference,
			adapts: false,
		};
	}

	const size = SIZES[quality];

	// Clamped rather than refused. A rate remembered from a larger allowance —
	// 240 chosen at 1080p and then 4K picked — would otherwise be sent to an
	// encoder that cannot do it, and the failure is silent.
	const rates = RATES_FOR[quality];
	const capped = rates.includes(frameRate) ? frameRate : (rates[rates.length - 1] ?? 30);

	const still = capped <= 30;

	return {
		...size,
		frameRate: capped,
		maxBitrate: bitrateFor(size.width, size.height, capped),
		// H.264 throughout, including the still picture that used to take VP8.
		//
		// VP8 was kept for still text because libvpx honours the `text` content
		// hint with a screen-content mode that a hardware H.264 encoder tuned for
		// faces does not have. It was not, as this said for a while, because VP8
		// skips chroma subsampling: it is 4:2:0 exactly as H.264 is (RFC 6386
		// section 2), so coloured letters soften the same in both. And VP8 is
		// software on essentially every machine, both to encode and to decode. A
		// share is the one track in a call that everybody is looking at, so the
		// cost lands on one person's processor and on everybody else's too.
		videoCodec: "h264" as VideoCodec,
		contentHint: (still ? "text" : "motion") as "text" | "motion" | "detail",
		/*
		 * What gives, where something must: frames, never the picture.
		 *
		 * This used to turn on the rate — the picture held below thirty frames
		 * and given away above it, on the reasoning that somebody who asked for a
		 * high rate asked for the frames. That is right about a camera and wrong
		 * about a screen. What is on a shared screen is text, code and diagrams,
		 * and the two failures are not comparable: a late frame is late, and type
		 * that has been scaled away is gone.
		 */
		degradationPreference: "maintain-resolution" as RTCDegradationPreference,
		adapts: false,
	};
}

/**
 * Whether this is a device that runs on a battery and draws its pictures small.
 *
 * Asked of the pointer rather than of the user agent string. What matters is
 * whether there is a mouse — a machine somebody points at with a finger is a
 * machine with a small screen, a modest encoder and a battery, and all three
 * want the same answer. The user agent would name the operating system, which is
 * a different question with a well-known history of wrong answers.
 */
function handheld(): boolean {
	return (
		typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
	);
}

/**
 * Build the room.
 *
 * Adaptive streaming and dynacast are both on, and together they are the reason
 * a busy meeting does not cost what it looks like it should: adaptive streaming
 * drops the quality of a track to what its tile actually needs, and dynacast
 * stops the publisher encoding a layer nobody is watching. The second one is
 * paid for by whoever is sending, which is the side with the least bandwidth to
 * spare.
 */
/**
 * A room, ready to connect.
 *
 * `secret` is required rather than defaulted, and empty is how a call says it
 * is not sealed. A default would make forgetting to pass it compile — and what
 * forgetting produces is a call somebody was told is encrypted and is not,
 * which is the one failure here that must not be quiet.
 */
export function create(secret: string): Room {
	// Before anything can connect, because the request it removes is made by
	// the SDK during a failed connection and there is no later moment to do
	// it in.
	installNoValidate();

	const room = new Room({
		// Measured against the screen's own pixels rather than the layout's.
		//
		// The quality a tile asks for is its size multiplied by a pixel density,
		// and left unset that density is one on any display denser than the
		// layout but not by more than double — which is every ordinary retina
		// laptop. A stage twelve hundred points wide would therefore ask for
		// twelve hundred pixels and be sent a layer built for it, then paint it
		// across twenty-four hundred. The picture was never sharp because the
		// sharp one was never requested: a shared screen at full resolution
		// needed a stage wider than most people's entire display.
		//
		// The cost is bandwidth, and it buys back the thing the bandwidth was
		// being spent on in the first place.
		//
		// A shared screen is measured this way too, and for a month it was not.
		// live/sharpness.ts held every share at its source size with an element
		// of its own that was always visible and always as large as the
		// capture, so every viewer asked for the original whatever their picture
		// covered: measured, a 1440p share reached a 1000x700 window and a phone
		// held upright at 34 Mb/s each, and two devices on one line asked for
		// it twice. (A share shrunk to its card was never among them: the card
		// has no picture, and the library unsubscribes a picture it unmounts.)
		// The owner chose the opposite on
		// 2026-10-13: a share is asked for at the device pixels it covers, a
		// share nobody can see is paused, and a stage enlarged or taken full
		// screen asks for the original again, through the measurement alone.
		// SurfaceTile fits a share's element to its picture so that what is
		// measured is the picture rather than the bars beside it. The two
		// enlargements the measurement cannot see — a pinch, and a window moved
		// to a denser display, neither of which resizes anything — are
		// live/lens.ts.
		adaptiveStream: { pixelDensity: "screen" },
		dynacast: true,
		videoCaptureDefaults: {
			// Smaller on a hand-held, and not as a concession to the network.
			//
			// A phone in a nine-up grid is drawn at a couple of hundred points
			// however large it was captured, so the pixels above that are encoded,
			// sent and thrown away — on the one device paying for all three out of
			// a battery. The camera on the front of a phone is also rarely worth
			// 720 lines of anybody's attention.
			resolution: handheld() ? VideoPresets.h360.resolution : VideoPresets.h720.resolution,
		},
		publishDefaults: {
			/*
			 * H.264, which is the one codec every machine encodes and decodes in
			 * hardware.
			 *
			 * This was VP9, for its layering: one stream carrying three spatial
			 * and three temporal layers, so a tile in a nine-up grid is served
			 * something sized for a nine-up grid. That is the better shape and it
			 * is paid for in silicon nobody has — VP9 encode is software almost
			 * everywhere, and VP9 decode is software on a great many phones. In a
			 * call of six, every participant was software-decoding five streams.
			 *
			 * Simulcast gets the same result the older way: three encodes instead
			 * of one layered stream, each of them on hardware. More upstream
			 * bandwidth from whoever is publishing, and far less work everywhere —
			 * which is the trade worth making on the devices that struggle, and
			 * they are the only ones where any of this is noticeable.
			 */
			videoCodec: "h264",
			simulcast: true,

			/*
			 * No second encode in another codec.
			 *
			 * The SDK's default is `backupCodec: true`, which on an unsealed call
			 * means this: the moment one subscriber turns up whose browser cannot
			 * decode H.264, the media server asks for VP8 and the publisher
			 * starts a *whole second encode of the same picture* — at the same
			 * maxBitrate and maxFramerate it was already sending, with simulcast
			 * forced off, in software. One person joining roughly doubles what
			 * the person sharing has to upload, and nothing anywhere says so.
			 *
			 * That is the one cost this deployment cannot pay. The connections
			 * that matter here are the constrained ones; they are the scarce
			 * thing in every call, and the whole point of the layer ladder above
			 * is that the distribution burden sits on the server rather than on
			 * them.
			 *
			 * What it costs to turn off: a browser with no H.264 at all sees no
			 * video from this publisher. Every current browser has it, on every
			 * platform this is used from, and the ones that do not would be
			 * paying for it out of somebody else's upload rather than their own.
			 */
			backupCodec: false,

			// How a microphone is sent. The SDK's own defaults were what every
			// call ran on until this was set; see live/sound.ts for what they
			// were and what each of these replaces.
			...voicePublish(rememberedOriginal()),
		},
		audioCaptureDefaults: voiceCapture(rememberedOriginal()),
		// Speaking is worked out by the media server and pushed to everybody, so
		// no client has to run an analyser of its own.
		disconnectOnPageLeave: true,

		// Media the relay cannot read, where somebody asked for it and the
		// browser can do it. Undefined otherwise, and a room built without it is
		// the room this always built.
		//
		// Given to the constructor rather than turned on afterwards, because the
		// SDK builds its transports around it: a room that starts unencrypted
		// cannot become encrypted without reconnecting, and half a call is not a
		// state worth being able to reach.
		e2ee: sealing(secret),
	});

	// For as long as the room lives, so that no reconnect can find it unwatched.
	keepShareSetting(room);

	return room;
}

/**
 * Connect.
 *
 * The display name is already in the token, so there is nothing to set
 * afterwards. Setting it here would need a permission this grant deliberately
 * withholds, and the server would refuse.
 */
/**
 * The token each connected room was authorised with.
 *
 * Kept here because the host's own requests need it — it is the only thing that
 * proves, without a session, which room and which identity they are — and
 * because the SDK's copy is a private field. Private is not a runtime guarantee
 * and reading it would work, right up until a minified build renamed it and the
 * host controls stopped authorising with no error anywhere that says why.
 *
 * A WeakMap rather than a field on the room, so nothing here keeps a disconnected
 * room alive and so the token goes when the room does.
 */
const tokens = new WeakMap<Room, string>();

/** The token a room was joined with, for the requests that have to prove it. */
export function tokenFor(room: Room): string {
	return tokens.get(room) ?? "";
}

export async function connect(room: Room, grant: Join, secret: string): Promise<void> {
	tokens.set(room, grant.token);

	// The key before the connection, and encryption on before anything is
	// published.
	//
	// Before, because a track published while this is still off goes out in
	// clear and the machines carrying it have already seen it — turning it on a
	// moment later does not take that back. Nothing here is published until
	// after connect returns, so this is the last moment that is still early
	// enough.
	if (secret && sealing(secret)) {
		await seal(grant.room, secret);
		await room.setE2EEEnabled(true);
	}

	if (!grant.forward) {
		await room.connect(grant.url, grant.token);
		return;
	}

	/*
	 * Media through the relay that was picked, rather than past it.
	 *
	 * The server sends this only when the room is being held on a different
	 * machine from the one this client chose. Left alone the browser would
	 * gather its own candidates and connect straight to the holder, so the
	 * chosen relay would carry the signalling and none of the call — which is
	 * the same as not having chosen.
	 *
	 * `relay` is the whole of it. Offering the relay alongside the direct route
	 * would mean the browser tries both and keeps whichever answers first, and
	 * the direct one always answers first: the setting would appear to work,
	 * change nothing, and be very hard to argue with afterwards.
	 *
	 * The server's own list is replaced rather than added to, which the SDK
	 * allows explicitly — it fills in the servers from the join response only
	 * when none were given here. Read out of `livekit-client.esm.mjs`, because
	 * this is the kind of thing a release note does not mention and a call
	 * failing to connect does not explain.
	 */
	await room.connect(grant.url, grant.token, {
		rtcConfig: {
			iceServers: [
				{
					urls: grant.forward.url,
					username: grant.forward.username,
					credential: grant.forward.credential,
				},
			],
			iceTransportPolicy: "relay",
		},
	});
}

/**
 * Everybody in the room, ourselves included and first.
 *
 * Ourselves first because the self view belongs on the first page: losing sight
 * of your own camera because the room got busy is disorienting, and it costs
 * nothing since it renders from the local capture.
 */
export function roster(room: Room): Participant[] {
	return [room.localParticipant, ...room.remoteParticipants.values()];
}

/** Events that change what the layout should show. */
export const ROSTER_EVENTS = [
	RoomEvent.ParticipantConnected,
	RoomEvent.ParticipantDisconnected,
	RoomEvent.TrackPublished,
	RoomEvent.TrackUnpublished,
	RoomEvent.TrackSubscribed,
	RoomEvent.TrackUnsubscribed,
	RoomEvent.TrackMuted,
	RoomEvent.TrackUnmuted,
	RoomEvent.LocalTrackPublished,
	RoomEvent.LocalTrackUnpublished,
	RoomEvent.ParticipantNameChanged,
	RoomEvent.ActiveSpeakersChanged,
	RoomEvent.ConnectionStateChanged,
] as const;

/**
 * Start or stop sharing the screen.
 *
 * Separate from the camera rather than replacing it, so both can be on at once,
 * which is the whole point of treating pictures rather than people as the unit
 * of layout. Audio comes along because a shared video with no sound is a common
 * and confusing failure.
 */
export async function share(
	room: Room,
	wanted: boolean,
	frameRate: ShareFrameRate,
	quality: ShareQuality = "auto",
): Promise<LocalTrackPublication | undefined> {
	const profile = settingsFor(frameRate, quality);

	// A share's sound goes alongside a picture unless sound is already being
	// shared on its own, which carries on and is not doubled.
	const alongside = wanted && listening(room) === undefined;

	const capture: ScreenShareCaptureOptions = {
		// Captured and sent as music rather than as a voice: stereo, with none
		// of the processing that helps a voice and damages everything else.
		// Left to the defaults, a shared video's soundtrack was folded to mono,
		// gated by DTX and run through noise suppression.
		audio: alongside ? MUSIC_CAPTURE : false,
		/*
		 * The capture, in the one shape the SDK will pass on.
		 *
		 * This has been wrong twice, in opposite directions, and both times
		 * the symptom was the same: every share came out at thirty frames a
		 * second whatever the menu said, and nothing anywhere reported it.
		 *
		 * The first version wrote media constraints into `resolution` —
		 * `{ width: { max: 1920 } }` — so that the size would be a ceiling,
		 * with a cast to make it compile. `resolution` is a VideoResolution,
		 * three plain numbers, and the SDK gates the whole block on
		 * `resolution.width > 0`. An object is not greater than zero, so
		 * every constraint was dropped and the browser was asked for
		 * `video: true`.
		 *
		 * The second version moved them to `video`, which is passed through
		 * untouched — and that is worse, because of this, in
		 * createScreenTracks:
		 *
		 *     if (options.resolution === undefined && !isSafari17Based())
		 *       options.resolution = ScreenSharePresets.h1080fps30.resolution
		 *
		 * Leaving `resolution` out does not mean "no resolution". It means
		 * 1920x1080 at thirty, which is then written over the `video`
		 * constraints by the Object.assign below it. Omitting the field is
		 * how a browser is asked for thirty frames on purpose.
		 *
		 * So: the SDK's own shape, always present, with the numbers this file
		 * chose. The rate arrives intact, which is the whole point.
		 *
		 * What is given up is the size as a ceiling. The SDK writes
		 * `width: { ideal }` for everything but Safari 17, ideal is a target,
		 * and there is no way to say ceiling through a field that is three
		 * numbers. So somebody on a 1080p display who picks 1440p has their
		 * screen scaled up before it is encoded — more pixels carrying
		 * nothing, at the same bitrate ceiling, so it costs processor and not
		 * upload.
		 *
		 * That was clamped for a while, to `screen.width` — and the clamp was
		 * worse than the thing it fixed. `screen` describes the display the
		 * browser window is on, not the surface the picker returns, so
		 * somebody with a laptop and a 4K monitor who chose 4K and shared the
		 * monitor was given 1080p of it. Losing a picture the person asked
		 * for is a worse trade than spending some of their processor on one
		 * they did not, and it was invisible from both ends. `settle` below
		 * takes the other half of the problem: the ceiling follows the
		 * picture that actually arrived.
		 *
		 * The rate is the clamped one, not what was asked for — a rate
		 * remembered from a size that allowed it would otherwise reach a
		 * capture that cannot do it, and the browser answers by giving
		 * whatever it likes rather than by saying no.
		 */
		resolution: {
			width: profile.width,
			height: profile.height,
			frameRate: profile.frameRate,
		},
		// The picker should not offer this tab, which would be a mirror tunnel.
		selfBrowserSurface: "exclude",
		surfaceSwitching: "include",
		contentHint: profile.contentHint,
	};

	// Given per share rather than left to the room's defaults, which is what
	// keeps the camera out of this: it goes on being sent the way it always
	// was, and only the screen follows the choice made about the screen.
	//
	// This is also where the frame rate finally arrives. Asking the browser to
	// capture sixty means nothing on its own — the encoder has a ceiling of
	// its own, and while it stayed at thirty the second option cost a person
	// twice the capture work to send exactly what the first one sent.
	const publishing = (captured: Capture): TrackPublishOptions => ({
		screenShareEncoding: {
			maxBitrate: profile.maxBitrate,
			maxFramerate: profile.frameRate,
		},
		videoCodec: profile.videoCodec,
		degradationPreference: profile.degradationPreference,

		// The whole allowance in the top layer, and a ladder beneath it.
		//
		// Nothing above is reduced by this: the layer everybody able to take
		// it receives is exactly the one `screenShareEncoding` asks for, and
		// dynacast pauses the rungs nobody has asked for. What they change is
		// the answer given to somebody who cannot take the top one — which
		// was nothing at all. See SMALL and MIDDLE for the measurement that
		// prompted them and for why the SDK's own default layer is neither.
		//
		// An empty list rather than none for a capture too small for any
		// rung: the SDK reads a missing list as "use mine" and adds its own.
		simulcast: true,
		screenShareSimulcastLayers: rungsBeneath(captured, profile.frameRate),

		// For the sound that comes with the picture; the picture ignores these.
		...MUSIC_PUBLISH,
	});

	const published = wanted ? await start(room, capture, publishing) : await stop(room);

	/*
	 * Nothing below this narrows what was just asked for.
	 *
	 * There was a follower. It read the sender's statistics every four seconds
	 * and halved its own ceiling whenever it judged the share to be struggling,
	 * down to a floor of 1.2 Mb/s — a fifth of what an ordinary share asks —
	 * and wrote that number to local storage, where it became the opening
	 * ceiling for every later share on every later network, climbing back at an
	 * eighth per twelve seconds. Two things were wrong with it, and both were
	 * silent. It read a low frame count as evidence of trouble, and a screen
	 * that is not changing sends almost no frames by design, so a still screen
	 * with a handful of retransmissions was indistinguishable from a congested
	 * one. And nothing ever expired what it remembered, so one bad afternoon
	 * set the ceiling for good.
	 *
	 * It is gone rather than mended. The browser runs a congestion controller
	 * of its own that measures the path continuously and is not working from
	 * four-second summaries; a second one layered on top of it could only ever
	 * subtract. What the path will carry is the browser's question. What the
	 * share is worth is this file's, and it is answered upward.
	 *
	 * `settle` below is not that, and the difference is worth being precise
	 * about: it never reads the network. It asks the capture what size it turned
	 * out to be and makes the ceiling match, which is the same arithmetic
	 * bitrateFor already does — done once, against the picture that arrived
	 * rather than the one that was requested.
	 */

	await settle(published, profile);

	// Automatic keeps the rate it was handed rather than the sixty it sends,
	// because that is the rate the menu goes back to if somebody picks a size
	// mid-share; the price of automatic does not depend on it either way.
	if (!wanted) {
		capturing.delete(room);
		record(room, undefined);
	} else if (published) {
		capturing.set(room, published.videoTrack);
		record(room, { quality, frameRate: quality === "auto" ? frameRate : (profile.frameRate as ShareFrameRate) }, true);
	}

	return published;
}

/**
 * A share being started, for each room, so that a second press or a stop does
 * not race it.
 */
const starting = new WeakMap<Room, Promise<LocalTrackPublication | undefined>>();

/**
 * Capture the screen, then publish it with the rungs that capture can carry.
 *
 * Two steps rather than `setScreenShareEnabled`, which captures and publishes in
 * one call and reads the rungs before anything outside it can know how large
 * the capture is: the picker is where somebody chooses a 4K monitor or an
 * 800x600 window, and which rungs are smaller than the picture depends entirely
 * on which. `createScreenTracks` and `publishTrack` are the two halves that call
 * makes (livekit-client.esm.mjs, setTrackEnabled), so what is captured and how
 * it is published are exactly what they were; the capture's size is simply read
 * in between.
 *
 * What the one call also did is done here. A share already published is
 * returned as it is, as the SDK returns it, rather than captured twice; a start
 * already under way is joined rather than raced, which is what the SDK's
 * pending set was for; and a publish that fails stops what was captured, so a
 * refused share does not leave the browser's "sharing this screen" bar up over
 * nothing.
 */
async function start(
	room: Room,
	capture: ScreenShareCaptureOptions,
	publishing: (captured: Capture) => TrackPublishOptions,
): Promise<LocalTrackPublication | undefined> {
	const participant = room.localParticipant;

	const already = participant.getTrackPublication(Track.Source.ScreenShare);
	if (already) return already;

	const under = starting.get(room);
	if (under) return under;

	const going = (async () => {
		const tracks = await participant.createScreenTracks(capture);
		const picture = tracks.find((track) => track.kind === Track.Kind.Video);
		const options = publishing(picture?.mediaStreamTrack.getSettings() ?? {});

		try {
			const published = await Promise.all(tracks.map((track) => participant.publishTrack(track, options)));
			return published.find((publication) => publication.source === Track.Source.ScreenShare);
		} catch (err) {
			for (const track of tracks) track.stop();
			throw err;
		}
	})();

	starting.set(room, going);
	try {
		return await going;
	} finally {
		starting.delete(room);
	}
}

/**
 * Stop sharing, after any start still under way has finished.
 *
 * Otherwise a stop pressed while the picker is open finds nothing to stop, and
 * the share the picker then returns goes out under a menu that says it ended.
 */
async function stop(room: Room): Promise<LocalTrackPublication | undefined> {
	await starting.get(room)?.catch(() => undefined);
	return room.localParticipant.setScreenShareEnabled(false);
}

/**
 * Make the ceiling match the picture that actually arrived.
 *
 * What a share is worth is worked out from the size that was chosen, and the
 * size that was chosen is a request. A window is smaller than a screen; a
 * display is whatever it is; and `width: { ideal }` is a target the browser is
 * free to miss in either direction. So the number reaching the encoder was
 * computed for a picture nobody was necessarily sending — generous where the
 * capture came back small, which is upload spent on nothing, and that upload is
 * the scarcest thing in these calls.
 *
 * Only downward, and only the top layer. Raising it would be this file arguing
 * with the setting somebody chose, and the rungs below already follow the
 * capture through `scaleResolutionDownBy`.
 *
 * Nothing anybody sees changes. `maxBitrate` is a ceiling: lowering it to what
 * the picture is worth cannot reduce the resolution or the frame rate that
 * reaches a viewer, and `maintain-resolution` is untouched. What it returns is
 * upload that was reserved for a picture nobody was sending.
 *
 * Failures are swallowed. A ceiling that is too generous is what this deployment
 * had for its whole life; a share that will not start because a parameter write
 * was refused is worse than one that costs a little too much.
 */
async function settle(
	published: LocalTrackPublication | undefined,
	profile: ReturnType<typeof settingsFor>,
): Promise<void> {
	const sender = published?.videoTrack?.sender;
	const track = published?.videoTrack?.mediaStreamTrack;

	if (!sender || !track) return;

	const settled = track.getSettings();
	const width = settled.width ?? 0;
	const height = settled.height ?? 0;

	if (!width || !height) return;

	/*
	 * The rate as well as the size, and this is the half that was missing.
	 *
	 * `frameRate` in the request is an ideal, not a floor: somebody who picks
	 * 240 and whose display gives sixty is handed a ceiling worked out for 240,
	 * which is twice what the picture they are sending is worth, and at 240
	 * asked against thirty delivered it is 2.8 times. The size check alone never
	 * saw it, because a capture at the size that was asked for takes the early
	 * return before the rate is ever looked at.
	 *
	 * Never above what was asked for. A source that reports a rate higher than
	 * the request — some do — must not be allowed to raise the ceiling; that
	 * would be this file arguing with the setting somebody chose.
	 */
	const rate = Math.min(settled.frameRate || profile.frameRate, profile.frameRate);

	const worth = bitrateFor(width, height, rate);
	if (worth >= profile.maxBitrate) return;

	try {
		const parameters = sender.getParameters();
		const top = parameters.encodings?.[parameters.encodings.length - 1];

		if (!top) return;

		top.maxBitrate = worth;
		await sender.setParameters(parameters);
	} catch {
		// See above: too generous is the state this shipped in for months.
	}
}

/**
 * Where the chosen quality is remembered.
 *
 * A person's answer to this follows from their display and their upload, and
 * neither changes between meetings. Asking again every time would be asking a
 * question whose answer they already gave.
 *
 * Local storage rather than session: it belongs to the machine, which is the
 * thing that decides it.
 */
const QUALITY_KEY = "meet.share.quality";

/** The quality to use, as last chosen on this machine. */
export function rememberedQuality(): ShareQuality {
	try {
		const stored = recall(QUALITY_KEY);
		if (stored && (SHARE_QUALITIES as readonly string[]).includes(stored)) {
			return stored as ShareQuality;
		}
	} catch {
		// Storage can be unavailable — a private window, a blocked origin — and
		// a share should still be possible when it is.
	}

	return "auto";
}

/** Remember a quality for next time. */
export function rememberQuality(quality: ShareQuality): void {
	try {
		keep(QUALITY_KEY, quality);
	} catch {
		// As above: worth doing, never worth failing over.
	}
}

/**
 * Where the chosen frame rate is remembered.
 *
 * Beside the size rather than with it, because they change for different
 * reasons: the size follows from the display and almost never moves, and the
 * rate follows from what is being shown and moves whenever that does.
 *
 * Read back through the same clamp the settings use, so a rate stored while a
 * larger size was chosen cannot come back and be sent to an encoder that cannot
 * do it.
 */
const RATE_KEY = "meet-live.share-frame-rate";

export function rememberedFrameRate(): ShareFrameRate {
	try {
		const stored = Number(recall(RATE_KEY));
		if ((SHARE_FRAME_RATES as readonly number[]).includes(stored)) {
			return stored as ShareFrameRate;
		}
	} catch {
		// Storage can be unavailable, and a share should still be possible.
	}

	// Sixty rather than thirty: this is what somebody gets who picks a size and
	// never touches the rate, and thirty is visibly less smooth on anything
	// that scrolls or plays.
	return 60;
}

export function rememberFrameRate(frameRate: ShareFrameRate): void {
	try {
		keep(RATE_KEY, String(frameRate));
	} catch {
		// Worth doing, never worth failing over.
	}
}

/**
 * What the share in a room is running at, and since when.
 *
 * The menu used to be the only thing that ever changed a share, so the menu's
 * own state was the truth and nothing else needed to know. The hint in
 * live/strain.ts changes one too, and from outside the menu — after which the
 * menu would go on ticking a setting nobody was sending. So the setting is
 * written down here, by the two functions that apply one, and read by the menu
 * and the hint alike.
 *
 * `started` and `since` are on the page's monotonic clock. The hint ignores what
 * a share measures for its first moments and for a while after any change,
 * because the browser's estimate of the line starts low and climbs, and those
 * figures look exactly like a line that cannot carry the share.
 *
 * `id` says which share this is, and it is the only thing that does. The
 * publication's track sid is not: a full reconnect unpublishes and publishes
 * the same capture again under a new sid, without anybody pressing anything,
 * and the hint took that for a new share — so "Not now" was forgotten in the
 * middle of the share it was said about. A share begins only through `share`,
 * and that is where the number moves.
 *
 * Nothing here is stored. It is the share in front of everybody now, and it
 * goes when that share does.
 */
export interface Running extends ShareSetting {
	id: number;
	started: number;
	since: number;
}

const running = new WeakMap<Room, Running>();
const runningListeners = new Set<() => void>();

/** The number the next share is given. Only ever compared for equality. */
let shares = 0;

/**
 * The capture each room's share is sending, so that a publication of it can be
 * told apart from the publication of a new one. See `keepShareSetting`.
 */
const capturing = new WeakMap<Room, unknown>();

/** The share a room is sending now, as the last share or retune left it. */
export function runningShare(room: Room): Running | undefined {
	return running.get(room);
}

/** Be told when that changes. Shaped for useSyncExternalStore. */
export function watchRunning(listener: () => void): () => void {
	runningListeners.add(listener);
	return () => runningListeners.delete(listener);
}

/*
 * `begun` says whether this is a new share. Without it a share stopped from the
 * browser's own bar — which never passes through `share(false)` — would leave
 * its start behind, and the next share would inherit an old one and skip the
 * quiet time it is owed.
 */
function record(room: Room, setting: ShareSetting | undefined, begun = false): void {
	const was = running.get(room);
	const now = performance.now();

	if (setting) {
		const fresh = begun || !was;
		running.set(room, {
			...setting,
			id: fresh ? ++shares : was.id,
			started: fresh ? now : was.started,
			since: now,
		});
	} else running.delete(room);

	for (const listener of runningListeners) listener();
}

/**
 * Change a share's settings without asking for the screen again.
 *
 * The obvious way to apply a new size or frame rate is to publish the share
 * again with different options, and it cannot be done: the browser will not
 * hand back a capture without asking, so every adjustment would put the picker
 * in front of somebody who had already chosen a window — and if they picked the
 * wrong one in a hurry, the meeting has just watched them do it. In practice
 * that means the settings can only be chosen before a share starts, which is
 * exactly when somebody has the least idea whether they are right.
 *
 * So the capture is kept and re-tuned in place, in two parts, because they are
 * two different mechanisms and only one of them is the one that matters:
 *
 *   - the capture, through `applyConstraints`, which is what the browser draws
 *     into the track. Requested rather than commanded: a display source has its
 *     own idea of how large it is and constraints can only ask for less.
 *   - the encoding, through the sender's parameters, which is what is actually
 *     sent. This is the half that decides whether anybody sees the difference —
 *     a capture at 4K published with a 1080p bitrate ceiling is a blurry 4K.
 *
 * Returns whether the encoding was reached. A false means the capture may have
 * changed while what goes out did not, which is worth saying rather than
 * swallowing: it is the difference between "this did nothing" and "this did
 * half of what it said".
 */
export async function retune(
	room: Room,
	frameRate: ShareFrameRate,
	quality: ShareQuality,
): Promise<boolean> {
	const publication = room.localParticipant.getTrackPublication(Track.Source.ScreenShare);
	const track = publication?.videoTrack;

	if (!track) return false;

	const profile = settingsFor(frameRate, quality);

	// A hint about what the pixels are, which the encoder uses to decide between
	// holding the picture still and holding the motion smooth. Set before the
	// constraints so a frame captured during the change is already labelled.
	track.mediaStreamTrack.contentHint = profile.contentHint;

	try {
		// The same shape the capture was asked for, and for the same reason: a
		// plain number is a target, so adjusting to 1440p on a 1080p display
		// would have the browser scale the screen up rather than leave it alone.
		// These were plain numbers while the capture used `resolution`, so the
		// two halves of one setting disagreed about what a size means.
		await track.mediaStreamTrack.applyConstraints({
			width: { max: profile.width },
			height: { max: profile.height },
			frameRate: { ideal: profile.frameRate },
		});
	} catch {
		// A source that will not narrow. The encoding below is still worth
		// setting: sending fewer frames of a picture the browser insists on
		// capturing at its own size is most of what was asked for.
	}

	const sender = track.sender;
	if (!sender) return false;

	const parameters = sender.getParameters();

	if (!parameters.encodings?.length) return false;

	/*
	 * The top layer takes the new setting; the small copy keeps being small.
	 *
	 * This loop used to give every encoding the profile's bitrate and rate,
	 * which was right while a share was one encode and became silently
	 * destructive the moment it stopped being one: the fallback would be handed
	 * the top layer's ceiling and stop being a fallback, so somebody nudging the
	 * frame rate mid-share would double their upstream and take away the only
	 * thing a starved subscriber could still receive. Nothing would have said
	 * so — the picture at the sending end is identical either way.
	 *
	 * The last encoding is the top one: presets are sorted ascending and
	 * encodingsFromPresets emits them in that order.
	 */
	const top = parameters.encodings.length - 1;

	// The capture as it is now, after the constraints above, because that is
	// what every smaller layer is scaled against.
	const settled = track.mediaStreamTrack.getSettings();
	const shortest = Math.min(settled.width ?? profile.width, settled.height ?? profile.height);

	/*
	 * The top rung's ceiling, against the picture that is actually there.
	 *
	 * This used to write `profile.maxBitrate` — the figure computed for what was
	 * asked for — and so it threw away settle's correction for good. Somebody
	 * sharing an 800x600 window who then nudged the frame rate went from a
	 * ceiling worth 2.2 Mb/s back to one worth eight, permanently, because
	 * settle runs once at publish and never again.
	 *
	 * Same rule as settle: downward only, never above what was chosen, and
	 * nothing anybody sees changes — a ceiling is a ceiling.
	 */
	const worth = worthOf(profile, settled);

	/*
	 * The ladder for the rate the share goes out at now, which is the half of
	 * a rung that can change without publishing again. A share stepped from
	 * sixty to thirty — from the menu, or by the hint — would otherwise keep a
	 * middle rung priced for sixty under a top layer of thirty: eleven megabits
	 * of ceiling for thirty frames of 1080p, which are worth eight. And the
	 * other way, a share raised to sixty kept a middle rung of thirty, the
	 * half-as-smooth picture the rung at sixty exists to end.
	 */
	const ladder = ladderAt(sentAt(settled, profile.frameRate));

	parameters.encodings.forEach((encoding, index) => {
		if (index === top) {
			encoding.maxBitrate = worth;
			encoding.maxFramerate = profile.frameRate;
			return;
		}

		// Its own rung, not one number for all of them. A share is published
		// with the first rungs of its ladder and never a later one without an
		// earlier — rungsBeneath only ever leaves out the larger — so an
		// encoding's place beneath the top names its rung.
		const beneath = ladder[index] ?? SMALL;

		encoding.maxBitrate = beneath.encoding.maxBitrate;

		// Never more frames than the top, as the SDK has it at publish
		// (encodingsFromPresets takes the smaller of the two): a share at
		// fifteen has fifteen frames in every layer, and a rung told thirty
		// would be a parameter that disagrees with the one the SDK wrote.
		encoding.maxFramerate = Math.min(beneath.encoding.maxFramerate ?? profile.frameRate, profile.frameRate);

		// And the size, which nothing here used to touch. The SDK works
		// scaleResolutionDownBy out once, at publish, against the capture as it
		// was then; a share resized afterwards left every smaller layer scaled
		// by a ratio taken against a picture that no longer exists, so the
		// ladder quietly stopped being the sizes it is named for.
		encoding.scaleResolutionDownBy = Math.max(1, shortest / beneath.height);
	});

	// What to give up when the connection cannot carry all of it. The whole
	// point of choosing a size is that it is not the thing quietly given away,
	// so anything but automatic holds the resolution and drops frames instead.
	parameters.degradationPreference = profile.degradationPreference;

	try {
		await sender.setParameters(parameters);
	} catch {
		return false;
	}

	// Only once the encoding took. A refused write leaves the share sending
	// what it sent before, and the menu showing that is the menu telling the
	// truth. Automatic keeps the rate it was handed, as in share.
	record(room, { quality, frameRate: quality === "auto" ? frameRate : (profile.frameRate as ShareFrameRate) });
	return true;
}

/**
 * Put a share's setting back on it after the SDK has published it again.
 *
 * A full reconnect — the signal connection lost and not resumable, which is
 * what a saturated uplink does to it — ends with the SDK unpublishing every
 * local track and publishing it again (`republishAllTracks`, from
 * `handleSignalRestarted`). The capture is kept; the encoding is not. It is
 * worked out afresh from the options the share was first published with, so a
 * share that was changed since — from the menu, or by the hint in
 * live/strain.ts — goes back to its first ceiling and its first frame rate, and
 * `settle`'s correction for a smaller capture goes with it. Nothing says so: the
 * menu goes on showing the change, and the hint goes on reasoning from it while
 * the encoder sends something else: a share the card had switched to 1440p at
 * thirty is back at 48.7 Mb/s and 120 under a menu that still says thirty.
 * Read from livekit-client 2.21's source — republishAllTracks hands
 * `pub.options` to publishOrRepublishTrack, which builds the encodings from
 * them — rather than watched happening: a full reconnect cannot be ordered up
 * from a test page without breaking the server it is talking to.
 *
 * A republish is told apart from a new share by the capture: a new share is a
 * new track, published before `share` has recorded it, and the republish is the
 * one already recorded. Applied through `retune`, so the encoder, the menu and
 * the hint agree again by the same path the menu itself takes.
 *
 * Returns the unsubscribe, for the tests; the room's own lifetime is the
 * subscription's otherwise.
 */
export function keepShareSetting(room: Room): () => void {
	const again = (publication: LocalTrackPublication) => {
		if (publication.source !== Track.Source.ScreenShare) return;

		const setting = running.get(room);
		const track = publication.videoTrack;

		if (!setting || !track || track !== capturing.get(room)) return;

		// A refusal leaves the share sending its first setting under a menu
		// that says otherwise; the hint checks for that itself and says
		// nothing while the two disagree.
		void retune(room, setting.frameRate, setting.quality);
	};

	room.on(RoomEvent.LocalTrackPublished, again);
	return () => {
		room.off(RoomEvent.LocalTrackPublished, again);
	};
}
