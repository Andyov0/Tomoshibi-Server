import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Refused } from "@/live/api";
import { type Arrangement, arrange, arrangements, linkFor } from "@/live/meeting";
import { actionFailed } from "@/live/notices";
import { Schedule } from "./Schedule";

/*
 * Three ways the schedule card was quietly wrong.
 *
 * It let a time through that had already gone. Whether the chosen time was in
 * the past was worked out when the card last drew itself, and the button used
 * that answer; a form left open across the chosen minute sent a meeting for a
 * moment that had passed, and the server's hour of grace let it in.
 *
 * It could not tell "nothing arranged" from "could not ask". The list was read
 * once and a failure was swallowed, so a person whose request failed saw the
 * same empty card as one who had never arranged anything, with nothing to
 * press.
 *
 * And it could report a meeting as failed that had been made. The link was
 * copied inside the same try as the arranging, so a browser with no clipboard
 * threw after the meeting existed, and the catch said the arranging had gone
 * wrong. The meeting was there, the person was told it was not, and the
 * natural next move was to make it again.
 */

vi.mock("@/live/meeting", () => ({
	arrange: vi.fn(),
	arrangements: vi.fn(),
	cancel: vi.fn(),
	linkFor: (m: { room: string }) => `https://meet.example/?meeting=tok#/${m.room}`,
	whenSaid: (at: string) => `at ${at}`,
}));

vi.mock("@/live/notices", () => ({
	actionFailed: vi.fn(),
	actionDone: vi.fn(),
}));

const made: Arrangement = {
	id: "m1",
	room: "standup",
	at: "2026-09-05T03:00:00.000Z",
	started: false,
	ended: false,
};

const morning = new Date(2026, 8, 5, 10, 0, 0);

function todayLabel() {
	return new Intl.DateTimeFormat("en", { dateStyle: "full" }).format(morning);
}

async function opened() {
	render(<Schedule servers={[]} server="" onServer={() => {}} onOpenChange={() => {}} />);
	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));
	await screen.findByText("Day");
}

function chooseToday(hour: number, minute: number) {
	fireEvent.click(screen.getByRole("button", { name: todayLabel() }));
	fireEvent.change(screen.getByLabelText("Hour"), { target: { value: String(hour) } });
	fireEvent.change(screen.getByLabelText("Minute"), { target: { value: String(minute) } });
}

let clipboard: unknown;

beforeEach(() => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(morning);
	vi.mocked(arrange).mockReset();
	vi.mocked(arrangements).mockReset();
	vi.mocked(actionFailed).mockReset();
	vi.mocked(arrangements).mockResolvedValue([]);
	clipboard = { writeText: vi.fn(async () => {}) };
	Object.defineProperty(navigator, "clipboard", { get: () => clipboard, configurable: true });
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

it("does not send a time that has gone while the form sat open", async () => {
	await opened();
	chooseToday(10, 15);

	// The form sits. The minute passes.
	vi.setSystemTime(new Date(2026, 8, 5, 10, 16, 0));
	fireEvent.click(screen.getByRole("button", { name: "Arrange" }));

	await waitFor(() => expect(screen.getByText("That time has already gone.")).toBeTruthy());
	expect(arrange).not.toHaveBeenCalled();
});

it("says so on its own when the chosen minute passes", async () => {
	await opened();
	chooseToday(10, 15);
	expect(screen.queryByText("That time has already gone.")).toBeNull();

	// Nobody touches the form; the clock alone changes the sentence.
	await act(async () => {
		vi.setSystemTime(new Date(2026, 8, 5, 10, 16, 0));
		await vi.advanceTimersByTimeAsync(31_000);
	});

	expect(screen.getByText("That time has already gone.")).toBeTruthy();
});

it("tells a request that failed apart from nothing arranged, and offers to try again", async () => {
	vi.mocked(arrangements).mockRejectedValueOnce(new Error("boom"));
	await opened();

	await screen.findByText("Could not load your meetings.");
	expect(screen.queryByText("No meetings arranged yet.")).toBeNull();

	vi.mocked(arrangements).mockResolvedValueOnce([made]);
	fireEvent.click(screen.getByRole("button", { name: "Try again" }));

	await screen.findByText("standup");
});

it("shows the empty state only after a read that succeeded", async () => {
	await opened();
	await screen.findByText("No meetings arranged yet.");
});

it("keeps what it has when a refresh fails", async () => {
	vi.mocked(arrangements).mockResolvedValueOnce([made]);
	await opened();
	await screen.findByText("standup");

	// The card is closed and opened again, and this time the read fails.
	vi.mocked(arrangements).mockRejectedValueOnce(new Error("boom"));
	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));
	await waitFor(() => expect(screen.queryByText("Day")).toBeNull());
	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));
	await screen.findByText("Day");

	await screen.findByText("Could not load your meetings.");
	expect(screen.getByText("standup")).toBeTruthy();
});

