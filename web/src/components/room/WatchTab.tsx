import { Button } from "@/components/ui/button";
import { useVideoInfo } from "@/hooks/useVideoInfo";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { clock } from "@/live/music";
import { actionFailed } from "@/live/notices";
import {
	type Refusal,
	type TheatreDeps,
	type Video,
	closeTheatre,
	command,
	seenShow,
	startTheatre,
	subscribeShow,
} from "@/live/watch";
import { readTicket, rememberInfo, resolveVideo } from "@/live/watch-api";
import type { Room } from "livekit-client";
import { Clapperboard, Loader2, Plus, X } from "lucide-react";
import { type FormEvent, useState, useSyncExternalStore } from "react";

/**
 * What to say about a video that was not added.
 *
 * The two refusals of a person are said as what the person seeing them was not
 * given, because by the time one reaches somebody it is about them: a link is
 * read by whoever adds it wherever they can (see addVideo), a link read on
 * somebody else's behalf is refused a media server's film whoever they are,
 * and the holder's own refusal is not passed on as one (see Theatre.add).
 */
export function refusal(
	why: Refusal,
):
	| "That link is not a video that can be played here."
	| "That video cannot be played here."
	| "That video is for paying members only, and plays only on its own site."
	| "That video is copy-protected, and plays only on its own site."
	| "That video is not available in this server's region."
	| "That episode could not be found: it may have been taken down, or not be offered in this server's region."
	| "Watching together has not been opened to you."
	| "The media servers have not been opened to you."
	| "The video could not be read. Try again." {
	if (why === "not_a_video") return "That link is not a video that can be played here.";
	if (why === "unavailable") return "That video cannot be played here.";
	// Bilibili's shows, today. "Its own site" because that is where it does
	// play: the deployment's own premium account is given only a preview for a
	// page elsewhere, so the account is no help and the sentence does not offer it.
	if (why === "members_only") return "That video is for paying members only, and plays only on its own site.";
	if (why === "copy_protected") return "That video is copy-protected, and plays only on its own site.";
	if (why === "region_locked") return "That video is not available in this server's region.";
	// Both, because which it is cannot be told from here: Bilibili answers a
	// season it offers only in Hong Kong, Macau and Taiwan, asked from the
	// mainland, with the same "nothing here" as an episode it took down.
	if (why === "not_found")
		return "That episode could not be found: it may have been taken down, or not be offered in this server's region.";
	if (why === "not_allowed") return "Watching together has not been opened to you.";
	if (why === "emby_not_allowed") return "The media servers have not been opened to you.";
	return "The video could not be read. Try again.";
}

function theatreDeps(t: ReturnType<typeof useT>): TheatreDeps {
	return {
		resolve: (text, forOther) => resolveVideo(text, { forOther }),
		read: readTicket,
		onRefused: (why) => actionFailed(t(refusal(why))),
	};
}

/**
 * Add what a link plays to the show. True if it was added, or sent to be.
 *
 * Read here by anybody who may read links -- `ready`: signed in, given
 * watching together, on a deployment with a gateway -- and the show is handed
 * only the ticket; started here with it when nobody runs one. Somebody who may
 * not hands the link itself to whoever runs the show, who reads it on their
 * behalf.
 *
 * Read here rather than by the holder because of whose choice a video is. A
 * film from a media server is relayed only for the person given that who chose
 * it, and a link the holder reads for somebody else is said to be somebody
 * else's and refused such a film; so a granted person in somebody else's show,
 * choosing from the media servers, would be refused their own choice if the
 * holder read it. Every link rather than only the media servers' choices,
 * because a media server's film can be pasted as an address too, and because
 * a refusal then always describes the person who sees it.
 */
export async function addVideo(room: Room, text: string, ready: boolean, t: ReturnType<typeof useT>): Promise<boolean> {
	const me = room.localParticipant;
	const by = me.name || me.identity;
	const show = seenShow(room)?.show;

	if (!ready) return command(room, { t: "add", text });

	if (!show) {
		const theatre = startTheatre(room, theatreDeps(t));
		return theatre !== undefined && (await theatre.add(text, by));
	}

	if (show.holder === me.identity) return command(room, { t: "add", text });

	const found = await resolveVideo(text);
	if (typeof found === "string") {
		actionFailed(t(refusal(found)));
		return false;
	}
	rememberInfo(found);

	// The link beside its ticket, for a holder whose page predates tickets: a
	// call outlives an upgrade of the server that holds its pages, and such a
	// holder read only the link and so, handed a ticket alone, read "undefined"
	// and said every link from every newer page was not a video. A current
	// holder takes the ticket. Never for a media server's film, which an older
	// holder would read with its own session -- its own choice, on its own
	// grant -- where a current one reads it as the chooser's.
	const legacy = found.play.kind === "relay" ? {} : { text: text.slice(0, 2000) };
	if (command(room, { t: "add", ticket: found.ticket, ...legacy })) return true;

	// The show ended while the link was being read. What was read is still
	// this person's to play, so it starts the next show rather than being lost.
	const theatre = startTheatre(room, theatreDeps(t));
	return theatre !== undefined && (await theatre.addTicket(found.ticket, by));
}

