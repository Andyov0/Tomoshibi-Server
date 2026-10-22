import type { Room } from "livekit-client";
import { describe, expect, it, vi } from "vitest";
import { SHARE_FRAME_RATES, type ShareFrameRate,
	type ShareQuality, share } from "./room";

/*
 * What these guard is a control that lied.
 *
 * The interface offered thirty frames a second or sixty, and the browser was
 * duly asked to capture whichever was chosen — but the encoder had a ceiling of
 * its own, fixed at thirty, and half of every sixty-frame capture was thrown
 * away before it left the machine. Choosing the second option cost twice the
 * capture work to send precisely what the first one sent, and nothing anywhere
 * said so.
 *
 * A fault of that shape cannot be seen from either end. The capture is genuinely
 * running at sixty, the picture genuinely arrives, and only a number buried in a
 * publication says the two do not meet. So the meeting point is what is asserted
 * here, rather than any of the things that looked fine while it was broken.
 */

/**
 * A stub of the calls `share` makes, which reports how they were made: the
 * capture asked of the browser, and the options the picture was published with.
 */
function watchShare() {
	const setScreenShareEnabled = vi.fn().mockResolvedValue(undefined);
	const createScreenTracks = vi.fn(async () => [
		{ kind: "video", mediaStreamTrack: { getSettings: () => ({ width: 1920, height: 1080 }) }, stop: () => {} },
	]);
	const publishTrack = vi.fn(async () => ({ source: "screen_share" }));
	const room = {
		localParticipant: {
			setScreenShareEnabled,
			createScreenTracks,
			publishTrack,
			getTrackPublication: () => undefined,
			trackPublications: new Map(),
		},
	} as unknown as Room;

	return {
		room,
		/** The capture options and the publish options, as they were passed. */
		/**
		 * A size is always given, because automatic chooses the rate itself.
		 *
		 * These tests are about a rate reaching the encoder, and under the
		 * automatic setting there is nothing to reach it with — it picks 1080p
		 * at thirty and adapts. Passing a size is what makes the question
		 * askable.
		 */
		async started(frameRate: ShareFrameRate, quality: ShareQuality = "1080p") {
			createScreenTracks.mockClear();
			publishTrack.mockClear();
			await share(room, true, frameRate, quality);

			const captured = createScreenTracks.mock.calls[0] as unknown[] | undefined;
			const published = publishTrack.mock.calls[0] as unknown[] | undefined;
			if (!captured || !published) throw new Error("share did not ask for a screen");

			// biome-ignore lint: the options are read as the SDK would read them
			const [capture, publish] = [captured[0], published[1]] as [any, any];
			return { capture, publish };
		},
	};
}

describe("share", () => {
	it.each(SHARE_FRAME_RATES)("carries %i frames all the way to the encoder", async (rate) => {
		const { started } = watchShare();
		// 1080p, which is the size that can carry every rate offered.
		const { capture, publish } = await started(rate);

		// Both halves, because either one alone is a number with no effect: a
		// capture nobody encodes, or an encoder with nothing to encode.
		//
		// A plain number, in `resolution`, because that is the only shape the
		// SDK acts on. These assertions passed for months while every share came
		// out at thirty frames: they read back the object this file had written,
		// and the SDK threw it away — `resolution` takes three numbers and gates
		// on `resolution.width > 0`. A test that checks what we meant rather than
		// what the library will act on is the test that lets that happen.
		expect(capture.resolution.frameRate).toBe(rate);
		expect(publish.screenShareEncoding.maxFramerate).toBe(rate);
	});

	/*
	 * The size asked of the capture is a ceiling, and that is the difference
	 * between reducing a big display and inflating a small one.
	 *
	 * Both used to be plain numbers, which a browser reads as "aim for this" — so
	 * a 1080p display asked to give 1440p had its screen scaled up before
	 * encoding: eighty-five per cent more pixels carrying not one pixel more of
	 * anything, encoded, sent, and scaled back down at the far end. Nothing
	 * anywhere said so, because the picture looked exactly as it should.
	 */
	it("asks for a size as a ceiling rather than a target", async () => {
		const { started } = watchShare();

		for (const rate of SHARE_FRAME_RATES) {
			const { capture } = await started(rate);

			// Numbers, not constraint objects. An object here is silently
			// dropped along with the frame rate beside it.
			expect(capture.resolution.width).toBe(1920);
			expect(capture.resolution.height).toBe(1080);
			expect(typeof capture.resolution.frameRate).toBe("number");

			// The ceiling is applied before the request rather than inside it:
			// the SDK writes `width: { ideal }`, and there is no way to say
			// ceiling through a field that is three numbers. See fitsDisplay.
		}
	});

	/*
	 * The hint is the whole of the sharper profile, and an SVC codec would have
	 * the SDK overwrite it on the way out. Asserting the pair together is what
	 * keeps somebody from later restoring the codec the camera uses and quietly
	 * undoing the hint along with it.
	 */
	it("asks for text with a codec that will pass the request on", async () => {
		const { started } = watchShare();
		const { capture, publish } = await started(30);

		expect(capture.contentHint).toBe("text");
		expect(["vp8", "h264"]).toContain(publish.videoCodec);
		expect(publish.degradationPreference).toBe("maintain-resolution");
	});

	it("asks for motion when the picture moves, and keeps the size that was chosen", async () => {
		const { started } = watchShare();
		const { capture, publish } = await started(60);

		expect(capture.contentHint).toBe("motion");
		expect(["vp8", "h264"]).toContain(publish.videoCodec);

		// The picture is held whatever the rate. A share is read rather than
		// watched: a late frame is late, and type scaled down to fit is
		// unreadable and stays that way.
		expect(publish.degradationPreference).toBe("maintain-resolution");
	});

	it("gives the busier picture the larger ceiling", async () => {
		const { started } = watchShare();
		const gentle = await started(30);
		const busy = await started(120);

		expect(busy.publish.screenShareEncoding.maxBitrate).toBeGreaterThan(
			gentle.publish.screenShareEncoding.maxBitrate,
		);
	});

	it("leaves the camera out of it", async () => {
		const { started } = watchShare();
		const { publish } = await started(60);

		// Publish options are given per share precisely so the camera keeps its
		// own codec. Anything named for the camera appearing here would mean the
		// screen's choice had reached across and changed it.
		expect(publish).not.toHaveProperty("videoEncoding");
		expect(publish).not.toHaveProperty("videoSimulcastLayers");
	});

	it("stops without asking for anything", async () => {
		const { room } = watchShare();
		const stop = room.localParticipant.setScreenShareEnabled as ReturnType<typeof vi.fn>;
		const capture = room.localParticipant.createScreenTracks as ReturnType<typeof vi.fn>;

		await share(room, false, 30);
		expect(stop).toHaveBeenCalledWith(false);
		expect(capture).not.toHaveBeenCalled();
	});
});