it("does not let a slow old read overwrite what was just made", async () => {
	// The first read hangs; a meeting is arranged meanwhile; then the old read
	// comes back empty.
	let finishFirst: (value: Arrangement[]) => void = () => {};
	vi.mocked(arrangements).mockReturnValueOnce(new Promise((ok) => (finishFirst = ok)));
	vi.mocked(arrange).mockResolvedValue(made);

	await opened();
	chooseToday(11, 0);
	fireEvent.click(screen.getByRole("button", { name: "Arrange" }));
	await screen.findByText("standup");

	await act(async () => {
		finishFirst([]);
	});

	expect(screen.getByText("standup")).toBeTruthy();
});

for (const [how, broken] of [
	["there is no clipboard", undefined],
	["writing throws", { writeText: () => { throw new Error("sync"); } }],
	["writing is refused", { writeText: () => Promise.reject(new Error("no")) }],
] as const) {
	it(`keeps the meeting and shows the link when ${how}`, async () => {
		clipboard = broken;
		vi.mocked(arrange).mockResolvedValue(made);

		await opened();
		chooseToday(11, 0);
		fireEvent.click(screen.getByRole("button", { name: "Arrange" }));

		// Made, listed, and not reported as a failure of the arranging.
		await screen.findByText("standup");
		expect(arrange).toHaveBeenCalledTimes(1);
		expect(actionFailed).not.toHaveBeenCalledWith(expect.stringMatching(/went wrong/));

		// The link is there to be copied by hand, and nothing claims it was
		// copied already.
		await waitFor(() => expect(screen.getByDisplayValue(linkFor(made))).toBeTruthy());
		expect(screen.queryByLabelText("Link copied")).toBeNull();
	});
}


it("opens a meeting from its name, with the whole link", async () => {
	vi.mocked(arrangements).mockResolvedValueOnce([made]);
	await opened();

	const entry = await screen.findByRole("link", { name: "Open standup" });
	expect(entry.getAttribute("href")).toBe(linkFor(made));
});

it("does not offer to open a meeting that is over", async () => {
	vi.mocked(arrangements).mockResolvedValueOnce([{ ...made, started: true, ended: true }]);
	await opened();

	await screen.findByText("standup");
	expect(screen.queryByRole("link", { name: "Open standup" })).toBeNull();
});

it("hands the meeting to the calendar as a file", async () => {
	vi.mocked(arrangements).mockResolvedValueOnce([made]);
	const clicked: string[] = [];
	const url = vi.fn(() => "blob:fake");
	vi.stubGlobal("URL", { ...URL, createObjectURL: url, revokeObjectURL: vi.fn() });
	const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
		clicked.push(this.download);
	});

	await opened();
	fireEvent.click(await screen.findByRole("button", { name: "Add to calendar" }));

	expect(url).toHaveBeenCalledTimes(1);
	expect(clicked).toEqual(["standup.ics"]);

	click.mockRestore();
	vi.unstubAllGlobals();
});

/*
 * An account the arranging was taken away from.
 *
 * The lobby offered the form to every account, and the server refused every
 * press of it with a code the card had no sentence for: "Something went wrong.
 * Try again." — which no number of tries could make true. What was arranged
 * before stays the person's to see and to cancel, because the server still
 * allows both.
 */
it("offers no form to an account that may not arrange, and keeps what it arranged", async () => {
	vi.mocked(arrangements).mockResolvedValueOnce([made]);

	render(<Schedule servers={[]} server="" onServer={() => {}} onOpenChange={() => {}} canArrange={false} />);
	fireEvent.click(screen.getByRole("button", { name: /Schedule a meeting/ }));

	await screen.findByText("Arranging meetings has not been opened to you.");
	expect(screen.queryByText("Day")).toBeNull();
	expect(screen.queryByRole("button", { name: "Arrange" })).toBeNull();

	await screen.findByText("standup");
	expect(screen.getByRole("button", { name: "Cancel meeting" })).toBeTruthy();
});

it("says why when arranging was taken away while the lobby was open", async () => {
	vi.mocked(arrange).mockRejectedValue(new Refused("not_allowed", "403"));

	await opened();
	chooseToday(11, 0);
	fireEvent.click(screen.getByRole("button", { name: "Arrange" }));

	await waitFor(() =>
		expect(actionFailed).toHaveBeenCalledWith("Arranging meetings has not been opened to you."),
	);
});
