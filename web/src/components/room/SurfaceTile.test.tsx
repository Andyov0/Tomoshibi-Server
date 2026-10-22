import { act, render } from "@testing-library/react";
import { forwardRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Surface } from "@/live/surface";
import { SurfaceTile, fitted } from "./SurfaceTile";

/*
What this guards is a share asking for more than it covers.

Adaptive streaming asks the server for the size of the element a picture is
drawn into, and a share was drawn the way a camera is: an element the size of
the whole tile, the picture contained inside it. On a stage narrower than the
share, the element is taller than the picture by the bars above and below, and
the request is taller with it — a phone held upright asks for the original for
a picture a third as tall as its tile. Nothing on the screen shows it: the
picture looks exactly as it should, and the line underneath carries the
original.

So the element itself has to take the picture's shape. Layout is not computed
here, so what is held is the shape the element is given and the container it is
measured against; two headless browsers are what measure the result.
*/

// The library's component attaches a real track; what matters here is only the
// element it is given and the props it passes on.
vi.mock("@livekit/components-react", () => ({
	VideoTrack: forwardRef<HTMLVideoElement, Record<string, unknown>>(function VideoTrack(
		{ trackRef: _track, manageSubscription: _manage, ...props },
		ref,
	) {
		return <video ref={ref} data-testid="picture" {...props} />;
	}),
}));

function surface(kind: "camera" | "screen", dimensions?: { width: number; height: number }): Surface {
	const participant = { identity: "tsomebody", name: "Somebody", isSpeaking: false, isMicrophoneEnabled: true };
	const publication = { isMuted: false, dimensions, track: undefined };

	return {
		id: `${kind}-1`,
		kind,
		local: false,
		track: { participant, publication, source: kind === "camera" ? "camera" : "screen_share" },
	} as unknown as Surface;
}

describe("a share's element", () => {
	it("takes the shape of the picture the share is sending", () => {
		const { getByTestId } = render(<SurfaceTile surface={surface("screen", { width: 2560, height: 1440 })} />);
		const video = getByTestId("picture");

		expect(video.style.aspectRatio).toBe(String(2560 / 1440));
		expect(video.style.width).toBe("min(100cqw, 177.778cqh)");

		// Measured against the tile, through a container of its own size.
		expect(video.parentElement?.className).toContain("[container-type:size]");
	});

	it("follows the frames once they arrive, not the size it was published at", () => {
		// The surface switched from a screen to a square window mid-share.
		const { getByTestId } = render(<SurfaceTile surface={surface("screen", { width: 2560, height: 1440 })} />);
		const video = getByTestId("picture") as HTMLVideoElement;

		Object.defineProperty(video, "videoWidth", { value: 900 });
		Object.defineProperty(video, "videoHeight", { value: 900 });
		act(() => {
			video.dispatchEvent(new Event("resize"));
		});

		expect(video.style.aspectRatio).toBe("1");
		expect(video.style.width).toBe("min(100cqw, 100.000cqh)");
	});

	it("is the whole tile until the picture's shape is known", () => {
		const { getByTestId } = render(<SurfaceTile surface={surface("screen")} />);

		expect(getByTestId("picture").style.aspectRatio).toBe("");
		expect(fitted(undefined)).toBeUndefined();
	});
});

describe("a camera's element", () => {
	it("still fills its tile, cropped rather than fitted", () => {
		// A face is fine to crop at the edges; adaptive streaming asking for the
		// tile is asking for what is drawn.
		const { getByTestId } = render(<SurfaceTile surface={surface("camera", { width: 1280, height: 720 })} />);
		const video = getByTestId("picture");

		expect(video.style.aspectRatio).toBe("");
		expect(video.className).toContain("object-cover");
		expect(video.className).toContain("inset-0");
	});
});
