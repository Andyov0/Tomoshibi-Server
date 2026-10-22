import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppNotice, AppNoticeReading, AppSwitch, AppSwitches } from "./api";
import { AppsPanel, newer, noticeId } from "./AppsPanel";

/*
 * What the apps are told between releases, as the management pages change it.
 *
 * Everything here reaches every app at its next check, and nothing an app is
 * told is ever shown back to the person who pressed the button, so the faults
 * are all quiet ones. A notice published under the id of one already closed is
 * shown to nobody who closed it. A form refilled by a poll throws away what
 * somebody was typing. A switch list saved in an order other than the one on
 * screen is a different decision, since a later rule overrides an earlier one;
 * a rule the file names and the page does not know, quietly turned into one it
 * does, is a feature switched that nobody chose. And a list replaced by a poll
 * while it is being edited is an edit lost with nothing to say so.
 *
 * Asserted on what is sent, because what is sent is what the apps are told.
 */

const { notice, publishNotice, takeDownNotice, switches, setSwitches, actionFailed } = vi.hoisted(() => ({
	notice: vi.fn(),
	publishNotice: vi.fn(),
	takeDownNotice: vi.fn(),
	switches: vi.fn(),
	setSwitches: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: { notice, publishNotice, takeDownNotice, switches, setSwitches },
}));

vi.mock("@/live/notices", () => ({ actionFailed }));

const none: AppNoticeReading = { notice: null, showing: false };

const current: AppNotice = {
	id: "2026-10-22-080000",
	level: "warning",
	text: { "zh-Hans": "今晚维护", en: "Maintenance tonight" },
	until: "2099-01-01T00:00:00Z",
};

function listed(list: AppSwitch[], unread = 0): AppSwitches {
	return { switches: list, unread };
}

/** Ask the polls again, as coming back to the tab does. */
async function poll() {
	await act(async () => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	// Each write is what the next read answers, as the file is.
	notice.mockResolvedValue(none);
	publishNotice.mockImplementation(async (sent: AppNotice) => {
		notice.mockResolvedValue({ notice: sent, showing: true });
		return { notice: sent, showing: true };
	});
	takeDownNotice.mockImplementation(async () => {
		notice.mockResolvedValue(none);
		return none;
	});
	switches.mockResolvedValue(listed([]));
	setSwitches.mockImplementation(async (sent: AppSwitch[]) => {
		switches.mockResolvedValue(listed(sent));
		return listed(sent);
	});
});

