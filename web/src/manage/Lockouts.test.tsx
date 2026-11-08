import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/live/i18n";
import type { Lockout, Lockouts } from "./api";
import { LockoutsSection, left } from "./Lockouts";

/*
 * The list of callers shut out of signing in, and the press that lets one
 * back in.
 *
 * Three things here would go wrong without anything looking broken. A lift
 * on one press, on rows that reorder whenever the list is polled, is a door
 * reopened to whoever was guessing by a finger meant for the row above. A
 * button offered to somebody the server will refuse is a page that looks
 * broken every time it is used. And a countdown that does not count, or a
 * row that outlives its lockout, is a page saying somebody is shut out who
 * is not.
 */

const { liftLockout, liftLockouts, actionFailed } = vi.hoisted(() => ({
	liftLockout: vi.fn(),
	liftLockouts: vi.fn(),
	actionFailed: vi.fn(),
}));

vi.mock("./api", () => ({
	SignedOut: class SignedOut extends Error {},
	api: { liftLockout, liftLockouts },
}));

vi.mock("@/live/notices", () => ({ actionFailed }));

const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

function lockout(key: string, address: string, minutes: number, more: Partial<Lockout> = {}): Lockout {
	const now = Date.now();

	return {
		key,
		address,
		client: { kind: "web", browser: "Chrome 140", system: "macOS", agent: chrome },
		first: new Date(now - 4 * 60_000).toISOString(),
		last: new Date(now - 60_000).toISOString(),
		since: new Date(now - 60_000).toISOString(),
		until: new Date(now + minutes * 60_000).toISOString(),
		failures: 11,
		doors: ["account", "management"],
		...more,
	};
}

function reading(...lockouts: Lockout[]): Lockouts {
	return { lockouts, failures: 10, windowSeconds: 300, forSeconds: 1800 };
}

function rowOf(address: string): HTMLElement {
	return within(screen.getByRole("list", { name: "Sign-in lockouts" })).getByRole("listitem", { name: address });
}

beforeEach(() => {
	vi.clearAllMocks();
	liftLockout.mockResolvedValue({});
	liftLockouts.mockResolvedValue({ lifted: 2 });
});

afterEach(() => {
	vi.useRealTimers();
	act(() => setLocale("en"));
});

