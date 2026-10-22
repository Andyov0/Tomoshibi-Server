import { useMirrored } from "@/hooks/useMirrored";
import { cn } from "@/lib/utils";
import { VideoOff } from "lucide-react";
import type { LocalVideoTrack } from "livekit-client";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * The camera preview on the screen before a call.
 *
 * The subject of that screen rather than a block within it: it is the one thing
 * there that is about the person looking at it, so it takes the width and
 * everything else reads as a caption on it.
 *
 * Sixteen by nine on a screen wider than it is tall, four by three on one that
 * is not. The condition is the shape of the viewport rather than its width,
 * because that is the thing actually being asked: a portrait screen given a
 * letterbox spends the half of itself that matters on two black bars, and a
 * phone turned on its side is as wide as a laptop. The camera sends the same
 * picture either way; what changes is how much of it is worth keeping.
 *
 * Mirrored while the camera is pointed at the person looking at it, because an
 * unmirrored view of yourself makes reaching for something on screen feel
 * backwards. Not mirrored when it is pointed away, where the same flip puts every
 * sign and every hand on the wrong side. Everybody else sees it unmirrored either
 * way.
 */
export function SelfView({
	track,
	children,
}: {
	track: LocalVideoTrack | undefined;
	/** Drawn over the picture, along its bottom edge. */
	children?: ReactNode;
}) {
	const ref = useRef<HTMLVideoElement>(null);
	const mirrored = useMirrored(track);

	useEffect(() => {
		const element = ref.current;
		if (!element || !track) return;

		track.attach(element);
		return () => {
			track.detach(element);
		};
	}, [track]);

	return (
		// The ceiling is a floor for the rest of the screen rather than a shape:
		// where it binds, the picture is simply cropped a little harder, which is
		// what object-cover was going to do anyway. Without it a very short window
		// gives the whole screen to a preview and puts the button below the fold.
		<div className="relative aspect-[4/3] max-h-[60svh] w-full overflow-hidden rounded-tile bg-surface landscape:aspect-video">
			<video
				ref={ref}
				autoPlay
				playsInline
				muted
				className={cn("absolute inset-0 size-full object-cover", mirrored && "-scale-x-100")}
			/>

			{!track && (
				<div className="absolute inset-0 grid place-items-center text-fg-muted">
					<VideoOff className="size-8" />
				</div>
			)}

			{children}
		</div>
	);
}
