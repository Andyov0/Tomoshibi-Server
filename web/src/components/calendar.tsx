import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

/*
 * Choosing a day and a time with the pieces the rest of the interface is drawn
 * with, rather than the platform's date-and-time field, which looks different
 * on every browser and good on none, cannot be styled, and in a Chinese page
 * reads "dd/mm/yyyy, --:-- --". The lobby's arranging was drawn with these
 * first; the account's guest links use them now as well (WhenField).
 */

/**
 * A month of days to choose from, from a first day (today, unless said) to a
 * last one, or onward without end: the lobby's arranging, limited to the sixty
 * days the server allows, and the account's guest links, whose end may be any
 * day after their start.
 *
 * Weeks start on Monday, which is how every calendar this deployment's people
 * grew up with is printed. Days outside the window are drawn and disabled
 * rather than hidden, so the grid keeps its shape from one month to the next.
 */
export function DayGrid({
	value,
	onChange,
	earliest,
	latest,
}: {
	value?: Date;
	onChange: (day: Date) => void;
	/** The first day offered; today where nothing is said. */
	earliest?: Date;
	/** The last day offered; none where nothing is said. */
	latest?: Date;
}) {
	const t = useT();
	const today = startOfDay(new Date());
	const from = earliest ? startOfDay(earliest) : today;

	const [shown, setShown] = useState(() => {
		const opening = value ?? from;
		return new Date(opening.getFullYear(), opening.getMonth(), 1);
	});

	const monthSaid = new Intl.DateTimeFormat(locale(), { month: "long", year: "numeric" }).format(shown);
	const weekdays = useMemo(() => {
		const f = new Intl.DateTimeFormat(locale(), { weekday: "narrow" });
		// A known Monday.
		return Array.from({ length: 7 }, (_, n) => f.format(new Date(2024, 0, 1 + n)));
	}, []);

	// The cells: leading blanks so the first falls on its weekday, then the
	// month's days.
	const first = new Date(shown.getFullYear(), shown.getMonth(), 1);
	const lead = (first.getDay() + 6) % 7;
	const count = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();

	const earlier = new Date(shown.getFullYear(), shown.getMonth() - 1, 1);
	const later = new Date(shown.getFullYear(), shown.getMonth() + 1, 1);
	const canGoBack = earlier >= new Date(from.getFullYear(), from.getMonth(), 1);
	const canGoOn = latest === undefined || later <= latest;

	return (
		<div className="flex w-full max-w-sm flex-col gap-2 rounded-[14px] border border-border bg-surface-hi p-2">
			<div className="flex items-center justify-between">
				<button
					type="button"
					onClick={() => setShown(earlier)}
					disabled={!canGoBack}
					aria-label={t("Previous month")}
					className="pressable grid size-8 place-items-center rounded-full text-fg-muted hover:bg-surface disabled:opacity-30 pointer-coarse:size-11"
				>
					<ChevronLeft className="size-4" />
				</button>
				<span className="truncate text-[12.5px] font-medium">{monthSaid}</span>
				<button
					type="button"
					onClick={() => setShown(later)}
					disabled={!canGoOn}
					aria-label={t("Next month")}
					className="pressable grid size-8 place-items-center rounded-full text-fg-muted hover:bg-surface disabled:opacity-30 pointer-coarse:size-11"
				>
					<ChevronRight className="size-4" />
				</button>
			</div>

			<div className="grid grid-cols-7 gap-0.5 text-center">
				{weekdays.map((w, n) => (
					<span key={String(n)} className="py-1 text-[10.5px] text-fg-muted">
						{w}
					</span>
				))}

				{Array.from({ length: lead }, (_, n) => (
					<span key={`lead-${String(n)}`} />
				))}

				{Array.from({ length: count }, (_, n) => {
					const d = new Date(shown.getFullYear(), shown.getMonth(), n + 1);
					const offered = d >= from && (latest === undefined || d <= latest);
					const chosen = value !== undefined && sameDay(d, value);
					const isToday = sameDay(d, today);

					return (
						<button
							key={String(n)}
							type="button"
							disabled={!offered}
							onClick={() => onChange(d)}
							aria-pressed={chosen}
							aria-label={new Intl.DateTimeFormat(locale(), { dateStyle: "full" }).format(d)}
							className={cn(
								// Forty-four tall under a finger, and as wide as seven
								// across a phone allows, which at 375 is forty-one.
								"h-9 rounded-[10px] text-[13px] transition-colors pointer-coarse:h-11 pointer-coarse:text-[15px]",
								offered ? "hover:bg-surface" : "opacity-30",
								chosen && "bg-fg text-bg hover:bg-fg",
								isToday && !chosen && "ring-1 ring-fg/40",
							)}
						>
							{n + 1}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** One of the two halves of a time. A platform select, which draws a list of
 * twenty-four well and needs no styling to be read. */
export function Clock({
	value,
	onChange,
	count,
	step = 1,
	label,
}: {
	value: number;
	onChange: (n: number) => void;
	count: number;
	step?: number;
	label: string;
}) {
	return (
		<select
			value={value}
			onChange={(event) => onChange(Number(event.target.value))}
			aria-label={label}
			className={cn(
				"h-9 w-24 rounded-[10px] border border-border bg-surface-hi px-2 text-sm text-fg pointer-coarse:h-11 pointer-coarse:text-base",
				"outline-none transition-colors focus-visible:border-fg/40 focus-visible:ring-2 focus-visible:ring-fg/25",
			)}
		>
			{Array.from({ length: Math.ceil(count / step) }, (_, n) => n * step).map((n) => (
				<option key={n} value={n}>
					{String(n).padStart(2, "0")}
				</option>
			))}
		</select>
	);
}

export function nextQuarter(): Date {
	const d = new Date();
	d.setSeconds(0, 0);
	d.setMinutes(Math.ceil((d.getMinutes() + 1) / 15) * 15);
	return d;
}

export function startOfDay(d: Date): Date {
	const s = new Date(d);
	s.setHours(0, 0, 0, 0);
	return s;
}

export function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
