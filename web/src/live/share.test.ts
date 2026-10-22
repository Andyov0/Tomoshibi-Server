/**
 * What these guard is a combination that looks fine and fails slowly.
 *
 * A screen share does not fail loudly when it is asked for more than the machine
 * can do. The encoder falls behind, and the picture stutters and drifts further
 * behind the longer it runs, and nothing anywhere reports an error. So the
 * pairings that cannot be delivered must not be offered, the ones that are
 * offered must be sent with settings that can carry them, and a rate remembered
 * from a larger allowance must not survive being applied to a smaller one.
 *
 * The other half is the promise the automatic setting makes and the named ones
 * do not. Somebody who picked 4K picked it: being quietly given 1080p is the
 * complaint rather than the mitigation, and only automatic is allowed to make
 * that trade.
 */

import { describe, expect, it, vi } from "vitest";

import { type Room, RoomEvent, Track } from "livekit-client";

import {
	MIDDLE,
	MIDDLE_FAST,
	SMALL,
	ladderAt,
	rungsBeneath,
	SHARE_FRAME_RATES,
	SHARE_QUALITIES,
	type ShareFrameRate,
	type ShareQuality,
	keepShareSetting,
	offers,
	ratesFor,
	retune,
	runningShare,
	settingsForTest,
	share,
} from "./room";

const named = SHARE_QUALITIES.filter((one) => one !== "auto") as Exclude<ShareQuality, "auto">[];

describe("what is offered", () => {
	it("offers every rate a size can carry, slow ones included", () => {
		// A slow rate is always available: a page of code at 4K wants fifteen
		// frames and the sharpest picture, and refusing that refuses the better
		// answer.
		for (const quality of named) {
			expect(ratesFor(quality)).toContain(15);
			expect(ratesFor(quality)).toContain(30);
		}
	});

	it("stops each size where an encoder would stop keeping up", () => {
		expect(ratesFor("1080p")).toEqual([15, 30, 60, 120, 240]);
		expect(ratesFor("1440p")).toEqual([15, 30, 60, 120]);
		expect(ratesFor("4k")).toEqual([15, 30, 60]);

		expect(offers("4k", 120)).toBe(false);
		expect(offers("1440p", 240)).toBe(false);
	});

	// The one that would be silent. A rate chosen at 1080p and remembered, then
	// applied to 4K, must not reach an encoder that cannot do it.
	it("clamps a rate carried over from a size that allowed it", () => {
		expect(settingsForTest(240, "4k").frameRate).toBe(60);
		expect(settingsForTest(240, "1440p").frameRate).toBe(120);
		expect(settingsForTest(240, "1080p").frameRate).toBe(240);
	});
});

describe("what is sent", () => {
	it("has a size, a rate and a bitrate for every pairing offered", () => {
		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				const got = settingsForTest(rate, quality);

				expect(got.width).toBeGreaterThan(0);
				expect(got.height).toBeGreaterThan(0);
				expect(got.maxBitrate).toBeGreaterThan(0);
				expect(got.frameRate).toBe(rate);
			}
		}
	});

	// More pixels or more frames at the same ceiling is not more detail, it is
	// the same bitrate spread thinner — which is how a 4K option comes to look
	// worse than the 1080p one it replaced.
	it("raises the bitrate with both the pixels and the frames", () => {
		expect(settingsForTest(30, "4k").maxBitrate).toBeGreaterThan(
			settingsForTest(30, "1080p").maxBitrate,
		);

		expect(settingsForTest(120, "1080p").maxBitrate).toBeGreaterThan(
			settingsForTest(30, "1080p").maxBitrate,
		);
	});

	/*
	 * Never software, at any size or rate.
	 *
	 * A still 1080p picture used to take VP8, which draws text a little more
	 * crisply — it has no chroma subsampling to soften coloured letters. What
	 * that cost was hidden by which side pays it: VP8 is software essentially
	 * everywhere, to encode and to decode, and a share is the one track in a call
	 * that everybody is looking at. One person's processor bought the sharpness
	 * and everybody else's paid for it, phones included.
	 */
	it("never asks for a codec the machine has to do in software", () => {
		for (const quality of SHARE_QUALITIES) {
			for (const rate of SHARE_FRAME_RATES) {
				expect(settingsForTest(rate as ShareFrameRate, quality).videoCodec).toBe("h264");
			}
		}
	});

	it("never publishes a share with an SVC codec", () => {
		// The SDK pins an SVC share to one spatial layer and overwrites the
		// content hint, so VP9 here would silently discard the reason the
		// sharper settings exist.
		for (const quality of SHARE_QUALITIES) {
			for (const rate of SHARE_FRAME_RATES) {
				expect(settingsForTest(rate as ShareFrameRate, quality)).not.toHaveProperty(
					"videoCodec",
					"vp9",
				);
			}
		}
	});
});