describe("the lockouts on the accounts page", () => {
	it("says when nobody is shut out, and the rule", () => {
		render(<LockoutsSection reading={reading()} canModerate onChanged={vi.fn()} />);

		expect(screen.getByText("Nobody is shut out of signing in.")).toBeTruthy();
		expect(
			screen.getByText(
				"More than 10 failed sign-ins within 5 minutes from one address and device shut them out of signing in, on the web and in the apps, for 30 minutes.",
			),
		).toBeTruthy();
	});

	it("draws nothing until the server has answered", () => {
		const { container } = render(<LockoutsSection canModerate onChanged={vi.fn()} />);

		expect(container.textContent).toBe("");
	});

	it("says what was shut out, from what, how many times, where, and how long is left", () => {
		render(
			<LockoutsSection
				reading={reading(lockout("a", "2001:db8:1:2::/64", 25, { seen: "2001:db8:1:2::7" }))}
				canModerate
				onChanged={vi.fn()}
			/>,
		);

		const row = rowOf("2001:db8:1:2::/64");

		expect(row.textContent).toContain("2001:db8:1:2::7");
		expect(row.textContent).toContain("Chrome 140");
		expect(row.textContent).toContain("macOS");
		expect(row.textContent).toContain("11 failed sign-ins");
		expect(row.textContent).toContain("At both sign-ins");
		expect(row.textContent).toMatch(/2[45]:\d\d left/);

		// The user agent as sent, for whatever the reading missed, under the
		// pointer.
		expect(row.querySelector(`[title="${chrome}"]`)).toBeTruthy();
	});

	// The Linux app arrived after the list was written, and its device is the
	// one whose processor decides which build somebody needs: the row names
	// the app and keeps the distribution and the machine whole, processor
	// included, in the reader's language.
	it("names a Linux app shut out as the Linux app, with its distribution and its machine", () => {
		setLocale("zh-Hans");
		const agent = "Tomoshibi/0.1.7 (Linux; Ubuntu 24.04.4 LTS; LENOVO 21K5 x86_64)";

		render(
			<LockoutsSection
				reading={reading(
					lockout("l", "203.0.113.40", 25, {
						client: { kind: "linux", app: "0.1.7", system: "Ubuntu 24.04.4 LTS", device: "LENOVO 21K5 x86_64", agent },
					}),
				)}
				canModerate
				onChanged={vi.fn()}
			/>,
		);

		const row = within(screen.getByRole("list", { name: "登录封禁" })).getByRole("listitem", { name: "203.0.113.40" });
		const device = row.querySelector(`[title="${agent}"]`);

		expect(device?.textContent).toBe("Linux 客户端 0.1.7Ubuntu 24.04.4 LTSLENOVO 21K5 x86_64");
		expect(row.textContent).not.toContain("旧版客户端");
	});

	it("counts down", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		vi.setSystemTime(Date.parse("2026-11-01T12:00:00Z"));

		render(<LockoutsSection reading={reading(lockout("a", "203.0.113.9", 10))} canModerate onChanged={vi.fn()} />);

		expect(rowOf("203.0.113.9").textContent).toContain("10:00 left");

		await act(async () => {
			vi.advanceTimersByTime(61_000);
		});

		expect(rowOf("203.0.113.9").textContent).toContain("8:59 left");
	});

	it("lets a lockout leave at the second it ends", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		vi.setSystemTime(Date.parse("2026-11-01T12:00:00Z"));

		render(
			<LockoutsSection
				reading={reading(lockout("a", "203.0.113.9", 1), lockout("b", "203.0.113.10", 20))}
				canModerate
				onChanged={vi.fn()}
			/>,
		);

		await act(async () => {
			vi.advanceTimersByTime(61_000);
		});
		// Drawn leaving, then gone.
		await act(async () => {
			vi.advanceTimersByTime(400);
		});

		const list = screen.getByRole("list", { name: "Sign-in lockouts" });
		expect(within(list).queryByRole("listitem", { name: "203.0.113.9" })).toBeNull();
		expect(within(list).getByRole("listitem", { name: "203.0.113.10" })).toBeTruthy();
	});

	it("lifts one on the second press, and not the first", async () => {
		const onChanged = vi.fn().mockResolvedValue(undefined);
		render(<LockoutsSection reading={reading(lockout("a", "203.0.113.9", 20))} canModerate onChanged={onChanged} />);

		const button = within(rowOf("203.0.113.9")).getByRole("button", { name: "Lift" });

		fireEvent.click(button);
		expect(liftLockout).not.toHaveBeenCalled();
		expect(within(rowOf("203.0.113.9")).getByRole("button", { name: "Press again to lift" })).toBeTruthy();

		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Press again to lift" }));

		await waitFor(() => expect(liftLockout).toHaveBeenCalledWith("a"));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());

		// And the row goes on the press, not at the next poll.
		await waitFor(() =>
			expect(within(screen.getByRole("list", { name: "Sign-in lockouts" })).queryByRole("listitem")).toBeNull(),
		);
	});

	it("says why a lift did not take, and leaves the row", async () => {
		liftLockout.mockRejectedValue(new Error("That lockout has already ended."));
		const onChanged = vi.fn().mockResolvedValue(undefined);

		render(<LockoutsSection reading={reading(lockout("a", "203.0.113.9", 20))} canModerate onChanged={onChanged} />);

		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Lift" }));
		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Press again to lift" }));

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith("That lockout has already ended."));
		expect(onChanged).toHaveBeenCalled();
		expect(rowOf("203.0.113.9")).toBeTruthy();
	});

	it("offers lifting every one once there is more than one", async () => {
		const onChanged = vi.fn().mockResolvedValue(undefined);
		const { rerender } = render(
			<LockoutsSection reading={reading(lockout("a", "203.0.113.9", 20))} canModerate onChanged={onChanged} />,
		);

		expect(screen.queryByRole("button", { name: "Lift all" })).toBeNull();

		rerender(
			<LockoutsSection
				reading={reading(lockout("a", "203.0.113.9", 20), lockout("b", "203.0.113.10", 20))}
				canModerate
				onChanged={onChanged}
			/>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Lift all" }));
		expect(liftLockouts).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Press again to lift all" }));
		await waitFor(() => expect(liftLockouts).toHaveBeenCalledTimes(1));
	});

	it("offers no lift to somebody who may not lift, and says who may", () => {
		render(
			<LockoutsSection
				reading={reading(lockout("a", "203.0.113.9", 20), lockout("b", "203.0.113.10", 20))}
				canModerate={false}
				onChanged={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Lift" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Lift all" })).toBeNull();
		expect(screen.getByText("Only an administrator who can manage everything can lift a lockout.")).toBeTruthy();
	});

	it("is said in every language", () => {
		for (const [locale, title, button] of [
			["zh-Hans", "登录封禁", "解封"],
			["zh-Hant", "登入封鎖", "解除封鎖"],
			["ja", "サインイン制限", "解除"],
		] as const) {
			act(() => setLocale(locale));

			const { unmount } = render(
				<LockoutsSection reading={reading(lockout("a", "203.0.113.9", 20))} canModerate onChanged={vi.fn()} />,
			);

			expect(screen.getByRole("heading").textContent).toContain(title);
			expect(screen.getByRole("button", { name: button })).toBeTruthy();

			unmount();
		}
	});
});

