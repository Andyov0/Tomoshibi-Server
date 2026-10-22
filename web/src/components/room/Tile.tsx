import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Signature } from "@/live/name";
import { Maximize2, MicOff, Minimize2, VolumeX } from "lucide-react";
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
			// A div rather than a button: a tile holds a video and its own
			// controls, and a button may contain neither. The role and the key
			// handler are what a button would have provided.
			role={interactive ? "button" : undefined}
			tabIndex={interactive ? 0 : undefined}
			aria-pressed={interactive ? selected : undefined}
			aria-label={
				interactive
					? selected
						? t("Show everybody")
						: t("Show {name} larger", { name: label })
					: undefined
			}
			onClick={onSelect}
			onDoubleClick={onExpand}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect?.();
				}
			}}
			className={cn(
				// `size-full` rather than relying on the parent to stretch it: a
				// grid item stretches on its own, but the focus stage and the
				// filmstrip are plain boxes, and a tile whose contents are
				// absolutely positioned collapses to nothing in those.
				"group relative size-full overflow-hidden rounded-tile bg-surface",
				"tally-line",
				speaking && "is-live",
				interactive && "cursor-pointer outline-none",
				interactive && "focus-visible:ring-2 focus-visible:ring-fg/70",
				className,
			)}
		>
			{children}
			{overlay}

			{/* Over the picture rather than beside it: anything occupying layout
			    space would reflow the grid as the pointer crossed it. */}
			{interactive && (
				<div className="pointer-events-none absolute top-2 right-2 rounded-md bg-black/55 p-1.5 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
					{selected ? (
						<Minimize2 className="size-3.5 text-fg" />
					) : (
						<Maximize2 className="size-3.5 text-fg" />
					)}
				</div>
			)}

			{/* A pill rather than a gradient scrim. A scrim darkens the bottom
			    third of every picture to make a few words legible, which is a
			    lot of picture to spend on a name. */}
			<div
				className={cn(
					"pointer-events-none absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-md bg-black/55 px-1.5 py-0.5 backdrop-blur-sm",
					unlabelled && "hidden",
				)}
			>
				<span
					className={cn(
						"truncate font-medium text-[11.5px] leading-5",
						speaking ? "text-tally" : "text-fg",
					)}
				>
					{label}
				</span>

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
						className="shrink-0 text-[10px] text-fg-muted"
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
					className="size-3 shrink-0 text-danger"
					aria-label={t("Muted by you")}
				/>
			) : (
				muted && (
					<MicOff className="size-3 shrink-0 text-fg-muted" aria-label={t("microphone off")} />
				)
			)}
			</div>
		</div>
	);
}
