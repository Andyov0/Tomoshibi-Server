import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t as say } from "@/live/i18n";
import type { LogLine } from "./api";
import { LogPanel } from "./LogPanel";
import { clock } from "./units";

/*
 * The log page, which the owner asked for because the pages before it would not
 * open when something went wrong (2026-08-20).
 *
 * The faults are quiet ones. A page that asked for anything besides the log on
 * opening would go down with whatever that was; a page that asked for the whole
 * log every few seconds would send two thousand lines a tick to a tab left open
 * for a week, and one that asked for less than what came after its last line
 * would show some lines twice and lose others. And a page that drew the newest
 * line last would put what just happened at the foot of a long list.
 */

const { log, runtime } = vi.hoisted(() => ({ log: vi.fn(), runtime: vi.fn() }));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: { log, runtime },
}));

function line(seq: number, message: string, level = "info", attrs?: LogLine["attrs"]): LogLine {
	return { seq, at: new Date(Date.UTC(2026, 9, 29, 3, 0, seq)).toISOString(), level, message, attrs };
}

beforeEach(() => {
	vi.clearAllMocks();
	runtime.mockResolvedValue({ meet: {}, rtc: {}, credentials: { key: "" }, codecs: [] });
});

describe("the log", () => {
	it("asks for the log and nothing else, newest line first", async () => {
		log.mockResolvedValue({ started: "2026-10-29T03:00:00Z", lines: [line(1, "first"), line(2, "the store did not answer", "error")] });

		render(<LogPanel onSignedOut={vi.fn()} />);

		const newest = await screen.findByText("the store did not answer");
		const oldest = screen.getByText("first");

		expect(newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(log).toHaveBeenCalledWith(0);
		expect(runtime).not.toHaveBeenCalled();
	});

	it("asks next for what came after the last line it has", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		log.mockResolvedValueOnce({ started: "", lines: [line(1, "first"), line(2, "second")] });
		log.mockResolvedValue({ started: "", lines: [line(3, "third")] });

		render(<LogPanel onSignedOut={vi.fn()} />);

		await screen.findByText("second");
		await vi.advanceTimersByTimeAsync(3_100);

		await screen.findByText("third");
		expect(log).toHaveBeenNthCalledWith(2, 2);
		// Each line once, however many times the page has asked.
		expect(screen.getAllByText("second")).toHaveLength(1);

		vi.useRealTimers();
	});

	it("narrows to the problems, and reads an administrator's action as who did what", async () => {
		log.mockResolvedValue({
			started: "",
			lines: [
				line(1, "joined", "info", [{ key: "room", value: "standup" }]),
				line(2, "a relay did not answer", "warn", [{ key: "relay", value: "hk" }]),
				line(3, "an administrative action was taken", "info", [
					{ key: "action", value: "change account" },
					{ key: "trip", value: "7tsdfrpsgn" },
					{ key: "name", value: "adam" },
					{ key: "target", value: "sato" },
				]),
			],
		});

		render(<LogPanel onSignedOut={vi.fn()} />);

		const acted = (await screen.findByText("adam")).parentElement as HTMLElement;
		expect(acted.textContent).toContain("change account");
		expect(within(acted).getByText("sato")).toBeDefined();

		fireEvent.click(screen.getByRole("radio", { name: "Problems" }));

		await waitFor(() => expect(screen.queryByText("joined")).toBeNull());
		expect(screen.getByText("a relay did not answer")).toBeDefined();
	});

	// A lockout is nobody's action and was once shown as one: under the
	// "Administrator" tag, as "- sign in" by nobody, with its particulars as a
	// sentence of English and a UTC timestamp. It is said from its parts now,
	// in the page's language, with the end in the reader's own time.
	it("says a sign-in lockout in the reader's words, as nobody's action", async () => {
		const until = "2026-10-29T03:30:11Z";
		log.mockResolvedValue({
			started: "",
			lines: [
				line(11, "a caller was shut out of signing in", "warn", [
					{ key: "address", value: "2001:db8:1:2::/64" },
					{ key: "device", value: "Chrome, macOS" },
					{ key: "failures", value: "11" },
					{ key: "doors", value: "account,management" },
					{ key: "until", value: until },
					{ key: "seen", value: "2001:db8:1:2::9" },
				]),
			],
		});

		act(() => setLocale("zh-Hans"));
		try {
			render(<LogPanel onSignedOut={vi.fn()} />);

			const address = await screen.findByText("2001:db8:1:2::/64");
			const entry = address.closest("div.flex.gap-3") as HTMLElement;

			expect(within(entry).getByText("登录封禁")).toBeDefined();
			expect(within(entry).getByText(say("Shut out until {time}", { time: clock(until) }))).toBeDefined();
			expect(say("Shut out until {time}", { time: clock(until) })).not.toContain("Z");
			expect(within(entry).getByText(say("{count} failed sign-ins", { count: 11 }))).toBeDefined();
			expect(within(entry).getByText(say("At both sign-ins"))).toBeDefined();
			expect(within(entry).getByText("Chrome, macOS")).toBeDefined();
			expect(within(entry).getByText("2001:db8:1:2::9")).toBeDefined();

			expect(entry.textContent).not.toContain(say("Administrator"));
			expect(entry.textContent).not.toContain("a caller was shut out of signing in");
			expect(entry.textContent).not.toContain(until);
			expect(entry.textContent).not.toContain("failures");

			// Among the problems, as the refused sign-ins before it are.
			fireEvent.click(screen.getByRole("radio", { name: say("Problems") }));
			expect(await screen.findByText("2001:db8:1:2::/64")).toBeDefined();
		} finally {
			act(() => setLocale("en"));
		}
	});

	// The device was once the server's own lower-case English ("iphone app
	// 0.1.7.1, iOS 27.0.1, iPhone17,1") a page away from the accounts page's
	// "iPhone app 0.1.7.1" for the same phone. Given the parts, it is said as
	// that page says it; a line without them still shows the words, as above.
	it("names a lockout's device as the accounts page does", async () => {
		log.mockResolvedValue({
			started: "",
			lines: [
				line(12, "a caller was shut out of signing in", "warn", [
					{ key: "address", value: "198.51.100.72" },
					{ key: "device", value: "iphone app 0.1.7.1, iOS 27.0.1, iPhone17,1" },
					{ key: "failures", value: "11" },
					{ key: "doors", value: "account" },
					{ key: "until", value: "2026-10-29T03:30:11Z" },
					{ key: "client.kind", value: "iphone" },
					{ key: "client.app", value: "0.1.7.1" },
					{ key: "client.system", value: "iOS 27.0.1" },
					{ key: "client.device", value: "iPhone17,1" },
				]),
			],
		});

		act(() => setLocale("zh-Hans"));
		try {
			render(<LogPanel onSignedOut={vi.fn()} />);

			const address = await screen.findByText("198.51.100.72");
			const entry = address.closest("div.flex.gap-3") as HTMLElement;

			expect(within(entry).getByText(`${say("iPhone app")} 0.1.7.1`)).toBeDefined();
			expect(within(entry).getByText("iOS 27.0.1")).toBeDefined();
			expect(within(entry).getByText("iPhone17,1")).toBeDefined();
			expect(entry.textContent).not.toContain("iphone app");
			expect(entry.textContent).not.toContain("client.");
		} finally {
			act(() => setLocale("en"));
		}
	});

	// The same for the Linux app, which the lockout's line was written before:
	// its kind is the one the join reads its agent as, and the page names it
	// as the accounts page does, machine and processor whole, rather than the
	// server's "linux app 0.1.7, ..." or an app that did not say which.
	it("names a Linux app's lockout as the Linux app", async () => {
		log.mockResolvedValue({
			started: "",
			lines: [
				line(13, "a caller was shut out of signing in", "warn", [
					{ key: "address", value: "198.51.100.73" },
					{ key: "device", value: "linux app 0.1.7, Ubuntu 24.04.4 LTS, LENOVO 21K5 x86_64" },
					{ key: "failures", value: "11" },
					{ key: "doors", value: "account" },
					{ key: "until", value: "2026-10-29T03:30:11Z" },
					{ key: "client.kind", value: "linux" },
					{ key: "client.app", value: "0.1.7" },
					{ key: "client.system", value: "Ubuntu 24.04.4 LTS" },
					{ key: "client.device", value: "LENOVO 21K5 x86_64" },
				]),
			],
		});

		act(() => setLocale("ja"));
		try {
			render(<LogPanel onSignedOut={vi.fn()} />);

			const address = await screen.findByText("198.51.100.73");
			const entry = address.closest("div.flex.gap-3") as HTMLElement;

			expect(within(entry).getByText(`${say("Linux app")} 0.1.7`)).toBeDefined();
			expect(within(entry).getByText("Ubuntu 24.04.4 LTS")).toBeDefined();
			expect(within(entry).getByText("LENOVO 21K5 x86_64")).toBeDefined();
			expect(entry.textContent).not.toContain("linux app");
			expect(entry.textContent).not.toContain(say("An older app that did not say which"));
		} finally {
			act(() => setLocale("en"));
		}
	});

	it("says when lines it never saw were pushed out", async () => {
		log.mockResolvedValue({ started: "", lines: [line(901, "late")], missed: true });

		render(<LogPanel onSignedOut={vi.fn()} />);

		expect(
			await screen.findByText("Older lines are no longer held here. The full log is the server's process log."),
		).toBeDefined();
	});
});
