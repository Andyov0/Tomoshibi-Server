import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { clock } from "@/live/music";
import { type MediaItem, type MediaServer, browseMedia, mediaLink, searchMedia } from "@/live/watch-api";
import { ChevronLeft, Folder, Loader2, Play, Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

/**
 * The deployment's media servers, browsed: their libraries, what is in them,
 * and a search, for somebody given them choosing what everybody will watch.
 *
 * Choosing something hands its link to the show the way a pasted one is (see
 * onChoose), so a video from a media server is queued, skipped and kept in
 * step like any other. Every address it plays from stays with the gateway.
 * Whose choice it was matters more here than anywhere: a film from a media
 * server is relayed for everybody under the chooser's grant, so the link is
 * read in the chooser's own browser even when somebody else runs the show
 * (addVideo in WatchTab.tsx), never handed to the holder to read.
 */
export function MediaBrowser({
	servers,
	onChoose,
}: {
	servers: MediaServer[];
	/** A playable item was chosen: its link, to add to the show. */
	onChoose: (link: string) => Promise<void> | void;
}) {
	const t = useT();
	const [server, setServer] = useState(servers[0]?.key ?? "");
	// Where in the server: a trail of folders, the first being the server itself.
	const [trail, setTrail] = useState<{ id?: string; name: string }[]>([]);
	const [items, setItems] = useState<MediaItem[]>();
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const [words, setWords] = useState("");
	const [searched, setSearched] = useState<string>();
	const [adding, setAdding] = useState<string>();

	const here = trail.at(-1);

	useEffect(() => {
		if (!server || searched !== undefined) return;
		let live = true;
		setLoading(true);
		setFailed(false);
		void browseMedia(server, here?.id).then((found) => {
			if (!live) return;
			setItems(found);
			setFailed(found === undefined);
			setLoading(false);
		});
		return () => {
			live = false;
		};
	}, [server, here?.id, searched]);

	const search = async (event: FormEvent) => {
		event.preventDefault();
		const asked = words.trim();
		if (!asked) {
			setSearched(undefined);
			return;
		}
		setLoading(true);
		setFailed(false);
		const found = await searchMedia(server, asked);
		setItems(found);
		setFailed(found === undefined);
		setSearched(asked);
		setLoading(false);
	};

	const open = async (item: MediaItem) => {
		if (item.playable) {
			setAdding(item.id);
			try {
				await onChoose(mediaLink(server, item.id));
			} finally {
				setAdding(undefined);
			}
			return;
		}
		if (item.folder) {
			setSearched(undefined);
			setTrail((was) => [...was, { id: item.id, name: item.name }]);
		}
	};

	const back = () => {
		if (searched !== undefined) {
			setSearched(undefined);
			setWords("");
			return;
		}
		setTrail((was) => was.slice(0, -1));
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<div className="flex flex-col gap-2 border-border border-b p-2">
				{servers.length > 1 && (
					<div className="flex gap-1">
						{servers.map((one) => (
							<button
								key={one.key}
								type="button"
								aria-pressed={one.key === server}
								onClick={() => {
									setServer(one.key);
									setTrail([]);
									setSearched(undefined);
								}}
								className={cn(
									"min-w-0 flex-1 truncate rounded-md border px-2 py-1 text-[12px] transition-colors",
									one.key === server
										? "border-tally/50 bg-tally/15 text-fg"
										: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
								)}
							>
								{one.name}
							</button>
						))}
					</div>
				)}
				<form onSubmit={(event) => void search(event)} className="flex gap-1.5">
					<input
						value={words}
						onChange={(event) => setWords(event.target.value)}
						placeholder={t("Search films and series")}
						aria-label={t("Search films and series")}
						maxLength={100}
						className={cn(
							"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
							"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
							"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
						)}
					/>
					<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Search")}>
						<Search className="size-3.5" />
					</Button>
				</form>
				{(trail.length > 0 || searched !== undefined) && (
					<button
						type="button"
						onClick={back}
						className="flex min-w-0 items-center gap-1 self-start text-[12px] text-fg-muted transition-colors hover:text-fg"
					>
						<ChevronLeft className="size-3.5 shrink-0" />
						<span className="truncate">
							{searched !== undefined ? t("Results for {words}", { words: searched }) : here?.name}
						</span>
					</button>
				)}
			</div>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{loading ? (
					<div className="grid place-items-center py-8">
						<Loader2 className="size-5 animate-spin text-fg-muted" />
					</div>
				) : failed ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("The media server did not answer. Try again.")}</p>
				) : items && items.length === 0 ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Nothing found.")}</p>
				) : (
					items?.map((item) => (
						<button
							key={item.id}
							type="button"
							onClick={() => void open(item)}
							disabled={!item.playable && !item.folder}
							aria-label={item.playable ? t("Watch {title}", { title: item.name }) : item.name}
							className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hi disabled:opacity-50"
						>
							{item.image ? (
								<img src={item.image} alt="" loading="lazy" className="h-12 w-8 shrink-0 rounded object-cover" />
							) : (
								<span className="grid h-12 w-8 shrink-0 place-items-center rounded bg-surface-hi">
									{item.folder ? <Folder className="size-3.5 text-fg-muted" /> : <Play className="size-3.5 text-fg-muted" />}
								</span>
							)}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate text-[13px] text-fg">{item.name}</span>
								<span className="truncate text-[11px] text-fg-muted">
									{[item.year || undefined, item.duration ? clock(item.duration) : undefined].filter(Boolean).join(" · ")}
								</span>
							</span>
							{adding === item.id && <Loader2 className="size-3.5 shrink-0 animate-spin text-fg-muted" />}
						</button>
					))
				)}
			</div>
		</div>
	);
}
