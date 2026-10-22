import { Button } from "@/components/ui/button";
import { useLinkWorks } from "@/hooks/useJoining";
import { useT } from "@/hooks/useT";
import { invite } from "@/live/host";
import { actionFailed } from "@/live/notices";
import { Check, Copy, Link2, Loader2 } from "lucide-react";
import type { Room } from "livekit-client";
import { useEffect, useState } from "react";

/**
 * Shown to somebody who is alone.
 *
 * The moment anybody most needs the link to a room is the moment they discover
 * they are the only one in it, and until now that moment offered a view of
 * themselves and nothing else.
 *
 * The button and nothing else. It said so in a sentence first, which was a
 * caption on a fact the screen was already making plain — one picture, and it is
 * yours. What somebody wants at that moment is the address, and a button that
 * names what it does needs no line above it explaining the room.
 *
 * It goes when a second person arrives, which is not when the address stops
 * being wanted: the room's own menu carries it from then on.
 *
 * ## What it offers, which is not always the address
 *
 * The address is only a way in where anybody may use a room that exists. Where
 * the door asks for an invitation — which is this deployment — copying it and
 * sending it to somebody invites them to be turned away, and the person doing
 * the sending has no way to know that. It is the worst version of this screen:
 * the one moment somebody is actively trying to get another person into the
 * room, answered with a button that cannot.
 *
 * So under that door it mints an invitation instead, which is the thing that
 * works, and offers it only to whoever runs the room, because the server will
 * refuse anybody else. Somebody alone in a room they do not run is told who can
 * let people in rather than handed a button that answers 403.
 */
export function EmptyRoom({ room, host }: { room: Room; host: boolean }) {
	const t = useT();
	const linkWorks = useLinkWorks(room.name);
	const [copied, setCopied] = useState(false);
	const [minting, setMinting] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1600);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = () => {
		// The address bar's own text rather than one assembled here, which is
		// right until the first deployment behind a path or a different port.
		navigator.clipboard
			.writeText(window.location.href)
			.then(() => setCopied(true))
			.catch(() => setCopied(false));
	};

	const share = async () => {
		if (minting) return;
		setMinting(true);

		try {
			const link = await invite(room);
			await navigator.clipboard.writeText(link);
			setCopied(true);
		} catch (whatever) {
			actionFailed(whatever instanceof Error ? whatever.message : String(whatever));
		} finally {
			setMinting(false);
		}
	};

	if (!linkWorks && !host) {
		return (
			<p className="max-w-[22rem] text-center text-fg-muted text-xs leading-snug">
				{t("Only whoever runs this room can let somebody else in.")}
			</p>
		);
	}

	return (
		<div className="flex flex-col items-center gap-3 text-center">
			<Button
				variant="secondary"
				onClick={linkWorks ? copy : () => void share()}
				disabled={minting}
				className="gap-2"
			>
				{minting ? (
					<Loader2 className="size-4 animate-spin" />
				) : copied ? (
					<Check className="size-4 text-tally" />
				) : linkWorks ? (
					<Copy className="size-4" />
				) : (
					<Link2 className="size-4" />
				)}
				{copied ? t("Link copied") : linkWorks ? t("Copy link") : t("Invite somebody")}
			</Button>
		</div>
	);
}