/**
 * Watching together, in the media panel: a link to paste, and what is playing
 * and coming up.
 *
 * Pasting starts the show here when nobody runs one and this person may
 * resolve links -- they are signed in and were given watching together, on a
 * deployment that has a watch gateway -- and otherwise adds it to whoever's
 * show is running; see addVideo. The video itself plays on the stage; see
 * WatchScreen.
 */
export function WatchTab({ room, ready }: { room: Room; ready: boolean }) {
	const t = useT();
	const seen = useSyncExternalStore(subscribeShow, () => seenShow(room));
	const show = seen?.show;
	const mine = show !== undefined && show.holder === room.localParticipant.identity;
	const [pasted, setPasted] = useState("");
	const [busy, setBusy] = useState(false);

	if (room.options.e2ee !== undefined) {
		return <p className="px-4 py-8 text-center text-fg-muted text-xs">{t("Not available in an encrypted call")}</p>;
	}

	const canAdd = show !== undefined || ready;

	const add = async (event: FormEvent) => {
		event.preventDefault();
		const text = pasted.trim();
		if (!text || busy) return;
		setBusy(true);
		try {
			if (await addVideo(room, text, ready, t)) setPasted("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<form onSubmit={(event) => void add(event)} className="flex gap-1.5 border-border border-b p-2">
				<input
					value={pasted}
					onChange={(event) => setPasted(event.target.value)}
					placeholder={t("A video link, or the text it was shared in")}
					aria-label={t("Video link")}
					maxLength={2000}
					disabled={!canAdd}
					className={cn(
						"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
						"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted disabled:opacity-50",
						"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
					)}
				/>
				<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Add a video")} disabled={!canAdd}>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
				</Button>
			</form>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{show?.now ? (
					<>
						<VideoRow video={show.now} playing />
						{show.queue.map((video) => (
							<VideoRow
								key={video.key}
								video={video}
								onRemove={() => command(room, { t: "remove", key: video.key })}
							/>
						))}
					</>
				) : (
					<div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-fg-muted">
						<Clapperboard className="size-6" />
						<p className="text-xs">
							{canAdd
								? t("Paste a link and everybody watches it together, in step.")
								: t("When somebody signed in starts a video, it shows up here.")}
						</p>
					</div>
				)}
			</div>

			{mine && (
				<div className="flex justify-end border-border border-t p-2">
					<Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => closeTheatre(room)}>
						{t("Stop watching together")}
					</Button>
				</div>
			)}
		</div>
	);
}

function VideoRow({
	video,
	playing,
	onRemove,
}: {
	video: Video;
	playing?: boolean;
	onRemove?: () => void;
}) {
	const t = useT();
	// The title and picture come from the server by the ticket, never from the
	// call: see Video in live/watch.ts.
	const info = useVideoInfo(video.ticket);
	const known = typeof info === "object" ? info : undefined;
	return (
		<div className={cn("flex items-center gap-2.5 rounded-md px-2 py-1.5", playing && "bg-surface-hi/60")}>
			{known?.cover ? (
				<img src={known.cover} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-16 shrink-0 rounded object-cover" />
			) : (
				<span className="h-9 w-16 shrink-0 rounded bg-surface-hi" />
			)}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[12.5px]">
					{known?.title ??
						(info === "unavailable"
							? t("That video cannot be played here.")
							: info === "failed"
								? t("The video could not be read. Try again.")
								: "…")}
				</span>
				<span className="truncate text-[10.5px] text-fg-muted">
					{[playing ? t("Playing") : undefined, t("Added by {name}", { name: video.by }), video.duration ? clock(video.duration) : undefined]
						.filter(Boolean)
						.join(" · ")}
				</span>
			</span>
			{onRemove && (
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t("Take {title} off", { title: known?.title ?? "" })}
					onClick={onRemove}
				>
					<X className="size-3" />
				</Button>
			)}
		</div>
	);
}
