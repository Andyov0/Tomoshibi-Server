import { SoundRow } from "@/components/room/SoundPanel";
import { Button } from "@/components/ui/button";
import { useRoster } from "@/hooks/useRoomState";
import { rememberedDucking, setDucking, subscribeDuck } from "@/live/duck";
import { useT } from "@/hooks/useT";
import { rememberMusicQuality, rememberedMusicQuality } from "@/live/preferences";
import { cn } from "@/lib/utils";
import {
	type DeskDeps,
	type DeskState,
	type Entry,
	addToDesk,
	closeDesk,
	deskState,
	myDesk,
	requestSong,
	sendLink,
	songFrom,
	startDesk,
	subscribeDesk,
	voteToSkip,
} from "@/live/jukebox";
import {
	type Library,
	type LibraryTrack,
	type Linked,
	type Quality,
	audioUrl,
	clock,
	describeAudio,
	describeTrack,
	readLink,
	searchLibrary,
} from "@/live/music";
import { actionFailed, losslessGaveUp } from "@/live/notices";
import {
	fetchLibraryTrack,
	monitorVolume,
	playDecoded,
	rememberedLossless,
	isMusic,
	pauseMusic,
	setMonitorVolume,
	stopMusic,
	subscribePlaying,
} from "@/live/sound";
import type { Room } from "livekit-client";
import { ArrowUpToLine, CircleStop, ListMusic, Loader2, Pause, Play, Plus, Search, SkipForward, X } from "lucide-react";
import { type FormEvent, type SetStateAction, useCallback, useMemo, useState, useSyncExternalStore } from "react";

/**
 * The music panel: the song desk, and the library to choose from.
 *
 * Its own button on the controls rather than an item in the share menu, because
 * everybody in a call has a reason to open it -- to see what is playing, to ask
 * for a song, to turn the music down or off -- and only some of them share
 * anything. Three tabs: the desk, which everybody has; and search and playlists,
 * for whoever can reach the library.
 *
 * Choosing a song adds it to the desk, and starts the desk here if nobody runs
 * one; the desk plays it into the call losslessly, through the share-only-sound
 * path. Somebody who cannot reach the library asks the desk instead: a song's
 * name, which the desk looks up, or a playlist link as it was shared.
 *
 * The volume beside what is playing is the listener's own. For somebody
 * listening it is the same setting the sound panel keeps for that person's
 * shared sound, so muting here stops it at the media server and the lossless
 * stream is not even asked for; for whoever is playing it, it is their own
 * speakers alone, and what everybody else hears is untouched.
 *
 * The library's quality is this browser's, and is kept in live/preferences.ts
 * because the account page offers it too, ahead of any call.
 */

type Tab = "desk" | "search" | "playlist";

/**
 * What the panel was showing, kept per room for as long as the page lives.
 *
 * Not in the components' own state, because a tab not shown and a panel closed
 * are both unmounted, and a playlist somebody had opened was gone the moment
 * they looked at the desk to see what was playing. It stays until they open
 * another; a search, until they search again.
 */
const remembered = new WeakMap<Room, Map<string, unknown>>();

function useRemembered<T>(room: Room, key: string, initial: T | (() => T)): [T, (next: SetStateAction<T>) => void] {
	let book = remembered.get(room);
	if (!book) {
		book = new Map();
		remembered.set(room, book);
	}
	const kept = book;

	const [value, setValue] = useState<T>(() =>
		kept.has(key) ? (kept.get(key) as T) : initial instanceof Function ? initial() : initial,
	);

	const set = useCallback(
		(next: SetStateAction<T>) =>
			setValue((was) => {
				const now = next instanceof Function ? next(was) : next;
				kept.set(key, now);
				return now;
			}),
		[kept, key],
	);

	return [value, set];
}
type Song = ReturnType<typeof songFrom>;

const LINK = /https?:\/\//i;

