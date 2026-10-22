import { AVATAR_COLOURS, avatarSeed } from "@/live/avatar";
import { signatureOf } from "@/live/name";
import { cn } from "@/lib/utils";
import BoringAvatar from "boring-avatars";
import { useState } from "react";

/**
 * Stands in for a participant with no camera.
 *
 * Sized as a share of its tile rather than in pixels, so one component covers a
 * full-size grid cell and a thumbnail in the filmstrip without either being
 * told which it is.
 *
 * Two kinds of picture, and the fallback is not a lesser version of the other
 * one. Somebody with an account may have chosen a picture, and that is who they
 * are to everybody who knows them. Everybody else gets a figure drawn from their
 * identity — the same one every time they appear, different enough between
 * people that a grid of dark tiles is still a grid of individuals. A crossed-out
 * camera would say what is missing rather than who is.
 */
export function Avatar({ identity, className }: { identity: string; className?: string }) {
	// Only for somebody who arrived signed in.
	//
	// Not for a signature that merely came from a passphrase, even though that
	// is the same mark and the same person: a picture shown to anybody who typed
	// the right passphrase into a join form would make the picture a second
	// credential, and one nobody chose to be one. And never from the display
	// name, which is whatever was typed and belongs to no one.
	const signature = signatureOf(identity);
	const chosen = signature?.account ? signature.trip : undefined;

	// Most people have no picture, and the server says so with a 404. Handled
	// here rather than by asking first: one request either way, and no state to
	// keep in step with a list that changes as people come and go.
	const [missing, setMissing] = useState(false);

	if (chosen && !missing) {
		return (
			<img
				src={`/api/avatar/${encodeURIComponent(chosen)}`}
				alt=""
				onError={() => setMissing(true)}
				className={cn(
					"aspect-square w-[34%] max-w-24 min-w-8 rounded-full object-cover",
					className,
				)}
			/>
		);
	}

	return (
		<div className={cn("aspect-square w-[34%] max-w-24 min-w-8", className)}>
			<BoringAvatar
				name={avatarSeed(identity)}
				variant="marble"
				colors={[...AVATAR_COLOURS]}
				size="100%"
			/>
		</div>
	);
}
