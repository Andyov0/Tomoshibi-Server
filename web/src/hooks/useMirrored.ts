import { facingUser } from "@/live/facing";
import { type Track, TrackEvent } from "livekit-client";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether one's own picture should be flipped, kept right as the camera changes.
 *
 * Switching camera does not hand back a new track. The media library restarts
 * the one that is there, replacing what it captures from and leaving the object
 * every component is holding exactly as it was — so a component that reads the
 * answer once reads it for the front camera and keeps drawing it for the back
 * one. That is what a phone was doing: the picture turned round and the mirror
 * stayed on.
 *
 * So the track is subscribed to rather than sampled. Restarted is the event that
 * means the camera underneath has changed, and it is the only one that does.
 */
export function useMirrored(track: Track | undefined): boolean {
	const subscribe = useCallback(
		(onChange: () => void) => {
			if (!track) return () => {};

			track.on(TrackEvent.Restarted, onChange);
			return () => {
				track.off(TrackEvent.Restarted, onChange);
			};
		},
		[track],
	);

	// A boolean, so the store's identity comparison is a comparison of the
	// answer rather than of an object rebuilt on every read.
	return useSyncExternalStore(
		subscribe,
		() => facingUser(track),
		() => true,
	);
}
