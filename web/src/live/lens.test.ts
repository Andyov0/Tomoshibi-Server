import { RemoteTrackPublication, RemoteVideoTrack, RoomEvent, Track, TrackEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type View, magnifyShares } from "./lens";

/*
What these guard is a share asked for at fewer pixels than it is drawn at, with
nothing on the screen to say so but blurred type.

Adaptive streaming measures a picture when its layout box changes size, and two
things change the pixels it covers without that: a pinch, which is the only way
to enlarge a share on an iPhone, and a window moved to a denser display. Before
2026-10-14 neither asked again, so somebody pinching into a share of code on a
phone was sent the 720p rung at fifteen frames however far in they went.

And the opposite fault, which the file this replaced had: something added to the
measurement that kept a share playing where nobody could see it. The lens is
never visible, and a test holds that.

These run the SDK's own RemoteVideoTrack and RemoteTrackPublication, so that
what is asserted is what the SDK would send the server.
*/

/** What the SDK sends the server for the subscription. */
type Sent = { width?: number; height?: number; disabled?: boolean };

class Viewport extends EventTarget {
	scale = 1;
}

class RatioQuery extends EventTarget {
	constructor(readonly media: string) {
		super();
	}
	matches = true;
}

/** A page: its viewport, and the queries asked of it, newest last. */
function page(ratio: number) {
	const queries: RatioQuery[] = [];
	const viewport = new Viewport();

	const view = {
		devicePixelRatio: ratio,
		visualViewport: viewport,
		matchMedia: (media: string) => {
			const query = new RatioQuery(media);
			queries.push(query);
			return query;
		},
	};

	// The SDK reads the ratio from the window itself (getDevicePixelRatio).
	Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true, writable: true });

	const setRatio = (next: number) => {
		view.devicePixelRatio = next;
		Object.defineProperty(window, "devicePixelRatio", { value: next, configurable: true, writable: true });
		queries[queries.length - 1]?.dispatchEvent(new Event("change"));
	};

	return { view: view as unknown as View, viewport, queries, setRatio };
}

/**
 * A 2560x1440 share, subscribed, whose picture is `width` by `height` points
 * and `visible` or not, measured the way HTMLElementInfo measures it.
 */
function share(width: number, height: number, visible = true) {
	const info = {
		sid: "TR_share",
		name: "screen",
		source: 3,
		mimeType: "video/H264",
		simulcast: true,
		type: 1,
		muted: false,
		width: 2560,
		height: 1440,
		layers: [
			{ quality: 0, width: 1280, height: 720 },
			{ quality: 1, width: 1920, height: 1080 },
			{ quality: 2, width: 2560, height: 1440 },
		],
	};

	const publication = new RemoteTrackPublication(Track.Kind.Video, info as never, true);
	const sent: Sent[] = [];
	publication.on(TrackEvent.UpdateSettings, (settings: Sent) =>
		sent.push({ width: settings.width, height: settings.height, disabled: settings.disabled }),
	);

	const track = new RemoteVideoTrack({ id: "share", enabled: true } as never, "TR_share", undefined as never, {
		pixelDensity: "screen",
		pauseVideoInBackground: false,
	});
	track.source = Track.Source.ScreenShare;
	publication.setTrack(track);

	// The picture: an element on the page, and the SDK's measurement of it.
	const element = { clientWidth: width, clientHeight: height } as HTMLMediaElement;
	track.attachedElements.push(element);
	track.observeElementInfo({
		element,
		width: () => element.clientWidth,
		height: () => element.clientHeight,
		visible,
		pictureInPicture: false,
		visibilityChangedAt: 0,
		observe() {},
		stopObserving() {},
	});
	track.emit(TrackEvent.ElementAttached, element);

	const handlers = new Map<string, (...args: unknown[]) => void>();
	const room = {
		remoteParticipants: new Map([["P", { trackPublications: new Map([["TR_share", publication]]) }]]),
		on: (event: string, handler: (...args: unknown[]) => void) => handlers.set(event, handler),
		off: (event: string) => handlers.delete(event),
	};

	// biome-ignore lint: the fake is deliberately narrow
	return { room: room as any, publication, track, sent, handlers, element };
}

