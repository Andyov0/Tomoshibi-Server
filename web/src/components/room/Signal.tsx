import { cn } from "@/lib/utils";
import { useT } from "@/hooks/useT";
import { Flagged } from "@/components/room/Flag";
import { useLingering } from "@/hooks/useLingering";
import type { Grade, Reading } from "@/live/connection";
import { useState } from "react";
import { keep, recall } from "@/lib/storage";

/**
 * How the call is going, in the corner.
 *
 * Two readings of the same thing, and which one somebody wants depends entirely
 * on why they looked. Most of the time the question is "is it me?", and the
 * answer is a colour and a number: bars and a round trip, small enough to
 * ignore. Occasionally the question is "what exactly is wrong?", and then
 * nothing short of the figures will do.
 *
 * So it is one control with two sizes rather than two features. Pressing it
 * opens the detail, and the choice is remembered — somebody who wants the
 * numbers usually wants them in every call, and somebody who does not never
 * wants to be asked again.
 *
 * Deliberately not a warning. It does not appear when things go wrong and
 * disappear when they are fine, because a light that only shows up in trouble
 * is one nobody can find when they need it, and its absence gets read as
 * "nothing is being measured" rather than "everything is well".
 */
export function Signal({
	reading,
	relay,
	carrying,
}: {
	reading: Reading;
	relay?: string;
	carrying?: string;
}) {
	const t = useT();
	const [open, setOpen] = useState(() => remembered());

	// Held on screen while it leaves. Rendered as `open && ...`, the panel was
	// simply gone on the frame after the press — it opened from the button and
	// closed by vanishing, which reads as the page having redrawn itself.
	const { mounted, leaving } = useLingering(open);

	const title =
		reading.grade === "lost"
			? t("Connection lost")
			: reading.grade === "poor"
				? t("Poor connection")
				: reading.grade === "fair"
					? t("Fair connection")
					: t("Good connection");

	return (
		<div className="pointer-events-auto">
			<button
				type="button"
				aria-label={title}
				title={title}
				onClick={() => {
					const next = !open;
					setOpen(next);
					remember(next);
				}}
				className={cn(
					"flex items-center gap-2 rounded-full bg-surface-hi/90 px-2.5 py-1.5 shadow backdrop-blur",
					"text-xs transition-colors hover:bg-surface-hi",
				)}
			>
				<Bars grade={reading.grade} />

				{/* The number beside the bars, because the bars alone cannot tell a
				    call that is merely far from one that is breaking. */}
				<span className="readout tabular-nums text-fg-muted">
					{reading.rttMs === undefined ? "—" : `${reading.rttMs} ms`}
				</span>
			</button>

			{mounted && (
				<Detail reading={reading} relay={relay} carrying={carrying} leaving={leaving} />
			)}
		</div>
	);
}

/**
 * Three bars, as a phone draws them.
 *
 * The shape is borrowed on purpose: everybody already reads it, and a legend is
 * a thing nobody looks at twice. Colour and height say the same thing twice,
 * which is what keeps it legible to somebody who cannot tell the colours apart.
 */
function Bars({ grade }: { grade: Grade }) {
	const lit = grade === "good" ? 3 : grade === "fair" ? 2 : grade === "poor" ? 1 : 0;

	const colour =
		grade === "good"
			? "bg-good"
			: grade === "fair"
				? "bg-tally"
				: "bg-danger";

	return (
		<span className="flex items-end gap-[2px]" aria-hidden="true">
			{[0, 1, 2].map((index) => (
				<span
					key={index}
					className={cn(
						"w-[3px] rounded-[1px] transition-colors",
						index === 0 && "h-1.5",
						index === 1 && "h-2.5",
						index === 2 && "h-3.5",
						index < lit ? colour : "bg-fg-muted/30",
					)}
				/>
			))}
		</span>
	);
}