describe("the lobby's notice", () => {
	it("publishes what was typed, under a new id each time, in the languages that have words", async () => {
		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		await screen.findByText("No notice is being shown.");

		const publish = screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement;
		expect(publish.disabled, "a notice in no language was offered for publishing").toBe(true);

		fireEvent.change(screen.getByLabelText("简体中文"), { target: { value: "  今晚十点维护  " } });
		fireEvent.change(screen.getByLabelText("日本語"), { target: { value: "   " } });
		fireEvent.click(within(screen.getByRole("radiogroup", { name: "Level" })).getByRole("radio", { name: "Warning" }));
		fireEvent.change(screen.getByLabelText("Until"), { target: { value: "2099-03-04T05:06" } });

		fireEvent.click(publish);

		await waitFor(() => expect(publishNotice).toHaveBeenCalledTimes(1));

		const sent = publishNotice.mock.calls[0]?.[0] as AppNotice;
		expect(sent.text).toEqual({ "zh-Hans": "今晚十点维护" });
		expect(sent.level).toBe("warning");
		expect(sent.until).toBe(new Date("2099-03-04T05:06").toISOString());
		expect(sent.id).toMatch(/^\d{4}-\d{2}-\d{2}-\d{6}$/);

		// A second publish, a second later, is a second notice.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));

		await waitFor(() => expect(publishNotice).toHaveBeenCalledTimes(2));
		const again = publishNotice.mock.calls[1]?.[0] as AppNotice;
		expect(again.id, "two notices under one id: whoever closed the first never sees the second").not.toBe(
			sent.id,
		);
	});

	it("is filled from the notice in the file, and not over what is being typed", async () => {
		notice.mockResolvedValue({ notice: current, showing: true });

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		const english = (await screen.findByLabelText("English")) as HTMLTextAreaElement;
		await waitFor(() => expect(english.value).toBe("Maintenance tonight"));
		expect(screen.getByText("The apps are showing this now.")).toBeDefined();

		fireEvent.change(english, { target: { value: "Maintenance tonight, from ten" } });

		// Another administrator publishes something else meanwhile.
		notice.mockResolvedValue({ notice: { ...current, id: "2026-10-22-090000", text: { en: "Other words" } }, showing: true });
		await poll();

		await screen.findByText("Other words");
		expect(english.value, "a poll threw away what was being typed").toBe("Maintenance tonight, from ten");
	});

	it("is taken down by its own button, offered only while there is a notice", async () => {
		notice.mockResolvedValue({ notice: current, showing: true });

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		fireEvent.click(await screen.findByRole("button", { name: "Take down" }));

		await waitFor(() => expect(takeDownNotice).toHaveBeenCalledTimes(1));
		await screen.findByText("No notice is being shown.");
		await waitFor(() => expect(screen.queryByRole("button", { name: "Take down" })).toBeNull());
	});

	it("says a notice past its end is no longer shown", async () => {
		notice.mockResolvedValue({ notice: { ...current, until: "2020-01-01T00:00:00Z" }, showing: false });

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		expect(await screen.findByText("This has ended, and the apps no longer show it.")).toBeDefined();
	});

	it("cannot be changed without the settings, and says so", async () => {
		notice.mockResolvedValue({ notice: current, showing: true });

		render(<AppsPanel canSettings={false} onSignedOut={vi.fn()} />);

		const english = (await screen.findByLabelText("English")) as HTMLTextAreaElement;
		expect(english.disabled).toBe(true);
		expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Take down" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Add a rule" })).toBeNull();
		expect(screen.getAllByText("You can view this but not change it.")).toHaveLength(2);
	});
});