describe("automatic", () => {
	/*
	 * Nothing publishes a second, smaller copy of the screen any more, and
	 * automatic is no longer the exception.
	 *
	 * Simulcast divides the allowance between two or three encodes of the same
	 * picture and lets the server hand somebody the small one. For a camera in
	 * a grid of faces that is the right trade. For a share it is the wrong one
	 * twice: the share is the only thing anybody is looking at, so a smaller
	 * version of it is nobody's mitigation, and the extra encodes are what make
	 * an encoder fall behind — the machinery for coping with a slow connection
	 * making the picture slow.
	 */
	it("publishes one encode at every setting, automatic included", () => {
		expect(settingsForTest(30, "auto").adapts).toBe(false);

		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).adapts).toBe(false);
			}
		}
	});

	/*
	 * What gives, where something must: frames, never the picture, at every
	 * setting.
	 *
	 * This used to turn on the rate — the picture held below thirty frames and
	 * given away above it, on the reasoning that somebody asking for a high
	 * rate was asking for the frames. That is right about a camera and wrong
	 * about a screen. What is on a shared screen is text, code and diagrams,
	 * and the two failures are not comparable: a late frame is late, and type
	 * that has been scaled away is gone, with nothing the person reading it can
	 * do about it.
	 */
	it("never gives away the picture, at any setting", () => {
		expect(settingsForTest(30, "auto").degradationPreference).toBe("maintain-resolution");

		for (const quality of named) {
			for (const rate of ratesFor(quality)) {
				expect(settingsForTest(rate, quality).degradationPreference).toBe("maintain-resolution");
			}
		}
	});

	/*
	 * A rate costs far less than a size, and treating them the same is what put
	 * the high settings out of reach.
	 *
	 * Multiplying by frames a second assumes every frame costs what the first one
	 * did — true of a camera pointed at a room, emphatically false of a screen,
	 * where one frame differs from the last by a moved cursor. Linear, 1440p at a
	 * hundred and twenty asked for forty-four megabits a second; the estimator
	 * finds out, clamps, and the encoder answers by dropping frames, which arrives
	 * as a stutter while the throughput reading looks healthy.
	 */
	it("charges far less for frames than for pixels", () => {
		const still = settingsForTest(30, "1440p").maxBitrate;
		const moving = settingsForTest(120, "1440p").maxBitrate;

		// Four times the frames, nothing like four times the bitrate.
		expect(moving).toBeGreaterThan(still);
		expect(moving).toBeLessThan(still * 2.5);

		// And a bigger picture still costs more than a faster one, which is the
		// ordering that was inverted before: 4K at sixty asked for less than 1080p
		// at two hundred and forty.
		expect(settingsForTest(60, "4k").maxBitrate).toBeGreaterThan(
			settingsForTest(240, "1080p").maxBitrate,
		);
	});
});