const last = (sent: Sent[]) => sent[sent.length - 1];

/** Past the SDK's own debounce on a re-measure. */
const settle = () => vi.advanceTimersByTimeAsync(250);

describe("a magnified share", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("asks for the pixels a pinch magnifies it to, and no more than the share has", async () => {
		// An iPhone held upright: 390 points across, three pixels a point.
		const { view, viewport } = page(3);
		const { room, sent } = share(390, 219);
		const stop = magnifyShares(room, view);
		await settle();
		expect(last(sent)).toMatchObject({ width: 1170, height: 657 });

		viewport.scale = 3;
		viewport.dispatchEvent(new Event("resize"));
		await settle();

		// Three times as much would be 3510 across; the share is 2560.
		const asked = last(sent);
		expect(asked?.width).toBe(2560);
		expect(asked?.height ?? 0).toBeGreaterThanOrEqual(1440 * 0.9);
		expect(asked?.height ?? 0).toBeLessThanOrEqual(1440);

		// And back down when the pinch is undone.
		viewport.scale = 1;
		viewport.dispatchEvent(new Event("resize"));
		await settle();
		expect(last(sent)).toMatchObject({ width: 1170, height: 657 });

		stop();
	});

	it("asks again when the window moves to a denser display", async () => {
		// The same 1200x675 points, on a display of one pixel a point and then
		// on one of two. Nothing resizes; only the ratio changes.
		const { view, setRatio } = page(1);
		const { room, sent } = share(1200, 675);
		const stop = magnifyShares(room, view);
		await settle();
		expect(last(sent)).toMatchObject({ width: 1200, height: 675 });

		setRatio(2);
		await settle();
		expect(last(sent)).toMatchObject({ width: 2400, height: 1350 });

		stop();
	});

	it("goes on watching the ratio after it has changed once", async () => {
		const { view, setRatio, queries } = page(1);
		const { room, sent } = share(1200, 675);
		const stop = magnifyShares(room, view);
		await settle();

		setRatio(2);
		await settle();
		expect(queries[queries.length - 1]?.media).toBe("(resolution: 2dppx)");

		setRatio(1);
		await settle();
		expect(last(sent)).toMatchObject({ width: 1200, height: 675 });

		stop();
	});

	it("never keeps a share playing that nobody can see", async () => {
		// Scrolled out of sight while pinched in. The lens has a size; it has
		// no say in whether the share is shown.
		const { view, viewport } = page(3);
		const { room, sent } = share(390, 219, false);
		const stop = magnifyShares(room, view);

		viewport.scale = 3;
		viewport.dispatchEvent(new Event("resize"));
		await settle();

		expect(last(sent)?.disabled).toBe(true);

		stop();
	});

	it("is not put on a share before its picture is on the page", async () => {
		// With nothing else to go on, the SDK would read an invisible lens as
		// a share nobody can see, and pause one about to be drawn.
		const { view } = page(2);
		const { room, track, publication } = share(390, 219);
		track.attachedElements.length = 0;

		const observe = vi.spyOn(RemoteVideoTrack.prototype, "observeElementInfo");
		const stop = magnifyShares(room, view);
		expect(observe).not.toHaveBeenCalled();

		// Then drawn: put on.
		const drawn = { clientWidth: 390, clientHeight: 219 } as HTMLMediaElement;
		track.attachedElements.push(drawn);
		track.emit(TrackEvent.ElementAttached, drawn);
		expect(observe).toHaveBeenCalledTimes(1);
		expect(publication.isSubscribed).toBe(true);

		stop();
	});

	it("takes its lens back when the share is unsubscribed", async () => {
		const { view } = page(2);
		const { room, track, handlers } = share(390, 219);
		const stop = magnifyShares(room, view);

		const unobserve = vi.spyOn(track, "stopObservingElementInfo");
		handlers.get(RoomEvent.TrackUnsubscribed)?.(track);
		expect(unobserve).toHaveBeenCalledTimes(1);

		stop();
	});
});
