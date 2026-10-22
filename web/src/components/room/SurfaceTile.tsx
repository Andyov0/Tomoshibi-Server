import { useMirrored } from "@/hooks/useMirrored";
import { useSteady } from "@/hooks/useSteady";
import { useT } from "@/hooks/useT";
import { type Surface, label, owner, signature } from "@/live/surface";
import type { TrackReference } from "@livekit/components-core";
import { VideoTrack } from "@livekit/components-react";
import type { TrackPublication } from "livekit-client";
import { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { Tile } from "./Tile";

/**
 * One picture in the layout.
 *
 * Rendering goes through the library's own component rather than attaching the
 * track by hand, because subscription is tied to the element: it subscribes when
 * the element is on screen, unsubscribes when it is not, and picks the simulcast
 * layer that matches the element's size. Doing that by hand meant fighting it
 * for control and getting neither behaviour reliably.
 */
export function SurfaceTile({
	surface,
	subscribed = true,
	unverified = false,
	silenced = false,
	selected,
	overlay,
	onSelect,
	onExpand,
}: {
	surface: Surface;
	subscribed?: boolean;
	unverified?: boolean;
	/** Whoever is looking has decided not to hear this picture's sound. */
	silenced?: boolean;
	selected?: boolean;
	/** Drawn over the picture, such as what this person just said. */
	overlay?: ReactNode;
	onSelect?: () => void;
	onExpand?: () => void;
}) {
	const t = useT();
	const participant = owner(surface);
	const camera = surface.kind === "camera";

	// Held briefly past the last word, so a pause mid-sentence does not put the
	// tally out and light it again.
	const speaking = useSteady(participant.isSpeaking && camera);
	// A placeholder reference is a camera that is off, which is a picture there
	// is nothing to render for. Narrowing here rather than asserting below keeps
	// the two conditions from drifting apart.
	const publication = surface.track.publication;
	const showing = subscribed && publication !== undefined && !publication.isMuted;
	const track = surface.track as TrackReference;

	// A face is fine to crop at the edges and looks wrong letterboxed, so a
	// camera fills its tile. A shared screen is the opposite: cropping hides
	// whatever was at the edge, which may be the thing being pointed at, so it is
	// shown whole with bars when the shapes disagree.
	const fit = camera ? "object-cover" : "object-contain";

	// Mirrored only for our own camera, and only while it is pointed at us. An
	// unmirrored view of yourself makes reaching for something on screen feel
	// backwards; a mirrored view of whatever a back camera is aimed at is a
	// world with its writing reversed. Everybody else sees the unmirrored
	// picture, and a mirrored screen share would be unreadable.
	const facing = useMirrored(publication?.track);
	const mirror = surface.local && camera && facing;

	const element = useRef<HTMLVideoElement>(null);
	const aspect = usePictureAspect(camera ? undefined : publication, element);

	return (
		<Tile
			label={surface.local ? t("{name} (you)", { name: label(surface) }) : label(surface)}
			signature={camera ? signature(surface) : undefined}
			unverified={camera && unverified}
			overlay={overlay}
			speaking={speaking}
			muted={camera && !participant.isMicrophoneEnabled}
			silenced={silenced}
			selected={selected}
			onSelect={onSelect}
			onExpand={onExpand}
		>
			{showing && camera ? (
				<VideoTrack
					trackRef={track}
					manageSubscription
					className={`absolute inset-0 size-full ${fit} ${mirror ? "-scale-x-100" : ""}`}
				/>
			) : showing ? (
				/*
				 * A share's element is the size of its picture, not of its tile.
				 *
				 * The element is what adaptive streaming measures, and what it
				 * measures is what this viewer asks the server for: its height, in
				 * device pixels, against the heights of the rungs. Drawn the way a
				 * camera is — the whole tile, the picture contained inside it —
				 * the element of a share on a stage narrower than the share is
				 * taller than the picture by the bars above and below it, and the
				 * request with it: a phone held upright asks for the original for
				 * a picture a third as tall as its tile, and a laptop with the
				 * messages open for a picture the 1080p rung would fill. Measured
				 * with the element fitted, the phone receives 720p; the arithmetic
				 * without it is 1944 device pixels asked for and the original
				 * sent. So the element takes the picture's own shape and is fitted
				 * inside the tile with container units, and the bars are the
				 * tile's own background around it — which is what they looked
				 * like before.
				 *
				 * Before the picture's shape is known the element is the whole
				 * tile, as it always was: asking for too much for a moment is the
				 * safe side.
				 */
				<div className="absolute inset-0 grid place-items-center [container-type:size]">
					<VideoTrack
						ref={element}
						trackRef={track}
						manageSubscription
						className={`size-full max-h-full max-w-full ${fit}`}
						style={fitted(aspect)}
					/>
				</div>
			) : (
				<div className="absolute inset-0 grid place-items-center bg-surface">
					<Avatar identity={participant.identity} />
				</div>
			)}
		</Tile>
	);
}

/**
 * The shape of the picture a share is sending, width over height.
 *
 * From the frames themselves once any have arrived, because the shared surface
 * can change shape mid-share — somebody switches from a screen to a window —
 * and the publication's dimensions are what it was published at. Every rung is
 * the same shape, so a lower rung arriving changes nothing here, and nothing
 * here can feed back into which rung arrives.
 */
function usePictureAspect(
	publication: TrackPublication | undefined,
	element: RefObject<HTMLVideoElement>,
): number | undefined {
	const published = publication?.dimensions;
	const [seen, setSeen] = useState<number>();

	useEffect(() => {
		const video = element.current;
		if (!video) return;

		const look = () => {
			if (video.videoWidth > 0 && video.videoHeight > 0) setSeen(video.videoWidth / video.videoHeight);
		};

		look();
		video.addEventListener("loadedmetadata", look);
		video.addEventListener("resize", look);
		return () => {
			video.removeEventListener("loadedmetadata", look);
			video.removeEventListener("resize", look);
		};
	});

	if (seen) return seen;
	return published && published.width > 0 && published.height > 0 ? published.width / published.height : undefined;
}

/**
 * The element's size for a picture of this shape: as wide as the tile allows,
 * and no taller than it.
 *
 * `100cqh` is the tile's height, through the container the element sits in. A
 * browser without container units drops the width and keeps the class's, and
 * the height is then held to the tile's by `max-h-full` — the whole tile, the
 * shape it had before this, rather than a picture spilling past the tile's edge
 * and cut off by it.
 */
export function fitted(aspect: number | undefined): CSSProperties | undefined {
	if (!aspect) return undefined;

	return {
		aspectRatio: String(aspect),
		width: `min(100cqw, ${(aspect * 100).toFixed(3)}cqh)`,
		height: "auto",
	};
}
