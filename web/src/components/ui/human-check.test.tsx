import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignIn as AccountSignIn } from "@/account/Account";
import { useHumanCheck } from "@/components/ui/human-check";
import { holdNight } from "@/live/appearance";
import { setLocale, t as say } from "@/live/i18n";
import { PATIENCE, SCRIPT, forgetSiteKey } from "@/live/turnstile";
import { SignIn as ManageSignIn } from "@/manage/SignIn";
import { SignIn as LobbySignIn } from "@/routes/Lobby";

const { actionFailed } = vi.hoisted(() => ({ actionFailed: vi.fn() }));

vi.mock("@/live/notices", () => ({ actionFailed, actionDone: vi.fn() }));

/*
 * The human check, on the three forms that sign somebody in.
 *
 * What would go wrong without anybody seeing it is mostly in the gaps between
 * the widget and the form. A token that is not put in the body is a sign-in
 * refused every time with a sentence about a check the person passed. A widget
 * that is not reset after a refusal leaves the spent token in the form, so the
 * second attempt is refused for a reason the first one caused. A token that
 * expires and stays in the form does the same thing ten minutes later. A
 * button that can be pressed before there is a token sends a request that can
 * only be refused. And a deployment with no check must load nothing from
 * Cloudflare at all, which is easiest to break by accident and impossible to
 * notice from the page.
 *
 * Cloudflare's script is a stand-in on the window here, which is where the
 * real one puts itself. Its options are what is asserted: the widget is
 * Cloudflare's to draw, and these tests cannot see inside its frame.
 */

const SITE_KEY = "1x00000000000000000000AA";

interface Drawn {
	options: Record<string, unknown>;
	container: HTMLElement;
}

let drawn: Drawn[];
let reset: ReturnType<typeof vi.fn>;
let removed: ReturnType<typeof vi.fn>;
let posted: { url: string; body: Record<string, unknown> }[];
let refuse: { status: number; error: string; until?: string } | undefined;
let configured: boolean;
let unanswered: number;
let width: number;

function standIn() {
	drawn = [];
	reset = vi.fn();
	removed = vi.fn();
	window.turnstile = {
		render: (container, options) => {
			drawn.push({ container, options });
			return `widget-${drawn.length}`;
		},
		reset,
		remove: removed,
	};
}

/** The token the widget hands over, as its callback hands it. */
function solve(token: string, which = drawn.length - 1) {
	act(() => (drawn[which]?.options.callback as (token: string) => void)(token));
}

beforeEach(() => {
	forgetSiteKey();
	standIn();
	posted = [];
	refuse = undefined;
	configured = true;
	unanswered = 0;
	width = 360;
	localStorage.clear();

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			if (url === "/api/deployment") {
				if (unanswered > 0) {
					unanswered--;
					throw new TypeError("Failed to fetch");
				}

				return new Response(JSON.stringify(configured ? { turnstile: { siteKey: SITE_KEY } } : {}));
			}

			// The front page's fleet light asks for the relays; nothing here
			// is about it.
			if (init?.method !== "POST") {
				return new Response(JSON.stringify({ relays: [], measure: false, fleet: { online: 0, total: 0 } }));
			}

			posted.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });

			if (refuse) {
				return new Response(JSON.stringify({ error: refuse.error, until: refuse.until }), { status: refuse.status });
			}
			if (url === "/api/admin/session") return new Response(JSON.stringify({ trip: "AbCdEfGhIj", can: [] }));

			return new Response(JSON.stringify({ name: "ada", trip: "AbCdEfGhIj" }));
		}),
	);

	// jsdom lays nothing out, so the column is given a width, and has no
	// ResizeObserver to report it with.
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
		() => ({ width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} }) as DOMRect,
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
	vi.stubGlobal("cancelAnimationFrame", (frame: number) => clearTimeout(frame));
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	actionFailed.mockReset();
	delete window.turnstile;
	for (const script of document.querySelectorAll(`script[src="${SCRIPT}"]`)) script.remove();
	act(() => setLocale("en"));
});

