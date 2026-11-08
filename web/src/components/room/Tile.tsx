import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Signature } from "@/live/name";
import { MicOff, VolumeX } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The frame every participant appears in.
 *
 * A picture rather than a card: no border, no shadow, no rounded panel around
 * the face. The only things attached to it are the name and, while somebody is
 * talking, the tally along the bottom edge — which is the one coloured event in
 * the whole interface.
 *
 * Split from its contents so a camera, an avatar, and a share placeholder all
 * sit in an identically-sized box. The grid measures these, and a tile that
 * sized itself to its contents would make the layout jump as people turn their
 * cameras on.
 *
 * No mark in a corner saying that a press makes it larger. There was one,
 * under the pointer, and it met the stage's own controls in that corner.
 * Leaving it off the picture on the stage was the first answer; the owner then
 * had it taken away on every platform (2026-10-26). The whole picture is what
 * is pressed, and the pointer turning into a hand over it already says so.
 */
export function Tile({
	label,
	signature,
	unverified,
	speaking,
	muted,
	silenced,
	children,
	overlay,
	className,
	onSelect,
	onExpand,
	selected,
	unlabelled = false,
}: {
	label: string;
	/** The mark this person carries, and whether they earned it. */
	signature?: Signature;
	/** Wearing a name somebody else signed, without one of their own. */
	unverified?: boolean;
	speaking?: boolean;
	muted?: boolean;
	/** Turned all the way down, or stopped at the server, by whoever is looking. */
	silenced?: boolean;
	children: ReactNode;
	/** Anything drawn over the picture, such as what this person just said. */
	overlay?: ReactNode;
	className?: string;
	/** A single click, which puts this on the stage or takes it back off. */
	onSelect?: () => void;
	/** A double click, which fills the screen with it. */
	onExpand?: () => void;
	/** Draws no name: for a picture that names itself, as the video watched together does on the stage. */
	unlabelled?: boolean;
	/** Already on the stage, so a click sends it back to the grid. */
	selected?: boolean;
}) {
	const t = useT();
	const interactive = onSelect !== undefined || onExpand !== undefined;

	return (
		<div
			/*
			 * A group named for the person, with a button inside it for the
			 * keyboard, rather than the picture itself acting as the button.
			 *
			 * It was a div with the role of a button, which a reader takes to be
			 * one control and reads by its label alone: "Show Ada larger", and
			 * nothing of the muted microphone on the name, since a button's
			 * contents are not read. And the stage's own buttons were inside it,
			 * a button inside a button, which some readers will not enter at
			 * all. Now the name, its marks and the stage's buttons are read as
			 * themselves, and the press is a button of its own that a keyboard
			 * reaches and nothing sees, its focus drawn around the whole picture.
			 *
			 * The pointer still presses the picture itself, here, rather than a
			 * transparent button laid over it: over it, such a button would sit
			 * on top of whatever the picture holds that can be pressed — the
			 * player's own buttons, when the picture is the film being watched.
			 */
			role={interactive ? "group" : undefined}
			aria-label={interactive ? label : undefined}
			onClick={onSelect}
			onDoubleClick={onExpand}
			className={cn(
				// `size-full` rather than relying on the parent to stretch it: a
				// grid item stretches on its own, but the focus stage and the
				// filmstrip are plain boxes, and a tile whose contents are
				// absolutely positioned collapses to nothing in those.
				"group relative size-full overflow-hidden rounded-tile bg-surface",
				"tally-line",
				speaking && "is-live",
				interactive && cn(
					"cursor-pointer",
					// That a picture can be pressed, said by the pointer and by a
					// hairline that comes and goes with it, now that the mark in
					// the corner is gone; and the keyboard's ring in the same
					// place. Above the picture, which is drawn after this.
					"before:pointer-events-none before:absolute before:inset-0 before:z-10 before:rounded-tile",
					"before:opacity-0 before:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.24)] before:transition-opacity before:duration-150",
					"[@media(hover:hover)]:hover:before:opacity-100",
					"has-[>button[data-press]:focus-visible]:before:opacity-100 has-[>button[data-press]:focus-visible]:before:shadow-[inset_0_0_0_2px_rgb(255_255_255/0.75)]",
				),
				className,
			)}
		>
			{children}

			{interactive && (
				<button
					type="button"
					data-press
					aria-label={selected ? t("Show everybody") : t("Show {name} larger", { name: label })}
					onClick={(event) => {
						// Its own press and not the picture's as well.
						event.stopPropagation();
						onSelect?.();
					}}
					className="sr-only"
				/>
			)}

			{overlay}

			{/*
			 * A capsule, eight in from the corner, the black at seven tenths and
			 * the name always white.
			 *
			 * It was a square-cornered tab at fifty-five per cent with the
			 * speaker's name turned amber. On a shared white page the white name
			 * was four to one and the amber one two to one, which is a name that
			 * disappears exactly while its owner is talking; the line along the
			 * bottom of the picture already says who that is. The blur behind it
			 * is gone too: it is the pictures' plate, not the controls' glass.
			 */}
			<div
				className={cn(
					"pointer-events-none absolute bottom-2 left-2 flex h-6 max-w-[calc(100%-1rem)] items-center gap-1.5 rounded-full bg-black/70 px-2.5",
					unlabelled && "hidden",
				)}
			>
				<span className="truncate font-medium text-[12px] text-white leading-6">{label}</span>

				{/*
				  * A dot for a name somebody proved, and nothing for one they did
				  * not.
				  *
				  * The signature itself used to be printed here, ten characters of
				  * it, beside every name in the room. It is what makes a name
				  * meaningful — it is the thing an impostor cannot copy — but a
				  * meeting is not a place where anybody reads one, and it made
				  * every label twice as long for a string nobody looked at. It is
				  * still there to be read where somebody wants it: the menu on a
				  * picture copies it.
				  *
				  * The mark that survives is the difference, which is the part
				  * that matters at a glance: a proven name has a dot and an
				  * issued one has nothing, and the badge below still says outright
				  * when somebody is wearing a name that belongs to another.
				  */}
				{signature?.proven && (
					<span
						title={t("Only this person can use this name")}
						className="shrink-0 text-[10px] text-white/70"
					>
						·
					</span>
				)}

				{unverified && (
					<span
						title={t("Someone else has proved this name")}
						className="silk shrink-0 rounded bg-danger px-1 py-px text-[9px] text-danger-fg"
					>
						{t("unverified")}
					</span>
				)}

				{/*
			  * One mark, and the reader's own doing wins it.
			  *
			  * Both say the same thing — there is no sound from here — and the
			  * pill has room for one. Whose decision it was is the difference
			  * that matters: a microphone somebody else turned off is nothing to
			  * act on, while a person visibly talking into silence is a question
			  * that has cost people ten minutes before now. The answer belongs on
			  * the picture they are looking at.
			  */}
			{silenced ? (
				<VolumeX
					role="img"
					className="size-3.5 shrink-0 text-danger"
					aria-label={t("Muted by you")}
				/>
			) : (
				muted && (
					<MicOff role="img" className="size-3.5 shrink-0 text-white/80" aria-label={t("microphone off")} />
				)
			)}
			</div>
		</div>
	);
}
