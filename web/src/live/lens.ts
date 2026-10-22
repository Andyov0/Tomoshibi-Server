/**
 * A shared screen magnified on the page asks for the pixels it is magnified to.
 *
 * ## The fault
 *
 * A share is asked for at the device pixels its picture covers (see `create`
 * in live/room.ts), and the SDK measures that only when the picture's layout
 * box changes size: a ResizeObserver on the element, times the device pixel
 * ratio read at that moment (RemoteVideoTrack.updateDimensions,
 * livekit-client.esm.mjs:15302-15340). Two things change the pixels a picture
 * covers without changing its box, and nothing in the SDK or in this client
 * listened for either:
 *
 *   - Pinching to zoom. An iPhone held upright draws a 1440p share 390 points
 *     wide; at three device pixels a point that asks for 1170x658 and is sent
 *     the 720p rung. Safari on an iPhone has no full screen
 *     for a video element (see useFullscreen.ts), so the way to read the code
 *     on somebody's screen is to pinch — which magnifies the page and changes
 *     neither the box nor the ratio, so the request stayed at 720p however far
 *     in they went. While live/sharpness.ts held every share at its source size
 *     this could not happen; the owner's rule of 2026-10-13 that enlarging asks
 *     for the original again is what it broke. A trackpad pinch in Chrome does
 *     the same.
 *   - Moving a window from an ordinary display to a retina one. The box is the
 *     same number of points and the ratio doubles; nothing resizes, and the
 *     share went on being asked for at half the pixels it now covers until the
 *     window next changed size.
 *
 * (Found in review, 2026-10-14.)
 *
 * ## What this does about it
 *
 * Gives every remote share one more ElementInfo to measure — a lens — whose
 * size is its picture's size times the visual viewport's scale, and nothing at
 * all while the page is not magnified. The SDK takes the *largest* of what it
 * measures, so the lens can only ever raise a request, which is all it is for:
 * the picture's own measurement goes on deciding everything else. Capped at the
 * share's own size, because a request beyond the top rung is answered with the
 * top rung anyway.
 *
 * The lens is never visible. That is the difference from sharpness.ts's stub,
 * which claimed to be a visible picture as large as the source and so kept
 * every share playing, at its largest, whether or not anybody could see it. The
 * SDK pauses a track when none of what it measures is visible, and a lens that
 * never says it is leaves that decision to the picture alone.
 *
 * And it is the handle by which the SDK is told to measure again: the SDK hands
 * every ElementInfo it observes a `handleResize`, and calling it re-measures
 * every picture of that track against the ratio as it is now — which is the
 * whole of what a move to a denser display needs.
 *
 * ## When it is put on
 *
 * Once the share's picture is on the page, and not before. Observing an
 * ElementInfo makes the SDK decide at once whether the track is visible, and
 * with nothing but an invisible lens to go on it would say no and pause a share
 * about to be drawn. So it is put on when the SDK says an element was attached
 * (ElementAttached, marked internal by the SDK and emitted by Track.attach,
 * esm.mjs:13595), and again on every change of magnification or ratio, which is
 * the only time it matters; putting it on twice is harmless.
 */

import { type ElementInfo, type RemoteTrackPublication, RemoteVideoTrack, type Room, RoomEvent, Track, TrackEvent } from "livekit-client";

/** The page as far as this needs it, so a test can supply one. */
export type View = Pick<Window, "devicePixelRatio" | "visualViewport" | "matchMedia">;

/** How magnified the page is: one, unless somebody has pinched. */
function magnification(view: View): number {
	const scale = view.visualViewport?.scale ?? 1;
	return Number.isFinite(scale) && scale > 1 ? scale : 1;
}

/**
 * The lens for one share: its largest picture times the magnification, in the
 * layout's points (the SDK multiplies by the ratio), no larger than the share.
 */
