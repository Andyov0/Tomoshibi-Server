/**
 * Turning the server's numbers into something a person reads.
 *
 * The units matter more here than anywhere else in this application. A rate and
 * a total look alike on a screen, and one of them answers "how close are we to
 * the ceiling" while the other answers nothing at all unless you also know when
 * the process started.
 */

/** Bits per second, from the bytes per second the server counts in. */
export function rate(bytesPerSecond: number): string {
	const bits = bytesPerSecond * 8;

	if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
	if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbps`;

	return `${Math.round(bits)} bps`;
}

/** A total, which is bytes and stays bytes. */
export function size(bytes: number): string {
	if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(2)} TB`;
	if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
	if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} kB`;

	return `${bytes} B`;
}

/** A bitrate a codec was configured with, which is bits already. */
export function bitrate(bits: number): string {
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
	if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbps`;

	return `${bits} bps`;
}

/** How long, in the largest unit that still says something. */
export function since(iso: string): string {
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);

	if (seconds < 60) return `${Math.floor(seconds)}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600);
		return `${hours}h ${Math.floor((seconds - hours * 3600) / 60)}m`;
	}

	const days = Math.floor(seconds / 86_400);
	return `${days}d ${Math.floor((seconds - days * 86_400) / 3600)}h`;
}

/** A wall-clock time, to the second, for a log. */
export function clock(iso: string): string {
	return new Date(iso).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** A date, for something that happened on another day. */
export function day(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", {
		year: "numeric",
		month: "short",
		day: "2-digit",
	});
}

/**
 * When a bucket was, said at the precision its width deserves.
 *
 * A six-hour bucket labelled to the second claims an exactness it does not
 * have, and a ten-second bucket labelled only by its date cannot be told from
 * the one beside it. The step is the only thing that knows which of those this
 * is, so it is asked rather than guessed from the value.
 */
export function moment(iso: string, step: number): string {
	if (step >= 86_400) return day(iso);
	if (step >= 3_600) return `${day(iso)} ${clock(iso).slice(0, 5)}`;
	if (step >= 60) return clock(iso).slice(0, 5);

	return clock(iso);
}

/**
 * A count that may be an average of counts.
 *
 * Rooms and people are whole things, but the mean of them over a bucket is not,
 * and rounding two and a half rooms to two says the server was quieter than it
 * was. The decimal appears only when there is one, so the ordinary case still
 * reads as a number of rooms.
 */
export function count(value: number): string {
	return value % 1 === 0 ? String(value) : value.toFixed(1);
}

/**
 * How wide a bucket is, in the shortest form that is still unambiguous.
 *
 * Not translated, and not an oversight: these are unit symbols rather than
 * words, and they are the same symbols in all four languages this interface is
 * written in.
 */
export function width(seconds: number): string {
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
	if (seconds >= 60) return `${Math.round(seconds / 60)}m`;

	return `${Math.round(seconds)}s`;
}

/**
 * What this deployment's link is thought to carry, in bits per second.
 *
 * Used only to draw how full the pipe is. The figure is not measured and cannot
 * be: the server knows what it is sending, not what the wire beneath it can
 * hold. It is what somebody types because they know what they are paying for,
 * and the bars are honest only as far as it is.
 *
 * It was a constant here, and therefore right on exactly one kind of link.
 * Three things read it — the "busy" mark on a relay, the bandwidth bar, and the
 * fixed axis of the six-month plot — so on a 200-megabit deployment the plot
 * sat against the bottom and the mark never appeared, and on a ten-gigabit one
 * the bar was always full and the mark never went out.
 *
 * A gigabit until the deployment says otherwise, which is what it was.
 */
const GIGABIT = 1e9;

let link = GIGABIT;

/** What the pages should draw against. */
export function linkBits(): number {
	return link;
}

/**
 * Told once, from the runtime reading.
 *
 * A function rather than a value passed down, because the three readers are in
 * three components at three depths and the figure belongs to the deployment
 * rather than to any of them.
 */
export function linkIs(mbits: number | undefined): void {
	link = mbits && mbits > 0 ? mbits * 1e6 : GIGABIT;
}
