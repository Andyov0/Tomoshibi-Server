import { useAppearance } from "@/hooks/useAppearance";
import type { Appearance } from "@/live/appearance";
import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Point } from "./api";
import { linkBits, rate } from "./units";

/**
 * The uplink over whatever stretch of time was asked for.
 *
 * uPlot rather than a React charting library, and the deciding figure is the
 * one it is measured against: this bundle is nineteen kilobytes, and the
 * declarative alternatives are five times that with a dozen d3 packages behind
 * them. A dependency that outweighs everything it draws for is worth noticing
 * even where, as here, it never reaches anybody in a meeting.
 *
 * Its interface is imperative, which is what the wrapper below is. The plot is
 * built once and fed afterwards: rebuilding it on every poll would throw away
 * the canvas twice a second and take the pointer's position with it — and
 * rebuilding it when the span changes would flash a blank chart between one
 * range and the next, which reads as the page having broken rather than as a
 * different question being answered.
 *
 * Three lines rather than two. The band behind the amber one is the highest
 * single reading inside each bucket, and it is the whole reason a six-month
 * chart is worth drawing at all: a bucket six hours wide has a mean that a
 * two-minute burst to the ceiling barely moves, so a chart of means says an
 * evening was quiet on the evening somebody is asking about. The incoming rate
 * gets no band — one pair of bands is a picture and two is a smear, and the
 * question being asked here is about what this server sends.
 */
export function Trend({
	points,
	onHover,
	className,
}: {
	points: Point[];
	/** Which bucket the pointer is over, or null when it has left. */
	onHover?: (index: number | null) => void;
	className?: string;
}) {
	const host = useRef<HTMLDivElement>(null);
	const plot = useRef<uPlot>();

	// Held in a ref so the effect that builds the plot does not depend on the
	// data, and the effect that feeds it does not rebuild.
	const latest = useRef(points);
	latest.current = points;

	// The same, for the callback: a parent that rebuilds it on every render
	// would otherwise rebuild the plot on every render, and uPlot's hooks are
	// fixed at construction.
	const hover = useRef(onHover);
	hover.current = onHover;

	// The one thing that does rebuild it. A canvas is handed its colours once
	// and keeps them, so without this a chart drawn by night would stay drawn
	// by night on a page that had turned to day; the blank frame the rebuild
	// costs is lost in the whole page changing colour around it.
	const appearance = useAppearance();

	useEffect(() => {
		const element = host.current;
		if (!element) return;

		// Nothing to draw on, which is not a fault: the chart is a decoration on a
		// page whose numbers are all written out beside it, and a document with no
		// canvas — a test environment, a browser with it turned off — should get
		// the page without the picture rather than an exception thrown out of a
		// render. It was throwing four of them per run and turning the whole
		// suite red, which is the state in which nobody reads a failure.
		if (!element.ownerDocument.createElement("canvas").getContext?.("2d")) return;

		const made = new uPlot(
			options(element.clientWidth, INK[appearance], (index) => hover.current?.(index)),
			series(latest.current),
			element,
		);
		plot.current = made;

		// The width is the container's, and the container is a page somebody may
		// turn sideways. uPlot does not observe its own element.
		const observer = new ResizeObserver(([entry]) => {
			if (entry) made.setSize({ width: entry.contentRect.width, height: HEIGHT });
		});
		observer.observe(element);

		return () => {
			observer.disconnect();
			made.destroy();
			plot.current = undefined;
		};
	}, [appearance]);

	useEffect(() => {
		plot.current?.setData(series(points));
	}, [points]);

	return <div ref={host} className={className} />;
}

const HEIGHT = 150;

/*
 * The rate axis's width, from the longest label it is about to draw.
 *
 * It was forty-six pixels, and "1.00 Gbps" and "500.0 Mbps" in ten-pixel
 * monospace are fifty-four and sixty, so both were drawn with their first
 * characters outside the canvas: the scale read "00 Gbps" and ".0 Mbps", in
 * either appearance (the health check of 2026-10-29). Worked out from the
 * number of characters rather than measured on the canvas: the face is
 * monospace, whichever one the system has, and every common one is at most
 * about six-tenths of an em wide, so this is exact enough and needs no canvas,
 * which the tests do not have. Never narrower than it was, so a scale with
 * short labels keeps the plot where it always sat.
 */
const MONO_ADVANCE = 0.62 * 10;
const AXIS_GAP = 5 + 4;

export function rateAxisWidth(values: string[] | null): number {
	const longest = (values ?? []).reduce((most, one) => Math.max(most, one.length), 0);

	return Math.max(46, Math.ceil(longest * MONO_ADVANCE + AXIS_GAP));
}

/** Half the widest time label ("10:00am", seven characters), and a little over. */
const LAST_LABEL = 24;

/*
 * The chart's colours, which a canvas cannot take from the stylesheet.
 *
 * Night is what these always were, written out as the stylesheet's own values
 * once converted — the axis and the incoming line in the muted foreground, the
 * grid in the border, the outgoing line and its band in the amber — and day is
 * the same roles in the day values (index.css). Said as strings rather than
 * read from the stylesheet at run time, so that night is drawn with exactly
 * the strings it was drawn with before there was a day.
 */