export function MusicPanel({
	room,
	libraries,
	leaving = false,
	onClose,
}: {
	room: Room;
	/** The libraries this person can reach; absent for somebody who can only ask. */
	libraries?: Library[];
	/** Playing its way out, for the exit animation. */
	leaving?: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const [tab, setTab] = useRemembered<Tab>(room, "tab", "desk");
	const desk = useSyncExternalStore(subscribeDesk, () => deskState(room));
	const mine = desk !== undefined && desk.holder === room.localParticipant.identity;
	const me = room.localParticipant.name || room.localParticipant.identity;

	// Encrypted calls keep the desk to its holder; see live/jukebox.ts.
	const broadcast = room.options.e2ee === undefined;

	const deps = useMemo<DeskDeps | undefined>(
		() =>
			libraries && {
				libraries: () => libraries,
				search: searchLibrary,
				readLink: async (text) => {
					const found = await readLink(text);
					return found && { source: found.source, tracks: found.tracks };
				},
				describe: describeTrack,
				audioUrl,
				fetchTrack: fetchLibraryTrack,
				play: (decoded, onEnded) => playDecoded(room, decoded, rememberedLossless(), losslessGaveUp, onEnded),
				stop: () => stopMusic(room),
				pause: (paused) => pauseMusic(room, paused),
				describeAudio,
				quality: rememberedMusicQuality,
				onSkipped: (entry) => actionFailed(t("Skipped {title}: the library's account cannot play it.", { title: entry.title })),
				onProgress: () => {},
			},
		[libraries, room, t],
	);

	/** The desk to add to: this browser's own, started if there is none anywhere. */
	const add = (songs: Song[]) => {
		if (!desk && deps) {
			startDesk(room, deps, broadcast)?.add(songs, me);
			return;
		}
		if (!addToDesk(room, songs, me)) actionFailed(t("Nobody is running the song desk."));
	};

	const tabs: [Tab, string][] = [["desk", t("Song desk")]];
	if (libraries) tabs.push(["search", t("Search")], ["playlist", t("Playlist")]);

	return (
		<aside
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
				leaving ? "animate-depart" : "animate-arrive",
				"inset-x-0 bottom-0 h-[70%] rounded-t-2xl",
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-[min(34rem,calc(100%-5.5rem))] sm:w-80 sm:rounded-xl",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">{t("Music")}</strong>
				<Button variant="ghost" size="icon" className="size-6" aria-label={t("Close music")} onClick={onClose}>
					<X className="size-3.5" />
				</Button>
			</header>

			{tabs.length > 1 && (
				<div role="tablist" className="flex gap-1 border-border border-b p-1.5">
					{tabs.map(([key, label]) => (
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

			{tab === "desk" && <DeskTab room={room} desk={desk} mine={mine} me={me} deps={deps} broadcast={broadcast} />}
			{tab === "search" && libraries && <SearchTab room={room} libraries={libraries} onAdd={add} />}
			{tab === "playlist" && libraries && <PlaylistTab room={room} onAdd={add} />}
		</aside>
	);
}

function DeskTab({
	room,
	desk,
	mine,
	me,
	deps,
	broadcast,
}: {
	room: Room;
	desk?: DeskState;
	mine: boolean;
	me: string;
	deps?: DeskDeps;
	broadcast: boolean;
}) {
	const t = useT();
	const roster = useRoster(room);
	const [asking, setAsking] = useState("");
	const [busy, setBusy] = useState(false);
	const speakers = useSyncExternalStore(subscribePlaying, monitorVolume);
	const ducks = useSyncExternalStore(subscribeDuck, rememberedDucking);

	const ask = async (event: FormEvent) => {
		event.preventDefault();
		const text = asking.trim();
		if (!text || busy) return;

		setBusy(true);
		try {
			const own = mine ? myDesk(room) : !desk && deps ? startDesk(room, deps, broadcast) : undefined;

			if (own) {
				const done = LINK.test(text) ? (await own.link(text, me)) > 0 : await own.request(text, me);
				if (!done) actionFailed(t(LINK.test(text) ? "That link names no playlist or song." : "Nothing found."));
			} else {
				const sent = LINK.test(text) ? sendLink(room, text) : requestSong(room, text);
				if (!sent) actionFailed(t("Nobody is running the song desk."));
			}
			setAsking("");
		} catch {
			actionFailed(t("The library did not answer. Try again."));
		} finally {
			setBusy(false);
		}
	};

	// Music arriving from somebody whose desk this page has not heard of -- in
	// an encrypted call desks say nothing -- still has a volume here.
	const player = desk
		? undefined
		: roster.find((one) => !one.isLocal && [...one.trackPublications.values()].some((publication) => isMusic(publication)));

	const voted = desk?.votes.includes(room.localParticipant.identity) ?? false;
	const canAsk = desk !== undefined || deps !== undefined;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<div className="flex flex-1 flex-col overflow-y-auto">
				{desk?.now ? (
					<div className="flex flex-col gap-1.5 border-border border-b p-3">
						<div className="flex items-center gap-2.5">
							{desk.now.cover ? (
								<img src={desk.now.cover} alt="" className="size-11 shrink-0 rounded object-cover" />
							) : (
								<span className="flex size-11 shrink-0 items-center justify-center rounded bg-surface-hi">
									<ListMusic className="size-4 text-fg-muted" />
								</span>
							)}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-medium text-[13px]">{desk.now.title}</span>
								<span className="truncate text-[11.5px] text-fg-muted">{desk.now.artists.join(" / ")}</span>
								<span className="truncate text-[10.5px] text-fg-muted">
									{[desk.paused ? t("Paused") : undefined, t("Asked for by {name}", { name: desk.now.by }), desk.quality]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</span>
						</div>

						{mine ? (
							<label className="flex items-center gap-2 px-2 text-[11px] text-fg-muted">
								<span className="shrink-0">{t("In your speakers")}</span>
								<input
									type="range"
									min={0}
									max={1}
									step={0.05}
									value={speakers}
									aria-label={t("Music volume in your speakers")}
									onChange={(event) => setMonitorVolume(room, event.target.valueAsNumber)}
									className="w-full cursor-pointer accent-fg"
								/>
								<span className="readout w-9 shrink-0 text-right tabular-nums">{`${Math.round(speakers * 100)}%`}</span>
							</label>
						) : (
							<SoundRow identity={desk.holder} sound="music" name={t("Music")} />
						)}

						{/* This browser's own, like the volume above it: see live/duck.ts. */}
						<label className="flex cursor-pointer items-center gap-2 px-2 text-[11px] text-fg-muted">
							<input
								type="checkbox"
								checked={ducks}
								onChange={(event) => setDucking(event.target.checked)}
								className="accent-fg"
							/>
							{t("Lower the music while anybody talks")}
						</label>

						<div className="flex gap-1.5">
							{mine ? (
								<>
									<Button
										variant="secondary"
										size="sm"
										className="h-7 gap-1 text-[12px]"
										aria-label={desk.paused ? t("Play") : t("Pause")}
										onClick={() => myDesk(room)?.pause(!desk.paused)}
									>
										{desk.paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
									</Button>
									<Button variant="secondary" size="sm" className="h-7 flex-1 gap-1 text-[12px]" onClick={() => myDesk(room)?.skip()}>
										<SkipForward className="size-3.5" />
										{t("Next song")}
									</Button>
									<Button variant="ghost" size="sm" className="h-7 gap-1 text-[12px]" onClick={() => void closeDesk(room)}>
										<CircleStop className="size-3.5" />
										{t("Stop the desk")}
									</Button>
								</>
							) : (
								<Button
									variant="secondary"
									size="sm"
									className="h-7 flex-1 gap-1 text-[12px]"
									// Not while the next is on its way: the desk does not
									// count those votes; see Desk.vote.
									disabled={voted || desk.loading}
									onClick={() => voteToSkip(room)}
								>
									<SkipForward className="size-3.5" />
									{t("Vote to skip ({votes}/{needed})", {
										votes: String(desk.votes.length),
										needed: String(desk.needed),
									})}
								</Button>
							)}
						</div>
					</div>
				) : player ? (
					<div className="border-border border-b p-1.5">
						<SoundRow
							identity={player.identity}
							sound="music"
							name={t("{name} (music)", { name: player.name || player.identity })}
						/>
					</div>
				) : (
					<div className="flex flex-col items-center gap-2 px-4 py-6">
						<p className="text-center text-fg-muted text-xs">
							{desk
								? t("Nothing is playing. Ask for a song below.")
								: deps
									? t("Search a song or paste a playlist link to start the song desk.")
									: t("When somebody plays music in this call, it shows up here.")}
						</p>
						{/* An idle desk still tells the room it is there, every
						    fifteen seconds; whoever runs it can put it away. */}
						{mine && (
							<Button variant="ghost" size="sm" className="h-7 gap-1 text-[12px]" onClick={() => void closeDesk(room)}>
								<CircleStop className="size-3.5" />
								{t("Stop the desk")}
							</Button>
						)}
					</div>
				)}

				{desk?.next && (
					<div className="flex items-center gap-2 px-3.5 py-2 text-[11.5px] text-fg-muted">
						<Loader2 className="size-3.5 shrink-0 animate-spin" />
						<span className="min-w-0 flex-1 truncate">{t("Loading {title}", { title: desk.next.title })}</span>
						{/* Out of the queue already, and still the holder's to
						    take out: it was on the list a moment ago. */}
						{mine && (
							<Button
								variant="ghost"
								size="icon"
								className="size-6"
								aria-label={t("Take {title} off", { title: desk.next.title })}
								onClick={() => myDesk(room)?.remove(desk.next?.key ?? "")}
							>
								<X className="size-3" />
							</Button>
						)}
					</div>
				)}

				{desk && desk.queue.length > 0 && (
					<ol className="flex flex-col p-1.5">
						{desk.queue.map((entry, index) => (
							<QueueRow key={entry.key} entry={entry} index={index} room={room} mine={mine} />
						))}
					</ol>
				)}
			</div>

			<form onSubmit={(event) => void ask(event)} className="flex gap-1.5 border-border border-t p-2">
				<input
					value={asking}
					onChange={(event) => setAsking(event.target.value)}
					placeholder={t("A song's name, or a playlist link")}
					aria-label={t("Ask for a song")}
					maxLength={2000}
					disabled={!canAsk}
					className={cn(
						"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
						"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted disabled:opacity-50",
						"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
					)}
				/>
				<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Ask for a song")} disabled={!canAsk}>
					{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
				</Button>
			</form>
		</div>
	);
}

function QueueRow({ entry, index, room, mine }: { entry: Entry; index: number; room: Room; mine: boolean }) {
	const t = useT();
	return (
		<li className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hi/60">
			<span className="w-4 shrink-0 text-right text-[11px] text-fg-muted tabular-nums">{index + 1}</span>
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[12.5px]">{entry.title}</span>
				<span className="truncate text-[10.5px] text-fg-muted">
					{[entry.artists.join(" / "), t("Asked for by {name}", { name: entry.by })].filter(Boolean).join(" · ")}
				</span>
			</span>
			{mine && (
				<span className="flex shrink-0 gap-0.5">
					{index > 0 && (
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							aria-label={t("Play {title} next", { title: entry.title })}
							onClick={() => myDesk(room)?.toTop(entry.key)}
						>
							<ArrowUpToLine className="size-3" />
						</Button>
					)}
					<Button
						variant="ghost"
						size="icon"
						className="size-6"
						aria-label={t("Take {title} off", { title: entry.title })}
						onClick={() => myDesk(room)?.remove(entry.key)}
					>
						<X className="size-3" />
					</Button>
				</span>
			)}
		</li>
	);
}

function SearchTab({ room, libraries, onAdd }: { room: Room; libraries: Library[]; onAdd: (songs: Song[]) => void }) {
	const t = useT();
	const [source, setSource] = useRemembered(
		room,
		"search.source",
		() => (libraries.find((one) => one.signedIn) ?? libraries[0])?.id ?? "",
	);
	const [query, setQuery] = useRemembered(room, "search.query", "");
	const [results, setResults] = useRemembered<LibraryTrack[] | undefined>(room, "search.results", undefined);
	const [searching, setSearching] = useState(false);
	const [problem, setProblem] = useState<string>();
	const [added, setAdded] = useRemembered<Set<string>>(room, "search.added", () => new Set());
	const [quality, setQuality] = useState<Quality>(rememberedMusicQuality);
	const library = libraries.find((one) => one.id === source);

	const search = async (event?: FormEvent) => {
		event?.preventDefault();
		const asked = query.trim();
		if (!asked || searching) return;
		setSearching(true);
		setProblem(undefined);
		try {
			setResults(await searchLibrary(source, asked));
		} catch {
			setProblem(t("The library did not answer. Try again."));
		} finally {
			setSearching(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<div className="flex flex-col gap-2 border-border border-b p-2">
				{libraries.length > 1 && (
					<div className="flex gap-1">
						{libraries.map((one) => (
							<button
								key={one.id}
								type="button"
								aria-pressed={one.id === source}
								onClick={() => {
									setSource(one.id);
									setResults(undefined);
								}}
								className={cn(
									"flex-1 rounded-md border px-2 py-1 text-[12px] transition-colors",
									one.id === source
										? "border-tally/50 bg-tally/15 text-fg"
										: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
								)}
							>
								{one.name}
							</button>
						))}
					</div>
				)}
				{library && !library.signedIn && (
					<p className="text-[11.5px] text-fg-muted">{t("Not signed in, so at most 320 kbps.")}</p>
				)}
				<div className="flex items-center gap-1.5">
					<span className="text-[11.5px] text-fg-muted">{t("Quality")}</span>
					{(["lossless", "best"] as const).map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={quality === option}
							onClick={() => {
								setQuality(option);
								rememberMusicQuality(option);
							}}
							className={cn(
								"rounded-md border px-2 py-0.5 text-[11.5px] transition-colors",
								quality === option
									? "border-tally/50 bg-tally/15 text-fg"
									: "border-border text-fg-muted hover:bg-surface-hi hover:text-fg",
							)}
						>
							{t(option === "best" ? "Highest" : "Lossless")}
						</button>
					))}
				</div>
				{quality === "best" && (
					<p className="text-[11px] text-fg-muted">{t("Hi-Res and masters are large, and take longer to start.")}</p>
				)}
				<form onSubmit={(event) => void search(event)} className="flex gap-1.5">
					<input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("Search songs")}
						aria-label={t("Search songs")}
						maxLength={100}
						className={cn(
							"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
							"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
							"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
						)}
					/>
					<Button type="submit" variant="secondary" size="icon" className="size-8" aria-label={t("Search")}>
						{searching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}
					</Button>
				</form>
			</div>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{problem && <p className="px-2 py-2 text-[12px] text-danger">{problem}</p>}
				{results === undefined ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Search for a song to play into the call.")}</p>
				) : results.length === 0 ? (
					<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Nothing found.")}</p>
				) : (
					results.map((track) => (
						<TrackRow
							key={track.id}
							track={track}
							added={added.has(track.id)}
							onAdd={() => {
								onAdd([songFrom(track, source)]);
								setAdded((was) => new Set([...was, track.id]));
							}}
						/>
					))
				)}
			</div>
		</div>
	);
}

function PlaylistTab({ room, onAdd }: { room: Room; onAdd: (songs: Song[]) => void }) {
	const t = useT();
	const [pasted, setPasted] = useRemembered(room, "playlist.pasted", "");
	const [found, setFound] = useRemembered<Linked | undefined>(room, "playlist.found", undefined);
	const [reading, setReading] = useState(false);
	const [problem, setProblem] = useState<string>();
	const [added, setAdded] = useRemembered<Set<string>>(room, "playlist.added", () => new Set());

	const open = async (event: FormEvent) => {
		event.preventDefault();
		if (!pasted.trim() || reading) return;
		setReading(true);
		setProblem(undefined);
		try {
			const linked = await readLink(pasted);
			if (!linked) setProblem(t("That link names no playlist or song."));
			setFound(linked);
			setAdded(new Set());
		} catch {
			setProblem(t("The library did not answer. Try again."));
		} finally {
			setReading(false);
		}
	};

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<form onSubmit={(event) => void open(event)} className="flex gap-1.5 border-border border-b p-2">
				<input
					value={pasted}
					onChange={(event) => setPasted(event.target.value)}
					placeholder={t("Paste a playlist or song link")}
					aria-label={t("Playlist link")}
					maxLength={2000}
					className={cn(
						"h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-hi px-2.5 text-[13px] text-fg",
						"outline-none transition-[border-color,box-shadow] placeholder:text-fg-muted",
						"focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
					)}
				/>
				<Button type="submit" variant="secondary" size="sm" className="h-8 text-[12px]">
					{reading ? <Loader2 className="size-3.5 animate-spin" /> : t("Open")}
				</Button>
			</form>

			<div className="flex flex-1 flex-col overflow-y-auto p-1.5">
				{problem && <p className="px-2 py-2 text-[12px] text-danger">{problem}</p>}
				{found ? (
					<>
						<div className="flex items-center gap-2 px-2 py-1.5">
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-medium text-[12.5px]">{found.title}</span>
								<span className="text-[11px] text-fg-muted">
									{t("{count} songs", { count: String(found.tracks.length) })}
								</span>
							</span>
							<Button
								variant="secondary"
								size="sm"
								className="h-7 text-[12px]"
								disabled={found.tracks.length === 0}
								onClick={() => {
									onAdd(found.tracks.map((track) => songFrom(track, found.source)));
									setAdded(new Set(found.tracks.map((track) => track.id)));
								}}
							>
								{t("Add all")}
							</Button>
						</div>
						{found.tracks.map((track) => (
							<TrackRow
								key={track.id}
								track={track}
								added={added.has(track.id)}
								onAdd={() => {
									onAdd([songFrom(track, found.source)]);
									setAdded((was) => new Set([...was, track.id]));
								}}
							/>
						))}
					</>
				) : (
					!problem && (
						<p className="px-3 py-8 text-center text-fg-muted text-xs">{t("Paste a link shared from a music app.")}</p>
					)
				)}
			</div>
		</div>
	);
}

function TrackRow({ track, added, onAdd }: { track: LibraryTrack; added: boolean; onAdd: () => void }) {
	const t = useT();
	return (
		<button
			type="button"
			onClick={onAdd}
			aria-label={t("Add {title}", { title: track.title })}
			className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-hi"
		>
			{track.cover ? (
				<img src={track.cover} alt="" loading="lazy" className="size-9 shrink-0 rounded object-cover" />
			) : (
				<span className="size-9 shrink-0 rounded bg-surface-hi" />
			)}
			<span className="flex min-w-0 flex-1 flex-col">
				<span className="truncate text-[13px] text-fg">{track.title}</span>
				<span className="truncate text-[11.5px] text-fg-muted">
					{[track.artists.join(" / "), track.album].filter(Boolean).join(" · ")}
				</span>
			</span>
			<span className="shrink-0 text-[11px] text-fg-muted tabular-nums">{added ? t("Added") : clock(track.duration)}</span>
		</button>
	);
}