/*
The small copy, and why it is worth a test of its own.

It was removed once, on an argument that reads as sound: that simulcast divides
the allowance between the layers, so a fallback is paid for out of the picture
everybody is looking at. The SDK does no such thing — the top layer keeps the
encoding it was handed — but the mistake cost a live call, and it cost it
silently. A share published as one layer looks completely correct from the
sending end. It is the person on the far side of a thin path who gets nothing,
and they have no way to tell that apart from the sharing being broken.

So both halves are held here: that the top layer still asks for everything, and
that something smaller goes with it.
*/
describe("the small copy that goes with a share", () => {
	/**
	 * A room that records what it was asked to capture and publish, and whose
	 * capture comes back at `size`.
	 */
	function watching(size: { width: number; height: number; frameRate?: number } = { width: 2560, height: 1440 }) {
		const asked: { capture?: unknown; publish?: unknown } = {};

		const room = {
			localParticipant: {
				// Nothing published yet, so no sound is being shared on its own.
				trackPublications: new Map(),
				getTrackPublication: () => undefined,
				createScreenTracks: async (capture: unknown) => {
					asked.capture = capture;
					return [{ kind: Track.Kind.Video, mediaStreamTrack: { getSettings: () => size }, stop: () => {} }];
				},
				publishTrack: async (_track: unknown, publish: unknown) => {
					asked.publish = publish;
					return { source: Track.Source.ScreenShare };
				},
			},
		} as unknown as Room;

		return { room, asked };
	}

	it("goes beneath the share rather than instead of it", async () => {
		const { room, asked } = watching();

		await share(room, true, 120, "1080p");

		const publish = asked.publish as {
			simulcast: boolean;
			screenShareSimulcastLayers: { encoding: { maxBitrate: number } }[];
			screenShareEncoding: { maxBitrate: number };
		};

		expect(publish.simulcast).toBe(true);
		expect(publish.screenShareSimulcastLayers).toEqual([SMALL, MIDDLE_FAST]);

		// The half that matters most: nothing was taken off the top to pay for
		// them. What somebody chose is still what somebody able to receive it
		// gets.
		expect(publish.screenShareEncoding.maxBitrate).toBe(settingsForTest(120, "1080p").maxBitrate);
	});

	it("is the ladder the owner chose", () => {
		// 2026-10-13, after the old one — 360p at half a megabit, 720p at two
		// and a half — left everybody whose line could not carry the original
		// reading 720p at best, fourteen to nineteen times below the top; and
		// settled on 2026-10-14, after the bottom rung at fifteen frames came out
		// at six to ten under moving content and the middle one at thirty halved
		// a sixty-frame share for everybody watching in an ordinary window. These
		// numbers are a decision, not a tuning: changing one is a conversation
		// with the person who made it, and this is what makes it one.
		const said = (rung: typeof SMALL) => [rung.width, rung.height, rung.encoding.maxBitrate, rung.encoding.maxFramerate];

		expect(said(SMALL)).toEqual([1280, 720, 2_500_000, 30]);
		expect(said(MIDDLE)).toEqual([1920, 1080, 8_000_000, 30]);
		expect(said(MIDDLE_FAST)).toEqual([1920, 1080, 11_313_708, 60]);
	});

	it("prices the middle rung's sixty by the top layer's own curve", () => {
		// Eight megabits at thirty, scaled to sixty the way a share's own
		// ceiling is scaled for its rate. A figure of its own here would be a
		// second curve, and the first change to either would part them.
		const curve = settingsForTest(60, "1080p").maxBitrate / settingsForTest(30, "1080p").maxBitrate;

		expect(MIDDLE_FAST.encoding.maxBitrate / MIDDLE.encoding.maxBitrate).toBeCloseTo(curve, 6);
	});

	/*
	 * Which middle rung a share carries, by the rate it is sent at.
	 *
	 * At thirty for every share, the middle rung is what an ordinary window is
	 * sent — a 2560x1440 window covers 1925x1083 device pixels of a 1440p
	 * share — and a share at sixty arrived there at thirty, measured on
	 * 2026-10-13. At sixty for every share, a share at thirty would carry a copy
	 * priced for frames that do not exist.
	 */
	it("sends the middle rung at sixty for a share sent at sixty or more, and at thirty otherwise", async () => {
		for (const [rate, quality, middle] of [
			[15, "1440p", MIDDLE],
			[30, "1440p", MIDDLE],
			[60, "1440p", MIDDLE_FAST],
			[120, "1440p", MIDDLE_FAST],
			[60, "4k", MIDDLE_FAST],
			// Automatic sends sixty, whatever rate it was handed.
			[30, "auto", MIDDLE_FAST],
		] as const) {
			const { room, asked } = watching({ width: 3840, height: 2160 });
			await share(room, true, rate, quality);

			const publish = asked.publish as { screenShareSimulcastLayers?: unknown };
			expect(publish.screenShareSimulcastLayers, `${quality} at ${rate}`).toEqual([SMALL, middle]);
		}
	});

	it("goes by the frames the capture gives, where it gives fewer than were asked for", async () => {
		// Sixty chosen on a source that answers thirty: every layer has thirty
		// frames, and eleven megabits of ceiling for them is upload reserved for
		// nothing. Never the other way: a source reporting more than was asked
		// for does not raise the rung.
		const slow = watching({ width: 2560, height: 1440, frameRate: 30 });
		await share(slow.room, true, 60, "1440p");
		expect((slow.asked.publish as { screenShareSimulcastLayers?: unknown }).screenShareSimulcastLayers).toEqual([SMALL, MIDDLE]);

		const eager = watching({ width: 2560, height: 1440, frameRate: 120 });
		await share(eager.room, true, 30, "1440p");
		expect((eager.asked.publish as { screenShareSimulcastLayers?: unknown }).screenShareSimulcastLayers).toEqual([SMALL, MIDDLE]);
	});

	it("keeps the bottom rung a fraction of any picture it stands in for", () => {
		// It was held under two megabits, for the leg the first ladder was built
		// on — two a second, a tenth of its packets lost. The owner set it at
		// two and a half on 2026-10-14, above that leg; what is left to hold is
		// that it is still a fallback and not a second share: under a third of
		// the cheapest top layer anything offered can ask for, which is 1080p
		// at fifteen's 9.7. The SDK's own default for a share is a quarter of
		// the top layer, which for an ordinary ask is several megabits.
		for (const quality of SHARE_QUALITIES) {
			for (const rate of ratesFor(quality)) {
				expect(SMALL.encoding.maxBitrate * 3).toBeLessThan(
					settingsForTest(rate, quality).maxBitrate,
				);
			}
		}
	});

	it("climbs, so a small window is not sent the starved picture", () => {
		// The middle rung is what an element too small for the top layer should
		// get. It has to be bigger in every dimension that decides a selection,
		// or it is not a rung.
		for (const middle of [MIDDLE, MIDDLE_FAST]) {
			expect(middle.height).toBeGreaterThan(SMALL.height);
			expect(middle.encoding.maxBitrate).toBeGreaterThan(SMALL.encoding.maxBitrate);
			expect(middle.encoding.maxFramerate ?? 0).toBeGreaterThanOrEqual(SMALL.encoding.maxFramerate ?? 0);
		}

		// And smallest first by bitrate, which is how the SDK sorts presets
		// (sortPresets) and so the order the encodings come back in — the order
		// retune walks, naming each encoding's rung by its place.
		for (const rate of [15, 30, 60, 120, 240]) {
			const ladder = ladderAt(rate);
			const sorted = [...ladder].sort((a, b) => a.encoding.maxBitrate - b.encoding.maxBitrate);
			expect(ladder).toEqual(sorted);
		}
	});

	/*
	 * The rung that would be a second copy of the original.
	 *
	 * The SDK scales a rung by the capture's shorter side over the rung's and
	 * stops at one, so a 1080p capture published with MIDDLE carries MIDDLE at
	 * 1920x1080 — the original's picture at eight megabits and thirty frames —
	 * and dynacast turns it on with the original whenever anybody watches at
	 * full size. Nothing looks wrong from either end; the person sharing simply
	 * uploads eight megabits more than anybody needs. Most displays are 1080p.
	 */
	it("publishes a capture only with the rungs smaller than it", async () => {
		for (const [width, height, rungs] of [
			[3840, 2160, [SMALL, MIDDLE]],
			[2560, 1440, [SMALL, MIDDLE]],
			[1920, 1200, [SMALL, MIDDLE]],
			[1920, 1080, [SMALL]],
			[1366, 768, [SMALL]],
			// Taller than wide: the shorter side is what the SDK scales by.
			[1080, 1920, [SMALL]],
			[1280, 720, []],
			[800, 600, []],
		] as const) {
			const { room, asked } = watching({ width, height });
			await share(room, true, 30, "4k");

			const publish = asked.publish as { screenShareSimulcastLayers?: unknown };
			expect(publish.screenShareSimulcastLayers, `${width}x${height}`).toEqual(rungs);

			// The same sizes at sixty, with the middle rung at sixty.
			const fast = watching({ width, height });
			await share(fast.room, true, 60, "4k");

			const sixty = rungs.map((rung) => (rung === MIDDLE ? MIDDLE_FAST : rung));
			const published = fast.asked.publish as { screenShareSimulcastLayers?: unknown };
			expect(published.screenShareSimulcastLayers, `${width}x${height} at sixty`).toEqual(sixty);
		}
	});

	it("says none rather than nothing for a capture too small for any rung", () => {
		// An absent list is the SDK's cue to add a rung of its own choosing, a
		// quarter of the top layer's bitrate at the same size as the original.
		expect(rungsBeneath({ width: 1280, height: 720 }, 60)).toEqual([]);
	});

	it("keeps every rung when the capture will not say how large it is", () => {
		// The SDK scales none of them above the capture either way, and leaving
		// them out would leave a starved viewer nothing smaller to be sent.
		expect(rungsBeneath({}, 30)).toEqual([SMALL, MIDDLE]);
		expect(rungsBeneath({}, 60)).toEqual([SMALL, MIDDLE_FAST]);
	});
});