/** Everything the browser knows, for when the bars are not enough. */
function Detail({
	reading,
	relay,
	carrying,
	leaving,
}: {
	reading: Reading;
	relay?: string;
	carrying?: string;
	leaving: boolean;
}) {
	const t = useT();

	// Said by the server, which picked both machines, and by nothing else.
	//
	// This used to be worked out here, by comparing the relay's name against the
	// region the media server reports for the node holding the room. That was
	// wrong in both directions and quietly. With no regions configured the two
	// were never different, so a forwarded call looked exactly like a direct
	// one and the second line never appeared. With regions configured they are
	// never the same — one is a label a person reads and the other is an
	// internal name — so every call would claim to be forwarded.
	//
	// The server picked the entry and knows where the room is. It sends the
	// second name only when there is a second machine, so the absence of one is
	// the answer rather than the beginning of a comparison.
	const relayed = Boolean(relay && carrying);

	return (
		<dl
			className={cn(
				"mt-1.5 flex min-w-44 flex-col gap-1 rounded-lg px-3 py-2 text-[11px]",
				"bg-surface-hi/90 shadow-lg ring-1 ring-black/30 backdrop-blur",
				// From under the bars it belongs to, rather than appearing: a panel
				// that is simply there on the next frame reads as the page having
				// redrawn itself.
				"origin-top",
				leaving ? "animate-depart" : "animate-arrive",
			)}
		>
			{/*
			  * Where this call was sent, and where its media is actually going.
			  *
			  * They are usually the same machine and occasionally not: a meeting
			  * lives on one server, so somebody who picked a different one has
			  * their signalling forwarded to it and their voice sent straight
			  * there. That is not a fault and it is not visible anywhere else —
			  * the picker says one thing and the packets do another, and only
			  * this says both.
			  */}
			{/*
			  * One line where the call is on the machine that was dialled, and
			  * two where it is not. A meeting lives on one server: somebody who
			  * picked a different one has their signalling forwarded to it, so
			  * the machine they chose and the machine carrying the call are two
			  * different machines — and there is nowhere else that says so.
			  *
			  * Named on both sides rather than addressed. The relay reports what
			  * it calls itself, so nothing here has to hold a map from addresses
			  * to names, and no address reaches the screen.
			  */}
			{relayed ? (
				<>
					<Figure label={t("Relay server")} value={relay ?? "—"} delay={0} />
					<Figure label={t("Original server")} value={carrying ?? "—"} delay={30} />
				</>
			) : (
				relay && <Figure label={t("Server")} value={relay} delay={0} />
			)}
			{reading.ownAddress && <Figure label={t("Your address")} value={reading.ownAddress} delay={60} />}

			<Figure
				label={t("Round trip")}
				value={reading.rttMs === undefined ? "—" : `${reading.rttMs} ms`}
				delay={90}
			/>
			<Figure
				label={t("Lost")}
				value={reading.lossPercent === undefined ? "—" : `${reading.lossPercent.toFixed(1)}%`}
				warn={(reading.lossPercent ?? 0) > 2}
				delay={120}
			/>
			<Figure
				label={t("Jitter")}
				value={reading.jitterMs === undefined ? "—" : `${reading.jitterMs} ms`}
				delay={150}
			/>
			{/* Only while something is being shared, so the row is not a
			    permanent dash — and read from the encoder rather than from the
			    settings, because the settings are a request. Somebody who chose
			    4K at sixty and is getting nineteen has nowhere else to find out. */}
			{reading.share && (
				<Figure
					label={reading.share.sending ? t("Sharing") : t("Watching")}
					value={
						reading.share.height && reading.share.fps
							? `${reading.share.height}p · ${reading.share.fps} fps`
							: t("Measuring…")
					}
					warn={reading.share.fps !== undefined && reading.share.fps < 10}
					delay={180}
				/>
			)}

			{/*
			 * Why the picture is not what was asked for, from the encoder itself.
			 *
			 * A share that stutters is the complaint somebody can do least about,
			 * and the two things that cause it want opposite answers: a machine
			 * that cannot encode fast enough is fixed by asking for less, and a
			 * path that cannot carry it is fixed by choosing a nearer server.
			 * Identical on screen, and the browser has known which all along.
			 *
			 * Shown only while something is holding it back — the ordinary state
			 * is a line that says nothing is wrong, which is a line read every
			 * time to learn nothing.
			 */}
			{reading.share?.limited && (
				<Figure
					label={t("Held back by")}
					value={
						reading.share.limited === "cpu"
							? t("this machine")
							: reading.share.limited === "bandwidth"
								? t("the connection")
								: t("something the browser will not name")
					}
					warn
					delay={195}
				/>
			)}

			<Figure label={t("Sending")} value={rate(reading.upKbps)} delay={210} />
			<Figure label={t("Receiving")} value={rate(reading.downKbps)} delay={240} />

			{!reading.measured && (
				<span className="pt-0.5 text-fg-muted">{t("Measuring…")}</span>
			)}
		</dl>
	);
}

/**
 * One line of the detail.
 *
 * The value transitions colour rather than snapping, because these numbers
 * change while somebody is reading them: a round trip that crosses a band would
 * otherwise flick between two colours on every poll, which reads as a fault
 * rather than as a measurement.
 */
function Figure({
	label,
	value,
	warn,
	delay = 0,
}: { label: string; value: string; warn?: boolean; delay?: number }) {
	return (
		<div
			style={{ animationDelay: `${delay}ms` }}
			className="flex animate-arrive items-baseline justify-between gap-4"
		>
			<dt className="text-fg-muted">{label}</dt>
			<dd
				className={cn(
					"readout tabular-nums transition-colors duration-300",
					warn ? "text-tally" : "text-fg",
				)}
			>
				{/* A relay's name arrives here with a flag in it, and on Windows
				    there is no glyph for one. */}
				<Flagged text={value} />
			</dd>
		</div>
	);
}

/**
 * A rate, in the unit that keeps it short.
 *
 * Megabits above a thousand kilobits, because a screen share reads as five
 * figures otherwise and the digits that change are the ones nobody needs.
 */
function rate(kbps: number | undefined): string {
	if (kbps === undefined) return "—";
	if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;

	return `${Math.round(kbps)} kbps`;
}

/**
 * Whether the detail was left open.
 *
 * Kept under the old product name, as every other key here is: it is what a
 * browser already has written down, and renaming one abandons it.
 */
const DETAIL_KEY = "meet-live.signal-detail";

function remembered(): boolean {
	try {
		return recall(DETAIL_KEY) === "open";
	} catch {
		// A browser refusing storage is a browser that shows the small one every
		// time, which is the same as never having chosen.
		return false;
	}
}

function remember(open: boolean): void {
	try {
		keep(DETAIL_KEY, open ? "open" : "closed");
	} catch {
		// Nothing depends on it being written down.
	}
}
