import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Now, Trend } from "./api";
import { NowPanel } from "./NowPanel";

/*
 * What these guard is a page that reads a field the server did not send, and a
 * chart that answers a question nobody asked.
 *
 * The live reading arrives in one of two shapes. A deployment holding its own
 * media describes one process and has a node identity; a control node holds no
 * media at all, describes its relays instead, and has none. The two are not
 * variations on a theme — they are answers to different questions, because the
 * things being described are different.
 *
 * This page was written for the first and deployed on the second. `node.id`,
 * read through an optional chain that guarded only the reading above it, threw
 * the moment anybody opened the panel, and a thrown render is not a missing
 * figure — it is a blank screen where the management interface used to be. The
 * sibling panel had the same fault for the same reason and was removed rather
 * than repaired.
 *
 * So both shapes are rendered here, and those assertions are deliberately
 * shallow: what matters is not which words appear but that neither shape throws.
 *
 * The rest are about the trend, where every failure is quiet. A span control
 * that does not reach the server leaves a chart that looks right and shows the
 * wrong hours. A readout fed the newest bucket rather than the one under the
 * pointer is correct exactly once per poll and wrong the rest of the time, and
 * it is wrong by an amount nobody can check from the picture.
 */

const { history } = vi.hoisted(() => ({ history: vi.fn() }));

vi.mock("./api", () => ({
	// The poll reaches for this to tell a lost session from a failure.
	SignedOut: class SignedOut extends Error {},
	api: { history },
}));

/*
 * The chart, with its canvas replaced by a button per bucket.
 *
 * uPlot draws to a canvas and jsdom has none, so the real one bails out before
 * it binds a pointer and could never report a hover here. What is under test is
 * not uPlot's cursor — that is uPlot's — but what this page does with the index
 * it is handed, which is where an off-by-one would live.
 */
vi.mock("./Trend", () => ({
	Trend: ({
		points,
		onHover,
	}: {
		points: { at: string }[];
		onHover?: (index: number | null) => void;
	}) => (
		<div>
			{points.map((point, index) => (
				<button key={point.at} type="button" onClick={() => onHover?.(index)}>
					{`bucket ${index}`}
				</button>
			))}
			<button type="button" onClick={() => onHover?.(null)}>
				away
			</button>
		</div>
	),
}));

const common = {
	since: new Date("2026-08-17T00:00:00Z").toISOString(),
	rooms: 2,
	clients: 5,
	tracks: { in: 4, out: 9 },
	bytes: { in: 1000, out: 2000, inPerSec: 10, outPerSec: 20, window: 10 },
	packets: { nackTotal: 3, nackPerSec: 0.5 },
	cpu: { count: 4, load: 0.25 },
};

const holdingItsOwnMedia: Now = {
	...common,
	node: { id: "ND_abc123", ip: "203.0.113.10" },
};

const aControlNode: Now = {
	...common,
	fleet: true,
	asked: 2,
	answered: 1,
	nodes: [
		{
			name: "guangzhou",
			url: "wss://gz.example:39217",
			reachable: true,
			node: "ND_gz",
			ip: "198.51.100.5",
			rooms: 2,
			clients: 5,
			tracksIn: 4,
			tracksOut: 9,
			outPerSec: 20,
			inPerSec: 8,
			bytesIn: 1_000_000,
			bytesOut: 9_000_000,
			cpus: 4,
			load: 0.25,
		},
		{
			name: "tokyo",
			url: "wss://jp.example:39217",
			reachable: false,
			detail: "dial tcp: i/o timeout",
			node: "",
			ip: "",
			rooms: 0,
			clients: 0,
			tracksIn: 0,
			tracksOut: 0,
			outPerSec: 0,
			inPerSec: 0,
			bytesIn: 0,
			bytesOut: 0,
			cpus: 0,
			load: 0,
		},
	],
};

// Two buckets an hour apart, with values chosen so that every figure on screen
// says which of them it came from.
const answered: Trend = {
	span: "1h",
	step: 3600,
	from: "2026-08-19T10:00:00Z",
	to: "2026-08-19T12:00:00Z",
	points: [
		{
			at: "2026-08-19T10:00:00Z",
			in: 1250,
			out: 12_500,
			inPeak: 1250,
			outPeak: 12_500,
			rooms: 1,
			clients: 2,
			nack: 0,
			nackPeak: 0,
			n: 360,
		},
		{
			at: "2026-08-19T11:00:00Z",
			in: 12_500,
			out: 125_000,
			inPeak: 12_500,
			outPeak: 250_000,
			rooms: 3,
			clients: 8,
			nack: 1.5,
			nackPeak: 9,
			n: 360,
		},
	],
};

function open(now?: Now) {
	history.mockResolvedValue(answered);

	return render(<NowPanel now={now} onSignedOut={vi.fn()} />);
}