/*
Capturing first and publishing second.

`share` used to hand both halves to setScreenShareEnabled, which reads the rungs
before the picker has returned a picture to measure. Doing the two halves
itself means doing what that call also did, and these are the parts that would
fail without a sound: a capture left running after its publish failed keeps the
browser's "you are sharing" bar up over nothing, and a stop pressed while the
picker is open stops nothing and lets the share go out after it.
*/
describe("starting a share in two steps", () => {
	function starting(publish: () => Promise<unknown>) {
		const stopped = vi.fn();
		let resolve: (() => void) | undefined;
		const picked = new Promise<void>((done) => {
			resolve = done;
		});

		const room = {
			localParticipant: {
				trackPublications: new Map(),
				getTrackPublication: () => undefined,
				createScreenTracks: async () => {
					await picked;
					return [{ kind: Track.Kind.Video, mediaStreamTrack: { getSettings: () => ({ width: 2560, height: 1440 }) }, stop: stopped }];
				},
				publishTrack: vi.fn(publish),
				setScreenShareEnabled: vi.fn(async () => undefined),
			},
		} as unknown as Room;

		return { room, stopped, pick: () => resolve?.() };
	}

	it("stops what it captured when the publish fails", async () => {
		const { room, stopped, pick } = starting(async () => {
			throw new Error("refused");
		});

		const going = share(room, true, 30, "1080p");
		pick();

		await expect(going).rejects.toThrow("refused");
		expect(stopped).toHaveBeenCalled();
	});

	it("stops a share whose picker was still open when stop was pressed", async () => {
		const order: string[] = [];
		const { room, pick } = starting(async () => {
			order.push("published");
			return { source: Track.Source.ScreenShare };
		});
		(room.localParticipant.setScreenShareEnabled as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("stopped");
			return undefined;
		});

		const going = share(room, true, 30, "1080p");
		const stopping = share(room, false, 30, "1080p");
		pick();
		await Promise.all([going, stopping]);

		expect(order).toEqual(["published", "stopped"]);
	});

	it("captures once when asked twice", async () => {
		const { room, pick } = starting(async () => ({ source: Track.Source.ScreenShare }));
		const capture = vi.spyOn(room.localParticipant, "createScreenTracks");

		const one = share(room, true, 30, "1080p");
		const two = share(room, true, 30, "1080p");
		pick();
		await Promise.all([one, two]);

		expect(capture).toHaveBeenCalledTimes(1);
	});
});

