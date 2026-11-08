import { MediaBrowser } from "@/components/room/MediaBrowser";
import { WatchTab, addVideo } from "@/components/room/WatchTab";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Room } from "livekit-client";
import { type MediaServer, mediaServers } from "@/live/watch-api";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * Watching a video together: a link to paste, and what is playing and coming up.
 *
 * A panel and a button of its own rather than a tab beside the music, which is
 * where it began: the two are different things to reach for -- one plays into
 * the call's sound, the other puts a picture on the stage -- and a tab inside
 * the other's panel was one more press and one more thing to look for.
 */
export function WatchPanel({
	room,
	ready,
	leaving = false,
	onClose,
}: {
	room: Room;
	/**
	 * Whether this person can read links and start a show: signed in, given
	 * watching together, on a deployment with a watch gateway.
	 */
	ready: boolean;
	/** Playing its way out, for the exit animation. */
	leaving?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const [tab, setTab] = useState<"queue" | "media">("queue");
	// Asked once the panel opens, and only of somebody who could start a show:
	// browsing is for choosing, and choosing is theirs. The server lists none
	// for somebody not given the media servers, which leaves the tab out.
	const [servers, setServers] = useState<MediaServer[]>([]);
	useEffect(() => {
		if (!ready || room.options.e2ee !== undefined) return;
		let live = true;
		void mediaServers().then((found) => {
			if (live) setServers(found);
		});
		return () => {
			live = false;
		};
	}, [ready, room]);

	return (
		<aside
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface shadow-2xl",
				leaving ? "animate-depart" : "animate-arrive",
				"inset-x-0 bottom-0 h-[70%] rounded-t-2xl",
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-[min(34rem,calc(100%-5.5rem))] sm:w-80 sm:rounded-xl",
			)}
		>
			<header className="flex items-center justify-between border-border border-b py-1.5 pr-1.5 pl-4">
				<strong className="font-semibold text-[14px]">{t("Watch together")}</strong>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 rounded-full text-fg-muted hover:text-fg pointer-coarse:size-11"
					aria-label={t("Close watch together")}
					onClick={onClose}
				>
					<X />
				</Button>
			</header>
			{servers.length > 0 && (
				<div role="tablist" className="flex gap-1 border-border border-b p-1.5">
					{(
						[
							["queue", t("Queue")],
							["media", t("Media servers")],
						] as const
					).map(([key, label]) => (
						<button
							key={key}
							type="button"
							role="tab"
							aria-selected={tab === key}
							onClick={() => setTab(key)}
							className={cn(
								"flex-1 rounded-md px-2 py-1 text-[12px] transition-colors",
								tab === key ? "bg-surface-hi text-fg" : "text-fg-muted hover:text-fg",
							)}
						>
							{label}
						</button>
					))}
				</div>
			)}
			{tab === "media" && servers.length > 0 ? (
				<MediaBrowser
					servers={servers}
					// Read in this browser, under this person's grant, even in
					// somebody else's show; see addVideo.
					onChoose={async (link) => {
						if (await addVideo(room, link, ready, t)) setTab("queue");
					}}
				/>
			) : (
				<WatchTab room={room} ready={ready} />
			)}
		</aside>
	);
}