export function lensFor(track: RemoteVideoTrack, publication: RemoteTrackPublication, view: View): ElementInfo {
	const size = (): { width: number; height: number } => {
		const scale = magnification(view);
		if (scale <= 1) return { width: 0, height: 0 };

		let width = 0;
		let height = 0;
		for (const element of track.attachedElements) {
			if (element.clientWidth + element.clientHeight > width + height) {
				width = element.clientWidth;
				height = element.clientHeight;
			}
		}

		width *= scale;
		height *= scale;

		// No more than the share's own pixels, kept in proportion.
		const ratio = view.devicePixelRatio || 1;
		const source = publication.dimensions;
		if (source?.width && source.height && width && height) {
			const fit = Math.min(1, source.width / ratio / width, source.height / ratio / height);
			width *= fit;
			height *= fit;
		}

		return { width, height };
	};

	return {
		// Required by the type and compared against nothing real: `attach`
		// dedupes on `info.element === element`, and a bare object is equal to
		// no element.
		element: {},
		width: () => size().width,
		height: () => size().height,
		visible: false,
		pictureInPicture: false,
		visibilityChangedAt: 0,
		observe() {},
		stopObserving() {},
	};
}

/**
 * Put a lens on every share this browser receives, and have the SDK measure
 * again whenever the page's magnification or pixel ratio changes. Returns the
 * undoing.
 */
export function magnifyShares(room: Room, view: View = window): () => void {
	const lenses = new Map<RemoteVideoTrack, ElementInfo>();
	const listening = new Map<RemoteVideoTrack, () => void>();

	const shareOf = (publication: RemoteTrackPublication): RemoteVideoTrack | undefined => {
		if (publication.source !== Track.Source.ScreenShare) return undefined;
		const track = publication.videoTrack;
		return track instanceof RemoteVideoTrack ? track : undefined;
	};

	const arm = (track: RemoteVideoTrack, publication: RemoteTrackPublication) => {
		if (lenses.has(track) || track.attachedElements.length === 0) return;

		const lens = lensFor(track, publication, view);
		try {
			track.observeElementInfo(lens);
			lenses.set(track, lens);
		} catch {
			// A build where this is no longer reachable: the share is measured
			// as everything else is, which is the fault and not a broken call.
		}
	};

	const each = (act: (track: RemoteVideoTrack, publication: RemoteTrackPublication) => void) => {
		for (const participant of room.remoteParticipants.values()) {
			for (const publication of participant.trackPublications.values()) {
				const track = shareOf(publication);
				if (track) act(track, publication);
			}
		}
	};

	const follow = (track: RemoteVideoTrack, publication: RemoteTrackPublication) => {
		if (listening.has(track)) return;
		const onAttached = () => arm(track, publication);
		track.on(TrackEvent.ElementAttached, onAttached);
		listening.set(track, () => track.off(TrackEvent.ElementAttached, onAttached));
		arm(track, publication);
	};

	const forget = (track: RemoteVideoTrack) => {
		listening.get(track)?.();
		listening.delete(track);

		const lens = lenses.get(track);
		lenses.delete(track);
		if (!lens) return;
		try {
			track.stopObservingElementInfo(lens);
		} catch {
			// Gone with the track it belonged to.
		}
	};

	// Measure again: through each lens, which is how the SDK lets anything ask.
	const remeasure = () => {
		each(arm);
		for (const lens of lenses.values()) lens.handleResize?.();
	};

	// The ratio is watched by asking whether it is still what it was, which is
	// the only way the platform offers; the question is asked again for the
	// new ratio every time the answer changes.
	let ratioQuery: MediaQueryList | undefined;
	const watchRatio = () => {
		ratioQuery?.removeEventListener("change", onRatio);
		ratioQuery = view.matchMedia?.(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
		ratioQuery?.addEventListener?.("change", onRatio);
	};
	function onRatio() {
		watchRatio();
		remeasure();
	}

	const onSubscribed = (_track: unknown, publication: RemoteTrackPublication) => {
		const track = shareOf(publication);
		if (track) follow(track, publication);
	};
	const onUnsubscribed = (track: unknown) => {
		if (track instanceof RemoteVideoTrack) forget(track);
	};

	each(follow);
	room.on(RoomEvent.TrackSubscribed, onSubscribed);
	room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
	view.visualViewport?.addEventListener("resize", remeasure);
	watchRatio();

	return () => {
		room.off(RoomEvent.TrackSubscribed, onSubscribed);
		room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
		view.visualViewport?.removeEventListener("resize", remeasure);
		ratioQuery?.removeEventListener("change", onRatio);
		for (const track of [...listening.keys()]) forget(track);
	};
}