describe("what is left of a lockout", () => {
	it.each([
		[30 * 60_000, "30:00"],
		[61_000, "1:01"],
		[999, "0:01"],
		[0, "0:00"],
		[-5_000, "0:00"],
	])("%i ms is %s", (ms, said) => {
		const now = Date.parse("2026-11-01T12:00:00Z");
		expect(left(new Date(now + ms).toISOString(), now)).toBe(said);
	});
});

/*
 * The press asks for the list again at once, and the answer lands inside the
 * row's exit. The row has to finish leaving anyway, rather than staying as a
 * blank the height of a row (Grouped.tsx, usePresence).
 */
describe("a lift answered by the list at once", () => {
	it("leaves no gap where the row was", async () => {
		const both = reading(lockout("a", "203.0.113.9", 20), lockout("b", "203.0.113.10", 20));
		let shown = both;
		let redraw: () => void = () => {};

		function Polled() {
			const [, tick] = useState(0);
			redraw = () => tick((n) => n + 1);
			return (
				<LockoutsSection
					reading={shown}
					canModerate
					onChanged={async () => {
						// Answered a moment later, inside the row's exit, as a
						// server on the same machine answers.
						await new Promise((resolve) => setTimeout(resolve, 60));
						shown = reading(lockout("b", "203.0.113.10", 20));
						act(() => redraw());
					}}
				/>
			);
		}

		render(<Polled />);

		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Lift" }));
		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Press again to lift" }));

		await waitFor(() => expect(liftLockout).toHaveBeenCalledWith("a"));

		await waitFor(() => {
			const rows = within(screen.getByRole("list", { name: "Sign-in lockouts" })).queryAllByRole("listitem");
			expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["203.0.113.10"]);
		});
	});
});

/*
 * The same caller shut out again after a lift is a new lockout under the same
 * key, since the key is the caller's. Hidden as though still lifted, it left
 * this page one short of the rail's count, and "nobody is shut out" said above
 * nobody, until the page was reloaded.
 */
describe("a caller shut out again after a lift", () => {
	it("is listed again, and counted", async () => {
		const first = lockout("k", "203.0.113.9", 20, { since: "2026-11-01T09:00:00Z" });
		let shown = reading(first);
		let redraw: () => void = () => {};

		function Polled() {
			const [, tick] = useState(0);
			redraw = () => tick((n) => n + 1);
			return (
				<LockoutsSection
					reading={shown}
					canModerate
					onChanged={async () => {
						shown = reading();
						act(() => redraw());
					}}
				/>
			);
		}

		render(<Polled />);

		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Lift" }));
		fireEvent.click(within(rowOf("203.0.113.9")).getByRole("button", { name: "Press again to lift" }));

		await waitFor(() => expect(screen.getByText("Nobody is shut out of signing in.")).toBeTruthy());

		// The next poll: the same address and device, shut out again.
		shown = reading(lockout("k", "203.0.113.9", 30, { since: "2026-11-01T09:20:00Z" }));
		act(() => redraw());

		await waitFor(() => expect(rowOf("203.0.113.9")).toBeTruthy());
		expect(screen.getByRole("heading").textContent).toContain("1");
		await waitFor(() => expect(screen.queryByText("Nobody is shut out of signing in.")).toBeNull());
	});
});