/*
The capture request, and the two opposite ways it was wrong.

Both produced the same silence: every share ran at thirty frames a second
whatever the menu said, and nothing reported it. The first version wrote media
constraints into `resolution`, which takes three plain numbers, so the SDK's
`resolution.width > 0` gate dropped everything. The second moved them to `video`
and left `resolution` out — and createScreenTracks fills an absent
resolution with ScreenSharePresets.h1080fps30, which is then written over the
`video` constraints. Omitting the field is how a browser is asked for thirty
frames on purpose.

So there are two things to hold, and neither alone is enough: the field must be
there, and what is in it must be numbers.
*/
describe("what the browser is actually asked to capture", () => {
	function captured(rate: ShareFrameRate, quality: ShareQuality) {
		let capture: unknown;

		const room = {
			localParticipant: {
				// Nothing published yet, so no sound is being shared on its own.
				trackPublications: new Map(),
				getTrackPublication: () => undefined,
				createScreenTracks: async (asked: unknown) => {
					capture = asked;
					return [];
				},
				publishTrack: async () => undefined,
			},
		} as unknown as Room;

		return share(room, true, rate, quality).then(
			() =>
				capture as {
					resolution?: { width?: unknown; height?: unknown; frameRate?: unknown };
					video?: unknown;
				},
		);
	}

	it("names a resolution at all, because leaving it out means thirty", async () => {
		const asked = await captured(120, "1080p");

		// createScreenTracks: `if (options.resolution === undefined &&
		// !isSafari17Based()) options.resolution = h1080fps30.resolution`.
		expect(asked.resolution).toBeDefined();
	});

	it("puts numbers there, because the SDK compares them against zero", async () => {
		const asked = await captured(120, "1080p");

		// `resolution.width > 0` is false for an object, and the whole block —
		// size and rate together — is skipped without a word.
		expect(typeof asked.resolution?.width).toBe("number");
		expect(typeof asked.resolution?.height).toBe("number");
		expect(typeof asked.resolution?.frameRate).toBe("number");
	});

	it("carries the chosen rate through to the request", async () => {
		expect((await captured(120, "1080p")).resolution?.frameRate).toBe(120);
		expect((await captured(240, "1080p")).resolution?.frameRate).toBe(240);
		expect((await captured(60, "auto")).resolution?.frameRate).toBe(60);
	});

	it("asks for the clamped rate, not the one that was remembered", async () => {
		// 240 chosen while 1080p was, then 4K picked. The capture must be asked
		// for sixty, which is what 4K carries, rather than for a rate the browser
		// answers by giving whatever it likes.
		expect((await captured(240, "4k")).resolution?.frameRate).toBe(60);
	});

	it("asks for the size that was chosen, whatever screen the window is on", async () => {
		// This was clamped to `screen` for a while, so that `ideal` could not
		// become an upscale. `screen` describes the display the browser window is
		// on and not the surface the picker returns, so somebody with a laptop
		// and a 4K monitor who chose 4K and shared the monitor was handed 1080p
		// of it. Losing a picture somebody asked for is the worse trade; the
		// ceiling is corrected afterwards instead, against what actually arrived.
		vi.stubGlobal("screen", { width: 1280, height: 720 });
		vi.stubGlobal("devicePixelRatio", 1);

		try {
			const asked = await captured(60, "4k");

			expect(asked.resolution?.width).toBe(3840);
			expect(asked.resolution?.height).toBe(2160);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

/*
The ceiling, once the picture has arrived.

What a share is worth is computed from the size that was chosen, and the size
that was chosen is a request: a window is smaller than a screen, and
`width: { ideal }` is a target the browser may miss. A capture that came back
small was being sent with a ceiling worked out for one that did not, which is
upload reserved for nothing — and upload is the scarce thing on the connections
this has to work on.

Downward only. Raising it would be this file arguing with the setting somebody
chose.
*/
describe("the ceiling after the capture", () => {
	function shared(settings: { width?: number; height?: number; frameRate?: number }) {
		const encodings = [{ maxBitrate: 1 }, { maxBitrate: 999_999_999 }];

		const publication = {
			videoTrack: {
				sender: {
					getParameters: () => ({ encodings }),
					setParameters: async () => undefined,
				},
				mediaStreamTrack: { getSettings: () => settings },
			},
		};

		const room = {
			localParticipant: {
				// Nothing published yet, so no sound is being shared on its own.
				trackPublications: new Map(),
				getTrackPublication: () => undefined,
				createScreenTracks: async () => [{ kind: Track.Kind.Video, ...publication.videoTrack, stop: () => {} }],
				publishTrack: async () => ({ source: Track.Source.ScreenShare, ...publication }),
			},
		} as unknown as Room;

		return { room, encodings };
	}

	it("comes down to what a smaller capture is worth", async () => {
		// 4K was chosen; a 1080p window came back.
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "4k");

		const top = encodings[1];
		if (!top) throw new Error("no top encoding");

		expect(top.maxBitrate).toBe(settingsForTest(30, "1080p").maxBitrate);
		expect(top.maxBitrate).toBeLessThan(settingsForTest(30, "4k").maxBitrate);
	});

	it("leaves the rungs beneath it alone", async () => {
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "4k");

		// The small ones follow the capture through scaleResolutionDownBy, which
		// the SDK worked out from the same picture. Rewriting them here would be
		// two answers to one question.
		expect(encodings[0]?.maxBitrate).toBe(1);
	});

	it("does not move when the capture is the size that was asked for", async () => {
		const { room, encodings } = shared({ width: 1920, height: 1080 });

		await share(room, true, 30, "1080p");

		expect(encodings[1]?.maxBitrate).toBe(999_999_999);
	});

	it("does not move when the capture will not say", async () => {
		const { room, encodings } = shared({});

		await share(room, true, 30, "4k");

		expect(encodings[1]?.maxBitrate).toBe(999_999_999);
	});
});

/*
Upload reserved for a picture nobody is sending.

Three separate ways the ceiling was computed for the request rather than for
what arrived, and every one of them is upload the sharer pays for and no viewer
receives. None of this can change what anybody sees: maxBitrate is a ceiling,
so lowering it to what the picture is worth cannot take away a line of
resolution or a frame.

They are grouped because they share a failure mode — the request and the
capture disagree, and the code believed the request.
*/
describe("the ceiling follows the picture, not the request", () => {
	function watching(settings: { width?: number; height?: number; frameRate?: number }) {
		const encodings = [{ maxBitrate: 1 }, { maxBitrate: 999_999_999 }];
		const applied: unknown[] = [];

		const track = {
			sender: {
				getParameters: () => ({ encodings }),
				setParameters: async () => undefined,
			},
			mediaStreamTrack: {
				getSettings: () => settings,
				applyConstraints: async (c: unknown) => {
					applied.push(c);
				},
				contentHint: "",
			},
		};

		// Published once share() has published it, as the SDK has it.
		let published: unknown;

		const room = {
			localParticipant: {
				// Nothing published yet, so no sound is being shared on its own.
				trackPublications: new Map(),
				createScreenTracks: async () => [{ kind: Track.Kind.Video, ...track, stop: () => {} }],
				publishTrack: async () => {
					published = { source: Track.Source.ScreenShare, videoTrack: track };
					return published;
				},
				getTrackPublication: () => published,
			},
		} as unknown as Room;

		return { room, encodings, applied };
	}

	it("comes down when the display gave fewer frames than were asked for", async () => {
		// 240 was chosen; a sixty-hertz display answered. The size matches
		// exactly, which is the common case and the one the size check alone
		// walked straight past.
		const { room, encodings } = watching({ width: 1920, height: 1080, frameRate: 60 });

		await share(room, true, 240, "1080p");

		expect(encodings[1]?.maxBitrate).toBe(settingsForTest(60, "1080p").maxBitrate);
		expect(encodings[1]?.maxBitrate).toBeLessThan(settingsForTest(240, "1080p").maxBitrate);
	});

	it("never rises above what was chosen", async () => {
		// Some sources report a rate higher than the constraint. That is not an
		// invitation to spend more than the person asked for.
		const { room, encodings } = watching({ width: 1920, height: 1080, frameRate: 240 });

		await share(room, true, 30, "1080p");

		expect(encodings[1]?.maxBitrate).toBe(999_999_999);
	});

	it("hands back the whole difference for a small window, with no floor under it", async () => {
		// There was an eight-megabit floor. It raised nothing anybody could
		// choose — the smallest offered profile is 9.68 Mb/s — and truncated the
		// refund here, which was the only place it ever bound.
		const { room, encodings } = watching({ width: 800, height: 600, frameRate: 15 });

		await share(room, true, 15, "1080p");

		const top = encodings[1];
		if (!top) throw new Error("no top encoding");

		expect(top.maxBitrate).toBeLessThan(3_000_000);
		expect(top.maxBitrate).toBeLessThan(8_000_000);
	});

	it("is not thrown away by a change of setting mid-share", async () => {
		// retune used to write the profile's figure back over the correction,
		// and settle runs once at publish and never again — so one nudge of the
		// frame rate restored the over-allocation for good.
		const { room, encodings } = watching({ width: 800, height: 600, frameRate: 15 });

		await share(room, true, 15, "1080p");
		const afterShare = encodings[1]?.maxBitrate ?? 0;

		await retune(room, 30, "1080p");

		expect(encodings[1]?.maxBitrate).toBeLessThan(8_000_000);
		expect(encodings[1]?.maxBitrate).toBeLessThanOrEqual(Math.max(afterShare, 3_000_000));
	});
});

/*
The middle rung after a change of rate.

A share's rungs are fixed when it is published, but what each is sent at is a
parameter, and which middle rung is right depends on the share's rate. What
these guard is a share changed part way through keeping the middle rung of the
rate it started at: priced for sixty under a share of thirty, eleven megabits of
ceiling for thirty frames that are worth eight; or at thirty under a share
raised to sixty, the half-as-smooth picture the rung at sixty was chosen to end.
Nothing at either end shows it — the picture is right, and only the upload or
the smoothness of somebody watching in an ordinary window is wrong.
*/
describe("the middle rung after a change of rate", () => {
	/** A 1440p share at sixty, published with both rungs, whose capture takes the rate it is asked for. */
	function sharing() {
		const encodings: RTCRtpEncodingParameters[] = [
			{ maxBitrate: SMALL.encoding.maxBitrate, maxFramerate: 30, scaleResolutionDownBy: 2 },
			{ maxBitrate: MIDDLE_FAST.encoding.maxBitrate, maxFramerate: 60, scaleResolutionDownBy: 4 / 3 },
			{ maxBitrate: settingsForTest(60, "1440p").maxBitrate, maxFramerate: 60, scaleResolutionDownBy: 1 },
		];
		let rate = 60;

		const track = {
			sender: {
				getParameters: () => ({ encodings }),
				setParameters: vi.fn(async () => undefined),
			},
			mediaStreamTrack: {
				contentHint: "",
				getSettings: () => ({ width: 2560, height: 1440, frameRate: rate }),
				applyConstraints: async (asked: { frameRate?: { ideal?: number } }) => {
					rate = asked.frameRate?.ideal ?? rate;
				},
			},
		};

		const room = {
			localParticipant: { getTrackPublication: () => ({ source: Track.Source.ScreenShare, videoTrack: track }) },
		} as unknown as Room;

		return { room, small: () => encodings[0], middle: () => encodings[1] };
	}

	it("follows the share down to thirty and back up to sixty", async () => {
		const { room, middle } = sharing();

		expect(await retune(room, 30, "1440p")).toBe(true);
		expect([middle()?.maxBitrate, middle()?.maxFramerate]).toEqual([MIDDLE.encoding.maxBitrate, 30]);

		expect(await retune(room, 60, "1440p")).toBe(true);
		expect([middle()?.maxBitrate, middle()?.maxFramerate]).toEqual([MIDDLE_FAST.encoding.maxBitrate, 60]);
	});

	it("never gives a rung more frames than the share", async () => {
		// As the SDK has it at publish: each rung's rate is the smaller of its
		// own and the top layer's.
		const { room, small, middle } = sharing();

		await retune(room, 15, "1440p");

		expect(small()?.maxFramerate).toBe(15);
		expect(middle()?.maxFramerate).toBe(15);
		expect(middle()?.maxBitrate).toBe(MIDDLE.encoding.maxBitrate);
	});
});

/*
A share published again by the SDK, not by anybody.

A full reconnect unpublishes every local track and publishes it again, and the
encodings are built afresh from the options the share was first published with.
A share changed since — from the menu, or by the hint in live/strain.ts — went
back to its first ceiling and rate while the menu went on showing the change.
What these guard is the setting coming back, and only to the share it belongs
to: a new share's first publication is the one moment a recorded setting is
somebody else's.
*/
describe("a share published again after a reconnect", () => {
	const first = (): RTCRtpEncodingParameters[] => [
		{ maxBitrate: SMALL.encoding.maxBitrate, maxFramerate: 15 },
		{ maxBitrate: MIDDLE.encoding.maxBitrate, maxFramerate: 30 },
		{ maxBitrate: settingsForTest(120, "1440p").maxBitrate, maxFramerate: 120 },
	];

	function reconnecting() {
		const heard = new Set<(publication: unknown) => void>();
		let encodings = first();

		const capture = () => ({
			sender: {
				getParameters: () => ({ encodings }),
				setParameters: vi.fn(async () => undefined),
			},
			mediaStreamTrack: {
				contentHint: "",
				getSettings: () => ({ width: 2560, height: 1440, frameRate: 120 }),
				applyConstraints: async () => undefined,
			},
		});

		const publication = { trackSid: "TR_1", source: Track.Source.ScreenShare, videoTrack: capture() };

		// What the SDK has published now. A share that ended is unpublished by
		// the SDK itself, which is what `ended` stands for.
		let live: typeof publication | undefined;

		const room = {
			on: (event: string, listener: (publication: unknown) => void) => {
				if (event === RoomEvent.LocalTrackPublished) heard.add(listener);
			},
			off: (_event: string, listener: (publication: unknown) => void) => heard.delete(listener),
			localParticipant: {
				trackPublications: new Map(),
				createScreenTracks: async () => [{ kind: Track.Kind.Video, ...capture(), stop: () => {} }],
				// As the SDK does it: the publication is announced before the
				// call that asked for it returns.
				publishTrack: async () => {
					publication.trackSid = `TR_${Math.random()}`;
					publication.videoTrack = capture();
					encodings = first();
					live = publication;
					for (const listener of heard) listener(publication);
					return publication;
				},
				setScreenShareEnabled: async () => {
					live = undefined;
					return undefined;
				},
				getTrackPublication: () => live,
			},
		} as unknown as Room;

		const ended = () => {
			live = undefined;
		};

		// The SDK's republish: the same capture, a new sid, the first options.
		const republish = async () => {
			encodings = first();
			publication.trackSid = "TR_after_reconnect";
			for (const listener of heard) listener(publication);
			await new Promise((done) => setTimeout(done, 0));
		};

		return { room, top: () => encodings[2], republish, ended };
	}

	it("comes back to the setting the share was changed to", async () => {
		const { room, top, republish } = reconnecting();
		const stop = keepShareSetting(room);

		await share(room, true, 120, "1440p");
		await retune(room, 30, "1440p");
		const changed = runningShare(room);

		await republish();

		expect(top()?.maxFramerate).toBe(30);
		expect(top()?.maxBitrate).toBe(settingsForTest(30, "1440p").maxBitrate);
		// The same share, at the same setting, changed again just now.
		expect(runningShare(room)).toMatchObject({ id: changed?.id, quality: "1440p", frameRate: 30 });
		expect(runningShare(room)?.since).toBeGreaterThanOrEqual(changed?.since ?? Number.POSITIVE_INFINITY);

		stop();
	});

	it("leaves a new share's first publication to the new share", async () => {
		const { room, top, ended } = reconnecting();
		const stop = keepShareSetting(room);

		// One share, changed to thirty, and stopped from the browser's own bar,
		// which never passes through share(false) — so its setting is still on
		// record when the next one starts.
		await share(room, true, 120, "1440p");
		await retune(room, 30, "1440p");
		ended();

		await share(room, true, 120, "1440p");
		await new Promise((done) => setTimeout(done, 0));

		expect(top()?.maxFramerate).toBe(120);
		expect(runningShare(room)).toMatchObject({ quality: "1440p", frameRate: 120 });

		stop();
	});
});