describe("the feature switches", () => {
	it("are saved whole, in the order on screen, with ios as both of Apple's devices", async () => {
		switches.mockResolvedValue(
			listed([
				{ feature: "screen-share", off: true, platforms: ["android"], from: "0.1.4", below: "0.1.5", note: "Fold" },
				{ feature: "music", off: true, platforms: ["ios"] },
				// A feature a newer app knows and this page does not.
				{ feature: "stickers", off: true },
			]),
		);

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		const features = (await screen.findAllByRole("combobox", { name: "Feature" })) as HTMLSelectElement[];

		// Drawn as what it is. Without an option of its own the box shows the
		// first feature it does know, and the row says screen sharing is off
		// while the rule is about something else.
		expect(features[2]?.value).toBe("stickers");

		const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
		expect(save.disabled, "an unchanged list was offered for saving").toBe(true);

		// The second rule moved up, which is a different decision.
		fireEvent.click(screen.getAllByRole("button", { name: "Move up" })[1] as HTMLElement);

		await waitFor(() => expect(save.disabled).toBe(false));
		fireEvent.click(save);

		await waitFor(() => expect(setSwitches).toHaveBeenCalledTimes(1));
		expect(setSwitches.mock.calls[0]?.[0]).toEqual([
			{ feature: "music", off: true, platforms: ["iphone", "ipad"] },
			{ feature: "screen-share", off: true, platforms: ["android"], from: "0.1.4", below: "0.1.5", note: "Fold" },
			{ feature: "stickers", off: true },
		]);
	});

	it("adds a rule as off for every platform, and sends what was chosen", async () => {
		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		await screen.findByText("No rules, so every feature is on.");
		fireEvent.click(screen.getByRole("button", { name: "Add a rule" }));

		const feature = (await screen.findByRole("combobox", { name: "Feature" })) as HTMLSelectElement;
		fireEvent.change(feature, { target: { value: "background-blur" } });
		fireEvent.click(within(screen.getByRole("group", { name: "Platforms" })).getByLabelText("Windows"));
		fireEvent.change(screen.getByLabelText("Below version"), { target: { value: " 0.1.5 " } });
		fireEvent.click(screen.getByRole("radio", { name: "On" }));
		fireEvent.click(screen.getByRole("radio", { name: "Off" }));

		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(setSwitches).toHaveBeenCalledTimes(1));
		expect(setSwitches.mock.calls[0]?.[0]).toEqual([
			{ feature: "background-blur", off: true, platforms: ["windows"], below: "0.1.5" },
		]);
	});

	it("are not saved with a version that is not one, and say when a range holds none", async () => {
		switches.mockResolvedValue(listed([{ feature: "music", off: true }]));

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		const from = (await screen.findByLabelText("From version")) as HTMLInputElement;

		fireEvent.change(from, { target: { value: "next" } });
		expect(await screen.findByText("That is not a version.")).toBeDefined();
		expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);

		fireEvent.change(from, { target: { value: "0.1.5" } });
		fireEvent.change(screen.getByLabelText("Below version"), { target: { value: "0.1.4.2" } });

		expect(
			await screen.findByText("No version is from 0.1.5 and below 0.1.4.2, so this rule holds for no app."),
		).toBeDefined();
	});

	it("lose a removed rule from what is saved", async () => {
		switches.mockResolvedValue(
			listed([
				{ feature: "music", off: true },
				{ feature: "screen-share", off: true },
			]),
		);

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		await screen.findAllByRole("combobox", { name: "Feature" });
		fireEvent.click(screen.getAllByRole("button", { name: "Remove rule" })[0] as HTMLElement);

		// Leaving, then gone.
		await waitFor(() => expect(screen.getAllByRole("combobox", { name: "Feature" })).toHaveLength(1));

		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() => expect(setSwitches).toHaveBeenCalledWith([{ feature: "screen-share", off: true }]));
	});

	it("are not replaced by a poll while being edited, and say when they changed elsewhere", async () => {
		switches.mockResolvedValue(listed([{ feature: "music", off: true }]));

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		const note = (await screen.findByLabelText("Note")) as HTMLInputElement;
		fireEvent.change(note, { target: { value: "the jukebox drops calls" } });

		switches.mockResolvedValue(listed([{ feature: "watch-together", off: true }]));
		await poll();

		expect(
			await screen.findByText(
				"These were changed elsewhere since you began. Saving replaces that change with this list; discarding shows it.",
			),
		).toBeDefined();
		expect(note.value, "a poll threw the edit away").toBe("the jukebox drops calls");

		fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));

		await waitFor(() =>
			expect((screen.getByRole("combobox", { name: "Feature" }) as HTMLSelectElement).value).toBe("watch-together"),
		);
	});

	it("say when the file holds switches the page could not show", async () => {
		switches.mockResolvedValue(listed([{ feature: "music", off: true }], 2));

		render(<AppsPanel canSettings onSignedOut={vi.fn()} />);

		expect(
			await screen.findByText(
				"Some switches in the file could not be read and are not shown here. Saving replaces them with this list.",
			),
		).toBeDefined();
	});
});

describe("the page's own reading of a version", () => {
	// The cases the server's tests hold newerVersion to, so that the warning a
	// rule holds for no app is said exactly where the server would match none.
	it("orders versions as the server does", () => {
		expect(newer("0.1.5", "0.1.4.2")).toBe(true);
		expect(newer("0.1.4.2", "0.1.4")).toBe(true);
		expect(newer("0.1.4.1", "0.1.4")).toBe(true);
		expect(newer("0.1.10", "0.1.9")).toBe(true);
		expect(newer("0.1.4", "0.1.4")).toBe(false);
		expect(newer("0.1.4", "0.1.5")).toBe(false);
	});

	it("names a notice by its moment in UTC", () => {
		expect(noticeId(new Date("2026-10-22T08:09:07Z"))).toBe("2026-10-22-080907");
	});
});