// wrong is what each form says to a wrong passphrase, which is the sentence
// the human check's own refusals must not be confused with.
const FORMS = [
	{
		name: "the front page",
		door: "sign-in",
		url: "/api/account/session",
		wrong: "That name and passphrase do not go together.",
		shut: "rate_limited",
		spent: "Too many attempts. Try again in a moment.",
		draw: () => <LobbySignIn onSignedIn={vi.fn()} />,
	},
	{
		name: "the account page",
		door: "sign-in",
		url: "/api/account/session",
		wrong: "That name and passphrase do not go together.",
		shut: "rate_limited",
		spent: "Too many attempts. Try again in a moment.",
		draw: () => <AccountSignIn onIn={vi.fn()} />,
	},
	{
		name: "the management pages",
		door: "admin-sign-in",
		url: "/api/admin/session",
		wrong: "That passphrase is not an administrator's.",
		shut: "too_many_attempts",
		spent: "Too many attempts. Wait a minute and try again.",
		draw: () => <ManageSignIn onIn={vi.fn()} />,
	},
] as const;

function fill() {
	const name = screen.getByLabelText("Name");
	fireEvent.change(name, { target: { value: "ada" } });
	fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "ada's passphrase" } });
}

const button = () => screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement;

describe.each(FORMS)("signing in on $name", ({ door, url, wrong, shut, spent, draw }) => {
	it("draws the widget for its own door and waits for a token", async () => {
		render(draw());
		fill();

		await waitFor(() => expect(drawn).toHaveLength(1));

		const options = drawn[0]?.options ?? {};
		expect(options.sitekey).toBe(SITE_KEY);
		expect(options.action).toBe(door);
		expect(button().disabled).toBe(true);

		solve("token-1");
		expect(button().disabled).toBe(false);
	});

	it("sends the token, and after a refusal starts the check again", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");

		refuse = { status: 403, error: "human_check_failed" };
		fireEvent.click(button());

		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]?.url).toBe(url);
		expect(posted[0]?.body.turnstile).toBe("token-1");

		await waitFor(() => expect(reset).toHaveBeenCalledWith("widget-1"));
		expect(actionFailed).toHaveBeenCalledWith("The human check did not pass. Try again.");

		// The spent token is out of the form until the widget hands over another.
		expect(button().disabled).toBe(true);
		solve("token-2");
		expect(button().disabled).toBe(false);

		// And the passphrase is still there: it was never looked at.
		expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("ada's passphrase");
	});

	it("takes an expired token out of the form and draws a fresh challenge", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");
		expect(button().disabled).toBe(false);

		act(() => (drawn[0]?.options["expired-callback"] as () => void)());

		expect(button().disabled).toBe(true);
		expect(reset).toHaveBeenCalledWith("widget-1");
	});

	it("starts again after a wrong passphrase too, since the token is spent", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");

		refuse = { status: 401, error: url === "/api/admin/session" ? "refused" : "not_yours" };
		fireEvent.click(button());

		await waitFor(() => expect(reset).toHaveBeenCalledWith("widget-1"));
		expect(button().disabled).toBe(true);

		// Said as a wrong passphrase, in the page's words. The management pages
		// read a 401 everywhere else as a session that ended, and this form
		// once passed that on: a wrong passphrase was answered "signed out", in
		// English, whatever the page's language.
		expect(actionFailed).toHaveBeenCalledWith(wrong);
		expect((screen.getByLabelText("Passphrase") as HTMLInputElement).value).toBe("");
	});

	// The server answers a caller shut out of signing in before it asks
	// Cloudflare anything, so a lockout is all that is true about the attempt,
	// and each form says how long it has left. The end is read from a copy of
	// the body before the reason is read from the body itself; read the other
	// way round, the copy cannot be made and the end is never found.
	it("says how long a lockout has left, and starts the check again", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");

		refuse = { status: 429, error: shut, until: new Date(Date.now() + 25 * 60_000 - 5_000).toISOString() };
		fireEvent.click(button());

		await waitFor(() => expect(actionFailed).toHaveBeenCalled());
		expect(actionFailed).toHaveBeenCalledWith("Too many failed sign-ins. Try again in 25 minutes.");

		await waitFor(() => expect(reset).toHaveBeenCalledWith("widget-1"));
		expect(button().disabled).toBe(true);
	});

	it("says to wait where the guessing budget refused, which names no end", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");

		refuse = { status: 429, error: shut };
		fireEvent.click(button());

		await waitFor(() => expect(actionFailed).toHaveBeenCalled());
		expect(actionFailed).toHaveBeenCalledWith(spent);
		await waitFor(() => expect(reset).toHaveBeenCalledWith("widget-1"));
	});

	it("says a wrong passphrase in the page's language", async () => {
		act(() => setLocale("zh-Hans"));
		render(draw());
		await waitFor(() => expect(drawn).toHaveLength(1));
		solve("token-1");

		fireEvent.change(screen.getByLabelText(say("Name")), { target: { value: "ada" } });
		fireEvent.change(screen.getByLabelText(say("Passphrase")), { target: { value: "a wrong one" } });

		refuse = { status: 401, error: url === "/api/admin/session" ? "refused" : "not_yours" };
		fireEvent.click(screen.getByRole("button", { name: say("Sign in") }));

		await waitFor(() => expect(actionFailed).toHaveBeenCalled());
		expect(say(wrong)).not.toBe(wrong);
		expect(actionFailed).toHaveBeenCalledWith(say(wrong));
	});

	it("takes the token out when the challenge times out or the widget fails", async () => {
		render(draw());
		fill();
		await waitFor(() => expect(drawn).toHaveLength(1));

		solve("token-1");
		expect(button().disabled).toBe(false);
		act(() => (drawn[0]?.options["timeout-callback"] as () => void)());
		expect(button().disabled).toBe(true);
		expect(reset).toHaveBeenCalledWith("widget-1");

		solve("token-2");
		expect(button().disabled).toBe(false);
		act(() => (drawn[0]?.options["error-callback"] as () => void)());
		expect(button().disabled).toBe(true);
	});

	it("asks the deployment again after a refusal where it could not be asked at first", async () => {
		unanswered = 1;

		render(draw());
		fill();

		// Let go without a widget, as before: nothing could say there was one.
		await waitFor(() => expect(button().disabled).toBe(false));
		expect(drawn).toHaveLength(0);

		refuse = { status: 400, error: "human_check_missing" };
		fireEvent.click(button());

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith("Complete the human check first."));

		// And now the widget the server wanted, and the button waiting for it.
		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(drawn[0]?.options.action).toBe(door);
		expect(button().disabled).toBe(true);
	});

	it("loads nothing from Cloudflare where the deployment asks for no check", async () => {
		configured = false;
		delete window.turnstile;

		render(draw());
		fill();

		await waitFor(() => expect(button().disabled).toBe(false));
		expect(document.querySelector(`script[src="${SCRIPT}"]`)).toBeNull();

		fireEvent.click(button());
		await waitFor(() => expect(posted).toHaveLength(1));
		expect(posted[0]?.body).not.toHaveProperty("turnstile");
	});
});

