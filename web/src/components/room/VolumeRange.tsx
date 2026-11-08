import { louderThanSent } from "@/live/notices";
import { useId } from "react";

/**
 * A volume slider that goes past as loud as it was sent: to three times
 * (hearing.ts, MAX_VOLUME), or to `max` where a sound cannot be made louder
 * than sent here (a YouTube player, a video from another origin; see
 * WatchScreen).
 *
 * The browser's own slider, as before, with a mark at as-sent: past it is where
 * hearing can be harmed, and the browser draws a listed value as a tick and
 * lets the thumb settle on it, so dragging back finds as-sent rather than a
 * hair either side. Crossing above it says so, every time (notices.ts,
 * louderThanSent).
 */
export function VolumeRange({
	value,
	max,
	onChange,
	label,
	echo,
	disabled,
	className,
}: {
	value: number;
	max: number;
	onChange: (volume: number) => void;
	label: string;
	/** Somebody else's sound in the call, which above one may come back to them; see louderThanSent. */
	echo: boolean;
	disabled?: boolean;
	className?: string;
}) {
	const marks = useId();

	return (
		<>
			<input
				type="range"
				min={0}
				max={max}
				step={0.05}
				value={Math.min(value, max)}
				list={max > 1 ? marks : undefined}
				disabled={disabled}
				aria-label={label}
				onChange={(event) => {
					const next = event.target.valueAsNumber;
					if (next > 1 && value <= 1) louderThanSent(echo);
					onChange(next);
				}}
				className={className}
			/>
			{max > 1 && (
				<datalist id={marks}>
					<option value={1} />
				</datalist>
			)}
		</>
	);
}
