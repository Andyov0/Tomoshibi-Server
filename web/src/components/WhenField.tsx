import { Clock, DayGrid, nextQuarter, startOfDay } from "@/components/calendar";
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useT } from "@/hooks/useT";
import { locale } from "@/live/i18n";
import { cn } from "@/lib/utils";
import { CalendarClock } from "lucide-react";
import { useState } from "react";

/*
 * A day and a time, or none, chosen with the calendar and the clock the lobby
 * arranges meetings with: the start and the end of a guest link.
 *
 * They were the platform's date-and-time field, which in a Chinese page reads
 * "dd/mm/yyyy, --:-- --" and looks like nothing else on it; the owner agreed
 * to their being drawn as the lobby's are. Opened over the page rather than
 * unfolded inside the card, so that choosing a time moves nothing, which the
 * owner had asked of every page.
 *
 * The value is what the platform's field gave, "YYYY-MM-DDTHH:mm" in this
 * machine's time, or "" for none, so the form around it reads it unchanged.
 */

/** "YYYY-MM-DDTHH:mm", in this machine's time, as a time; nothing for anything else. */
export function readLocal(value: string): Date | undefined {
	const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!parts) return undefined;
	const [year, month, day, hour, minute] = parts.slice(1).map(Number) as [number, number, number, number, number];
	return new Date(year, month - 1, day, hour, minute);
}

/** A time as "YYYY-MM-DDTHH:mm", in this machine's time. */
export function writeLocal(at: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}T${two(at.getHours())}:${two(at.getMinutes())}`;
}

export function WhenField({
	value,
	onChange,
	label,
	none,
	earliest,
	future = false,
	className,
}: {
	value: string;
	onChange: (value: string) => void;
	/** What the field is, for a screen reader. */
	label: string;
	/** What no choice means, said in the field. */
	none: string;
	/** The first day offered; today where nothing is said. */
	earliest?: Date;
	/** Whether a time already gone is a mistake worth saying, as an end is. */
	future?: boolean;
	className?: string;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const chosen = readLocal(value);
	// What the clock shows before anything is chosen, and what a day chosen
	// first is given: the next quarter hour, as arranging a meeting starts.
	const shown = chosen ?? nextQuarter();

	const choose = (at: Date) => onChange(writeLocal(at));
	const chooseDay = (day: Date) => {
		const at = new Date(day);
		at.setHours(shown.getHours(), shown.getMinutes(), 0, 0);
		choose(at);
	};
	const chooseTime = (hour: number, minute: number) => {
		const at = chosen ? new Date(chosen) : startOfDay(earliest ?? new Date());
		at.setHours(hour, minute, 0, 0);
		choose(at);
	};

	const gone = future && chosen !== undefined && chosen.getTime() <= Date.now();

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				aria-label={label}
				className={cn("flex items-center gap-2 text-left", !chosen && "text-fg-muted", className)}
			>
				<CalendarClock className="size-3.5 shrink-0 text-fg-muted" />
				<span className="min-w-0 truncate">
					{chosen ? new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short" }).format(chosen) : none}
				</span>
			</PopoverTrigger>

			<PopoverContent aria-label={label} className="flex w-[19.5rem] flex-col gap-3">
				<DayGrid value={chosen} onChange={chooseDay} earliest={earliest} />

				<div className="flex items-center gap-2">
					<Clock
						value={shown.getHours()}
						onChange={(hour) => chooseTime(hour, shown.getMinutes())}
						count={24}
						label={t("Hour")}
					/>
					<span className="text-fg-muted">:</span>
					<Clock
						value={shown.getMinutes() - (shown.getMinutes() % 15)}
						onChange={(minute) => chooseTime(shown.getHours(), minute)}
						count={60}
						step={15}
						label={t("Minute")}
					/>
				</div>

				{gone && <p className="text-[12px] text-danger-ink">{t("That time has already gone.")}</p>}

				<div className="flex items-center justify-between gap-2 border-border border-t pt-3">
					<button
						type="button"
						disabled={!chosen}
						onClick={() => {
							onChange("");
							setOpen(false);
						}}
						className="pressable rounded-md px-2.5 py-1.5 text-[12.5px] text-fg-muted hover:bg-surface-hi hover:text-fg disabled:opacity-40"
					>
						{t("Clear")}
					</button>

					<PopoverClose className="pressable rounded-md bg-fg px-3 py-1.5 font-medium text-[12.5px] text-bg hover:opacity-90">
						{t("Done")}
					</PopoverClose>
				</div>
			</PopoverContent>
		</Popover>
	);
}