describe("the widget", () => {
	it("is drawn in the page's language and its day or night", async () => {
		act(() => setLocale("zh-Hans"));
		render(<AccountSignIn onIn={vi.fn()} />);

		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(drawn[0]?.options.language).toBe("zh-cn");

		// Picked again, drawn again: a widget cannot be told its language after
		// it is drawn.
		act(() => setLocale("ja"));
		await waitFor(() => expect(drawn).toHaveLength(2));
		expect(drawn[1]?.options.language).toBe("ja");
		expect(removed).toHaveBeenCalledWith("widget-1");

		act(() => setLocale("zh-Hant"));
		await waitFor(() => expect(drawn).toHaveLength(3));
		expect(drawn[2]?.options.language).toBe("zh-tw");
	});

	it("follows day and night, and is drawn again when the page changes", async () => {
		vi.stubGlobal("matchMedia", (query: string) => ({
			matches: query === "(prefers-color-scheme: light)",
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}));

		render(<AccountSignIn onIn={vi.fn()} />);

		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(drawn[0]?.options.theme).toBe("light");

		// A call holds the page at night, which is the one change of
		// appearance the page makes itself.
		let release = () => {};
		act(() => {
			release = holdNight();
		});
		await waitFor(() => expect(drawn).toHaveLength(2));
		expect(drawn[1]?.options.theme).toBe("dark");
		expect(removed).toHaveBeenCalledWith("widget-1");

		act(() => release());
		await waitFor(() => expect(drawn).toHaveLength(3));
		expect(drawn[2]?.options.theme).toBe("light");
	});

	it("takes no room in the form until it opens, the gap above it included", async () => {
		function Form() {
			const check = useHumanCheck("sign-in");
			return <div style={{ display: "flex", flexDirection: "column", rowGap: "16px" }}>{check.widget}</div>;
		}

		vi.stubGlobal("requestAnimationFrame", () => 0);
		render(<Form />);

		await waitFor(() => expect(document.querySelector("[data-human-check-space]")).not.toBeNull());
		const space = document.querySelector("[data-human-check-space]") as HTMLElement;

		// Closed: no height, and the column's gap cancelled, so that the button
		// below is where it would be with no widget at all.
		expect(space.style.height).toBe("0px");
		expect(space.style.marginTop).toBe("-16px");
	});

	it("opens on a later frame, with the gap", async () => {
		function Form() {
			const check = useHumanCheck("sign-in");
			return <div style={{ display: "flex", flexDirection: "column", rowGap: "16px" }}>{check.widget}</div>;
		}

		render(<Form />);

		await waitFor(() => {
			const space = document.querySelector("[data-human-check-space]") as HTMLElement | null;
			expect(space?.style.marginTop).toBe("0px");
		});
	});

	it("says it is coming while Cloudflare's script is slow, and stops when the widget speaks", async () => {
		delete window.turnstile;

		render(<AccountSignIn onIn={vi.fn()} />);
		await waitFor(() => expect(document.querySelector(`script[src="${SCRIPT}"]`)).not.toBeNull());

		// Not at once: a fast load should not flash a line up and away.
		expect(screen.queryByText("Loading the human check…")).toBeNull();

		expect(await screen.findByText("Loading the human check…", undefined, { timeout: 2000 })).toBeTruthy();
		expect(button().disabled).toBe(true);

		standIn();
		const script = document.querySelector(`script[src="${SCRIPT}"]`) as HTMLScriptElement;
		act(() => script.onload?.(new Event("load")));

		// The script drew a frame, and the frame has said nothing yet, so the
		// line stays, under it.
		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(screen.getByText("Loading the human check…")).toBeTruthy();

		solve("token-1");
		await waitFor(() => expect(screen.queryByText("Loading the human check…")).toBeNull());
	});

	// The script arrived and drew a frame, and the frame never loaded: a
	// review blocked Cloudflare's challenge alone and no callback of the
	// widget's was ever called, not even its error or its timeout, while the
	// form showed a blank and a grey button for as long as anybody waited.
	describe("when the frame it drew says nothing", () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});
		afterEach(() => {
			vi.useRealTimers();
		});

		const host = () => document.querySelector("[data-human-check]") as HTMLElement;
		const unreachable = "The human check can't be reached right now. Try again later.";

		it("says it is coming, under the widget, so the widget covers it once it draws", async () => {
			render(<AccountSignIn onIn={vi.fn()} />);
			await waitFor(() => expect(drawn).toHaveLength(1));

			const coming = await screen.findByText("Loading the human check…");
			const line = coming.closest("[role=status]") as HTMLElement;

			// Earlier in the page than the widget, and the widget positioned,
			// so the widget is painted over it.
			expect(line.compareDocumentPosition(host()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(host().className).toContain("relative");
		});

		it("says it cannot be reached once the script's patience is spent, and draws a fresh one when asked", async () => {
			render(<AccountSignIn onIn={vi.fn()} />);
			fill();
			await waitFor(() => expect(drawn).toHaveLength(1));
			expect(host().getAttribute("data-human-check")).toBe("drawn");

			act(() => vi.advanceTimersByTime(PATIENCE - 1000));
			expect(screen.queryByText(unreachable)).toBeNull();

			act(() => vi.advanceTimersByTime(1500));
			expect(await screen.findByText(unreachable)).toBeTruthy();
			expect(host().getAttribute("data-human-check")).toBe("stalled");
			expect(host().className).toContain("opacity-0");
			expect(host().getAttribute("aria-hidden")).toBe("true");
			expect(button().disabled).toBe(true);

			fireEvent.click(screen.getByRole("button", { name: "Try again" }));

			await waitFor(() => expect(drawn).toHaveLength(2));
			expect(removed).toHaveBeenCalledWith("widget-1");
			await waitFor(() => expect(screen.queryByText(unreachable)).toBeNull());
			expect(host().getAttribute("data-human-check")).toBe("drawn");

			solve("token-2");
			expect(button().disabled).toBe(false);
		});

		it("puts the form back if a slow frame speaks after all", async () => {
			render(<AccountSignIn onIn={vi.fn()} />);
			fill();
			await waitFor(() => expect(drawn).toHaveLength(1));

			act(() => vi.advanceTimersByTime(PATIENCE + 500));
			expect(await screen.findByText(unreachable)).toBeTruthy();

			solve("late");
			await waitFor(() => expect(screen.queryByText(unreachable)).toBeNull());
			expect(host().getAttribute("data-human-check")).toBe("drawn");
			expect(host().className).toContain("opacity-100");
			expect(button().disabled).toBe(false);
		});

		it.each(["callback", "error-callback", "before-interactive-callback", "unsupported-callback"])(
			"is not said where the frame spoke first, by its %s",
			async (which) => {
				render(<AccountSignIn onIn={vi.fn()} />);
				await waitFor(() => expect(drawn).toHaveLength(1));

				act(() => (drawn[0]?.options[which] as (token?: string) => void)("token-1"));

				act(() => vi.advanceTimersByTime(PATIENCE * 2));
				await act(async () => {});

				expect(screen.queryByText(unreachable)).toBeNull();
				expect(screen.queryByText("Loading the human check…")).toBeNull();
				expect(host().getAttribute("data-human-check")).toBe("drawn");
			},
		);
	});

	it("is the compact one in a column too narrow for the flexible one", async () => {
		width = 288;
		render(<ManageSignIn onIn={vi.fn()} />);

		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(drawn[0]?.options.size).toBe("compact");
	});

	it("is the flexible one where there is room", async () => {
		width = 360;
		render(<ManageSignIn onIn={vi.fn()} />);

		await waitFor(() => expect(drawn).toHaveLength(1));
		expect(drawn[0]?.options.size).toBe("flexible");
	});

	it("loads Cloudflare's script once, in explicit mode, from Cloudflare", async () => {
		delete window.turnstile;

		render(<AccountSignIn onIn={vi.fn()} />);

		await waitFor(() => expect(document.querySelectorAll(`script[src="${SCRIPT}"]`)).toHaveLength(1));
		expect(SCRIPT).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit");

		standIn();
		const script = document.querySelector(`script[src="${SCRIPT}"]`) as HTMLScriptElement;
		act(() => script.onload?.(new Event("load")));

		await waitFor(() => expect(drawn).toHaveLength(1));
	});

	it("says when Cloudflare cannot be reached, and tries again when asked", async () => {
		delete window.turnstile;

		render(<AccountSignIn onIn={vi.fn()} />);
		await waitFor(() => expect(document.querySelector(`script[src="${SCRIPT}"]`)).not.toBeNull());

		const first = document.querySelector(`script[src="${SCRIPT}"]`) as HTMLScriptElement;
		act(() => first.onerror?.(new Event("error")));

		const again = await screen.findByRole("button", { name: "Try again" });
		expect(screen.getByText("The human check can't be reached right now. Try again later.")).toBeTruthy();
		expect(button().disabled).toBe(true);

		fireEvent.click(again);
		await waitFor(() => expect(document.querySelector(`script[src="${SCRIPT}"]`)).not.toBeNull());

		standIn();
		const second = document.querySelector(`script[src="${SCRIPT}"]`) as HTMLScriptElement;
		act(() => second.onload?.(new Event("load")));

		await waitFor(() => expect(drawn).toHaveLength(1));
	});
});

describe("the sentences", () => {
	it("are the plain ones, in each language", async () => {
		const { humanCheckSaid } = await import("@/live/turnstile");

		act(() => setLocale("zh-Hans"));
		expect(humanCheckSaid("human_check_missing")).toBe("请先完成人机验证。");
		expect(humanCheckSaid("human_check_failed")).toBe("人机验证没通过，请再试一次。");
		expect(humanCheckSaid("human_check_unavailable")).toBe("暂时连不上人机验证服务，请稍后再试。");
		expect(humanCheckSaid("not_yours")).toBeUndefined();
	});
});
