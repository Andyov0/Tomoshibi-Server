import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/live/i18n";
import { forgetSiteKey } from "@/live/turnstile";
import { SignIn } from "./Account";

const { actionFailed } = vi.hoisted(() => ({ actionFailed: vi.fn() }));

vi.mock("@/live/notices", () => ({ actionFailed, actionDone: vi.fn() }));

/*
 * What the account sign-in says when it is refused.
 *
 * Every refusal used to say the name and passphrase did not go together. For a
 * caller shut out after too many failures that is the worst thing it could
 * say: they type the pair again, correctly, and are refused again, and each of
 * those is a press against a door that is shut for half an hour. So a lockout
 * says how long is left, in the reader's language; the guessing budget's own
 * refusal says to wait; and only a wrong pair says what it always said.
 */

// The form asks /api/deployment whether there is a human check before its
// button can be pressed (live/turnstile.ts); a deployment with none is
// answered here, so that only the sign-in is refused.
function answering(status: number, body: Record<string, unknown>) {
	const fetched = vi.fn(async (url: string) =>
		url === "/api/deployment" ? new Response("{}") : new Response(JSON.stringify(body), { status }),
	);
	vi.stubGlobal("fetch", fetched);
	return fetched;
}

/** Press the form's button once it can be pressed. */
async function press(name: string) {
	const button = screen.getByRole("button", { name }) as HTMLButtonElement;
	await waitFor(() => expect(button.disabled).toBe(false));
	fireEvent.click(button);
}

async function signIn() {
	const onIn = vi.fn();
	render(<SignIn onIn={onIn} />);

	fireEvent.change(screen.getByLabelText("Name"), { target: { value: "ada" } });
	fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "a passphrase" } });
	await press("Sign in");

	await waitFor(() => expect(actionFailed).toHaveBeenCalled());

	expect(onIn).not.toHaveBeenCalled();
	return actionFailed.mock.calls[0]?.[0] as string;
}

afterEach(() => {
	forgetSiteKey();
	vi.unstubAllGlobals();
	actionFailed.mockReset();
	act(() => setLocale("en"));
});

describe("a refused sign-in", () => {
	it("says how many minutes a lockout has left", async () => {
		answering(429, { error: "rate_limited", until: new Date(Date.now() + 25 * 60_000 - 5_000).toISOString(), retryAfter: 1495 });

		expect(await signIn()).toBe("Too many failed sign-ins. Try again in 25 minutes.");
	});

	it("says it in the reader's language", async () => {
		act(() => setLocale("zh-Hans"));
		answering(429, { error: "rate_limited", until: new Date(Date.now() + 30 * 60_000).toISOString() });

		render(<SignIn onIn={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("名称"), { target: { value: "ada" } });
		fireEvent.change(screen.getByLabelText("口令"), { target: { value: "a passphrase" } });
		await press("登录");

		await waitFor(() => expect(actionFailed).toHaveBeenCalledWith("登录失败次数太多，请 30 分钟后再试。"));
	});

	it("says to wait a moment when it is the guessing budget", async () => {
		answering(429, { error: "rate_limited" });

		expect(await signIn()).toBe("Too many attempts. Try again in a moment.");
	});

	it("says what it always said about a wrong name or passphrase", async () => {
		answering(401, { error: "not_yours" });

		expect(await signIn()).toBe("That name and passphrase do not go together.");
	});
});