export const INK: Record<Appearance, Ink> = {
	night: {
		text: "#97928c",
		rule: "#2e2c2a",
		line: "#ffa23b",
		lineFill: "rgba(255, 162, 59, 0.16)",
		peak: "rgba(255, 162, 59, 0.35)",
		peakFill: "rgba(255, 162, 59, 0.10)",
	},
	day: {
		// The stylesheet's day muted, which was raised from three fifths to
		// three quarters so that quieter text reads at four and a half to one
		// on white; the chart kept the three fifths, and its axis and its
		// incoming line were the one muted thing on the page still at three
		// and a third.
		text: "rgba(60, 60, 67, 0.75)",
		rule: "rgba(0, 0, 0, 0.1)",
		line: "#f2901e",
		lineFill: "rgba(242, 144, 30, 0.16)",
		peak: "rgba(242, 144, 30, 0.35)",
		peakFill: "rgba(242, 144, 30, 0.10)",
	},
};

interface Ink {
	text: string;
	rule: string;
	line: string;
	lineFill: string;
	peak: string;
	peakFill: string;
}

/**
 * The four rows uPlot wants: time, then one per line.
 *
 * Exported for its arithmetic rather than for any caller. Two of the three ways
 * this goes wrong are invisible on a chart — the band drawn from the mean
 * instead of the peak simply disappears, and bytes drawn as bits sit at an
 * eighth of the height against a scale fixed to the link, which looks like a
 * quiet evening. Neither can be seen from a test environment, which has no
 * canvas to draw on at all.
 */
export function series(points: Point[]): uPlot.AlignedData {
	const at = new Array<number>(points.length);
	const peak = new Array<number>(points.length);
	const out = new Array<number>(points.length);
	const into = new Array<number>(points.length);

	points.forEach((point, index) => {
		at[index] = new Date(point.at).getTime() / 1000;
		// Bits, because that is the unit a link is sold in and the unit the
		// ceiling below is drawn from.
		peak[index] = point.outPeak * 8;
		out[index] = point.out * 8;
		into[index] = point.in * 8;
	});

	return [at, peak, out, into];
}

function options(width: number, ink: Ink, hovered: (index: number | null) => void): uPlot.Options {
	return {
		width: Math.max(width, 1),
		height: HEIGHT,
		// Room on the right for half of the last time label, which is drawn
		// centred on its tick at the plot's edge: with four pixels its second
		// half was outside the canvas and cut off.
		padding: [8, LAST_LABEL, 0, 0],
		cursor: { y: false, points: { size: 5 } },
		legend: { show: false },
		// uPlot's own legend is off, so the readout beside the chart is fed from
		// the cursor directly. `idx` is null whenever the pointer is outside the
		// plot, which is what closes the readout — read from the source rather
		// than from the documentation, which describes the legend and not this.
		hooks: { setCursor: [(self) => hovered(self.cursor.idx ?? null)] },
		scales: {
			// Fixed to the link rather than to whatever the data happens to
			// reach. A plot that rescales to its own maximum always looks the
			// same, and the one thing this exists to show — how near the ceiling
			// an evening came — is exactly what that normalises away.
			//
			// Asked each time the data is set rather than read once here. The
			// chart is built before the runtime reading that says what the line
			// carries has come back, so a hundred-megabit deployment's chart
			// was drawn against a gigabit for as long as the page stayed open,
			// with the bar beneath it saying two per cent of a hundred megabits
			// and the axis saying a gigabit (seen on 2026-10-29). Auto, so that
			// uPlot asks the range again on each setData — with auto off it
			// asks once, at construction, which was the fault — and a range
			// that ignores the data it is handed, so auto rescales nothing.
			y: { auto: true, range: () => [0, linkBits()] },
		},
		axes: [
			{
				stroke: ink.text,
				grid: { stroke: ink.rule, width: 1 },
				ticks: { stroke: ink.rule, width: 1 },
				font: "10px ui-monospace, Menlo, monospace",
				size: 28,
			},
			{
				stroke: ink.text,
				grid: { stroke: ink.rule, width: 1 },
				ticks: { show: false },
				font: "10px ui-monospace, Menlo, monospace",
				size: (_, values) => rateAxisWidth(values),
				values: (_, ticks) => ticks.map((bits) => (bits === 0 ? "" : rate(bits / 8))),
			},
		],
		series: [
			{},
			// Drawn first, so it sits behind the mean it belongs to.
			{
				label: "peak",
				stroke: ink.peak,
				width: 1,
				fill: ink.peakFill,
				points: { show: false },
			},
			{
				label: "out",
				stroke: ink.line,
				width: 1.6,
				fill: ink.lineFill,
				points: { show: false },
			},
			{ label: "in", stroke: ink.text, width: 1.3, points: { show: false } },
		],
	};
}