describe("NowPanel", () => {
	it("draws a deployment that holds its own media", async () => {
		open(holdingItsOwnMedia);

		expect(await screen.findByText("ND_abc123")).toBeDefined();
		expect(screen.getByText("203.0.113.10")).toBeDefined();
	});

	// The one that was broken. A control node sends no node identity at all.
	it("draws a control node, which has no node of its own", async () => {
		open(aControlNode);

		expect(await screen.findByText("guangzhou")).toBeDefined();
		expect(screen.getByText("tokyo")).toBeDefined();
	});

	// A relay holding no calls and a relay that did not answer are both zeros,
	// and the difference between quiet and down is most of why this is opened.
	it("says why a relay did not answer rather than showing it as idle", async () => {
		open(aControlNode);

		expect(await screen.findByText("dial tcp: i/o timeout")).toBeDefined();
		expect(screen.getByText("1 of 2 answering")).toBeDefined();
	});

	// Before the first poll comes back there is no reading at all, which is a
	// third shape and the one every panel forgets.
	it("draws before anything has been read", async () => {
		expect(() => open(undefined)).not.toThrow();

		// Awaited, so that the answer arrives inside the test rather than after
		// it: a poll that resolves into an unmounted tree is a warning nobody
		// can act on, in a run somebody has to read past.
		await waitFor(() => expect(history).toHaveBeenCalled());
	});
});

describe("how far back", () => {
	it("opens on the hour, and asks the server for it by name", async () => {
		open(holdingItsOwnMedia);

		await waitFor(() => expect(history).toHaveBeenCalledWith("1h", undefined));
	});

	/*
	 * The press has to reach the server. Everything about this control looks
	 * right when it does not: the button lights up, the chart carries on drawing
	 * the hour it was already showing, and the only way to tell is to know what
	 * the last hour looked like already.
	 *
	 * Ten minutes first, deliberately. The poll keeps its question in a ref so
	 * that changing it does not restart the timer, which means a new span is
	 * only asked for because something asks — and the two spans that share a
	 * polling rate are the pair where nothing else would.
	 */
	it("asks again for the span that was pressed", async () => {
		open(holdingItsOwnMedia);

		await waitFor(() => expect(history).toHaveBeenCalled());

		fireEvent.click(screen.getByText("10 minutes"));
		await waitFor(() => expect(history).toHaveBeenLastCalledWith("10m", undefined));

		fireEvent.click(screen.getByText("6 months"));
		await waitFor(() => expect(history).toHaveBeenLastCalledWith("6mo", undefined));
	});

	/*
	 * A custom range is sent as two instants, converted from the local time
	 * somebody typed. The fields are in the reader's own timezone and the server
	 * keeps UTC, and a range that quietly shifted by the difference would draw a
	 * perfectly plausible chart of the wrong eight hours.
	 */
	it("sends a custom range as the two moments it means", async () => {
		open(holdingItsOwnMedia);

		await waitFor(() => expect(history).toHaveBeenCalled());

		fireEvent.click(screen.getByText("Custom"));

		fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-01T09:00" } });
		fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-01T17:00" } });

		fireEvent.click(screen.getByText("Show"));

		await waitFor(() =>
			expect(history).toHaveBeenLastCalledWith("custom", {
				from: new Date("2026-03-01T09:00").toISOString(),
				to: new Date("2026-03-01T17:00").toISOString(),
			}),
		);
	});
});

describe("the readout", () => {
	it("stays out of the way until the pointer is over the chart", async () => {
		open(holdingItsOwnMedia);

		await screen.findByText("bucket 1");
		await waitFor(() => expect(history).toHaveBeenCalled());

		expect(screen.queryByText(/1\.0 Mbps/)).toBeNull();
		// What is there instead is the key, which is what the line colours mean.
		expect(screen.getByText("peak")).toBeDefined();
	});

	/*
	 * The values have to be the hovered bucket's own. Handed the newest bucket
	 * instead, this would be right once per poll and wrong for the rest of the
	 * time, by an amount nobody can check against the picture.
	 */
	it("says what the bucket under the pointer held", async () => {
		open(holdingItsOwnMedia);

		fireEvent.click(await screen.findByText("bucket 1"));

		// The mean and, separately, the highest single reading inside it.
		expect(await screen.findByText(/1\.0 Mbps/)).toBeDefined();
		expect(screen.getByText(/2\.0 Mbps/)).toBeDefined();
		expect(screen.getByText("8")).toBeDefined();

		// And the other bucket is a different set of figures.
		fireEvent.click(screen.getByText("bucket 0"));

		expect(await screen.findByText(/100 kbps/)).toBeDefined();
		expect(screen.queryByText(/1\.0 Mbps/)).toBeNull();
	});

	// It leaves rather than vanishing, so it is still on screen for a moment
	// after the pointer has gone.
	it("goes away when the pointer does", async () => {
		open(holdingItsOwnMedia);

		fireEvent.click(await screen.findByText("bucket 1"));
		await screen.findByText(/1\.0 Mbps/);

		fireEvent.click(screen.getByText("away"));

		await waitFor(() => expect(screen.queryByText(/1\.0 Mbps/)).toBeNull());
	});
});
