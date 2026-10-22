import { Button } from "@/components/ui/button";
import { useHearing } from "@/hooks/useHearing";
import { useRoster } from "@/hooks/useRoomState";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { type Sound, setBlocked, setVolume, silenced } from "@/live/hearing";
import { isMusic } from "@/live/sound";
import { type Participant, type Room, Track } from "livekit-client";
import { Volume2, VolumeX, X } from "lucide-react";

/**
 * How loud everybody else is.
 *
 * A list of what can be heard, which is deliberately not a list of what can be
 * seen. Sound in this application is rendered outside the stage on purpose —
 * what somebody can hear must not depend on what the layout happens to be
 * drawing — so the person who is too loud is as likely as not to be on the
 * second page, behind a share, or nowhere on screen at all. A control living on
 * a tile could not reach them.
 *
 * One row per thing there is to hear rather than one per person, because a
 * shared screen has a sound of its own and it is a different sound: a film
 * somebody is playing and the voice describing it arrive on separate tracks and
 * are turned down separately. That the two are separate needs no explaining
 * here — it is two rows, and the layout has been showing them as two pictures
 * all along.
 */
export function SoundPanel({ room, onClose }: { room: Room; onClose: () => void }) {
	const t = useT();
	const roster = useRoster(room);

	// Everybody but ourselves. Nobody hears their own microphone, so a row for
	// it would be a control that does nothing.
	const others = roster.filter((participant) => !participant.isLocal);

	return (
		<aside
			className={cn(
				"absolute z-20 flex flex-col overflow-hidden border border-border",
				"bg-surface/95 shadow-2xl backdrop-blur-md",
				// The same frame the messages take: a sheet up the bottom edge
				// while narrow, a card once there is room beside the pictures.
				// They cover the same corner and only one is ever open.
				"inset-x-0 bottom-0 h-[55%] rounded-t-2xl",
				// Room for the controls, which float over this sheet's bottom
				// edge rather than beside it. Without this, the last slider
				// sits underneath them.
				"pb-[calc(env(safe-area-inset-bottom)+3.5rem)] sm:pb-0",
				"sm:inset-x-auto sm:right-3 sm:bottom-3 sm:h-auto sm:w-72 sm:rounded-xl sm:pb-0",
				"sm:max-h-[min(26rem,calc(100%-5.5rem))]",
			)}
		>
			<header className="flex items-center justify-between border-border border-b px-3 py-2">
				<strong className="font-semibold text-[12.5px]">{t("Sound")}</strong>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t("Close sound")}
					onClick={onClose}
				>
					<X className="size-3.5" />
				</Button>
			</header>

			{others.length === 0 ? (
				<p className="px-4 py-8 text-center text-fg-muted text-xs">
					{t("Nobody else is here.")}
				</p>
			) : (
				<div className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
					{others.map((participant) => (
						<Person key={participant.identity} participant={participant} />
					))}
				</div>
			)}
		</aside>
	);
}

/** Everything one person can be heard through. */
function Person({ participant }: { participant: Participant }) {
	const t = useT();
	const name = participant.name || participant.identity;

	// A row for a screen only while one is being shared with sound. A share
	// whose tab audio was never granted has nothing to turn down, and an
	// inert slider would be a promise the picture cannot keep.
	const sharing = participant.getTrackPublication(Track.Source.ScreenShareAudio) !== undefined;
	// And one for the song desk's music, which is a track of its own beside a
	// screen's sound and is turned down on its own.
	const music = [...participant.trackPublications.values()].some((publication) => isMusic(publication));

	return (
		<>
			<SoundRow
				identity={participant.identity}
				sound="voice"
				name={name}
				// Said rather than drawn as a state on the slider: the slider is
				// about what somebody chose, and this is about what the other
				// person is doing at this moment.
				note={participant.isMicrophoneEnabled ? undefined : t("microphone off")}
			/>

			{sharing && (
				<SoundRow
					identity={participant.identity}
					sound="screen"
					name={t("{name} (screen)", { name })}
				/>
			)}

			{music && <SoundRow identity={participant.identity} sound="music" name={t("{name} (music)", { name })} />}
		</>
	);
}

/** One sound's mute and volume: a voice, a shared screen's sound, the music. */
export function SoundRow({
	identity,
	sound,
	name,
	note,
}: {
	identity: string;
	sound: Sound;
	name: string;
	/** Why this may be quiet for a reason nothing here decided. */
	note?: string;
}) {
	const t = useT();
	const heard = useHearing();
	const setting = heard(identity, sound);
	const off = silenced(setting);

	return (
		<div className="flex flex-col gap-1.5 rounded-lg px-2 py-2 hover:bg-surface-hi/60">
			<div className="flex items-baseline gap-2">
				<span className={cn("truncate font-medium text-[12.5px]", off && "text-fg-muted")}>
					{name}
				</span>
				{note && <span className="shrink-0 text-fg-muted text-[10.5px]">{note}</span>}
			</div>

			<div className="flex items-center gap-2">
				<Button
					variant="ghost"
					size="icon"
					className={cn("size-7 shrink-0", setting.blocked ? "text-danger" : "text-fg-muted")}
					// Named for what pressing it does rather than for the state it
					// is in, because the two read as opposites and only one of them
					// is what somebody is deciding.
					aria-label={
						setting.blocked
							? t("Unmute {name}", { name })
							: t("Mute {name}", { name })
					}
					aria-pressed={setting.blocked}
					onClick={() => setBlocked(identity, sound, !setting.blocked)}
				>
					{setting.blocked ? <VolumeX /> : <Volume2 />}
				</Button>

				<input
					type="range"
					min={0}
					max={1}
					step={0.05}
					value={setting.volume}
					// Disabled rather than hidden while blocked. Nothing is
					// arriving to be made louder, and a slider that moves while
					// the sound stays off is a control that lies.
					disabled={setting.blocked}
					aria-label={t("{name}'s volume", { name })}
					onChange={(event) => setVolume(identity, sound, event.target.valueAsNumber)}
					// The browser's own slider, tinted. Stripping its appearance to
					// draw a track by hand takes the thumb with it — the accent
					// colour only applies to a control the browser is still
					// drawing — and this document is declared dark, so what it
					// draws already belongs here.
					className={cn(
						"w-full cursor-pointer accent-fg",
						"focus-visible:outline-2 focus-visible:outline-fg focus-visible:outline-offset-2",
						setting.blocked && "cursor-not-allowed opacity-40",
					)}
				/>

				{/* Read at a glance beside the slider, because a slider near one
				    end tells nobody whether it is at nought. */}
				<span className="readout w-9 shrink-0 text-right text-[10.5px] text-fg-muted tabular-nums">
					{setting.blocked ? t("Muted") : `${Math.round(setting.volume * 100)}%`}
				</span>
			</div>
		</div>
	);
}
