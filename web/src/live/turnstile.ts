import { type Locale, t } from "./i18n";

/*
 * Cloudflare's human check, for the three sign-in forms: the front page's, the
 * account page's and the management pages'.
 *
 * Asked for only where the deployment says so. /api/deployment carries the
 * widget's site key where the sign-in doors want a token and nothing where they
 * do not, and a page told nothing loads nothing from Cloudflare and signs in
 * exactly as it did before there was a check.
 *
 * The script is Cloudflare's and is loaded from Cloudflare, in explicit mode, so
 * that it draws the widget where and when a form asks rather than wherever it
 * finds a class name. It is not bundled: Cloudflare's own documentation is
 * plain that a copy served from anywhere else is unsupported and will stop
 * working when the widget changes underneath it.
 */

/** Where the widget's script is, in the mode that draws only when asked. */
export const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The actions the server checks each door's token for (internal/turnstile). */
export type Door = "sign-in" | "admin-sign-in";

/** What the script puts on the window, as much of it as is used here. */
export interface Turnstile {
	render(container: HTMLElement, options: Record<string, unknown>): string | undefined;
	reset(widget?: string): void;
	remove(widget?: string): void;
}

declare global {
	interface Window {
		turnstile?: Turnstile;
	}
}

let known: Promise<string> | undefined;

/**
 * How long /api/deployment is waited for before the form is let go without a
 * widget. The page itself came from the same server, so an answer slower than
 * this is a server in trouble rather than a slow path, and the form waiting on
 * it is a grey button nobody can explain.
 */
const ASKING = 10_000;

/**
 * The widget's site key, or empty where the deployment asks for no check.
 *
 * Asked once per page and kept where it was answered. Empty as well where the
 * deployment cannot be asked, or does not answer in time: the form then signs
 * in without a token, and a server that wanted one says so in its refusal,
 * which is better than a form that waits for a widget nobody can draw.
 *
 * But an asking that failed is not kept. It used to be, and the page then
 * believed for its whole life that there was no check: on a deployment with
 * one, every sign-in was refused with "complete the human check first" over a
 * form with nothing on it to complete, until a reload. Forgotten instead, the
 * next asking asks again, and the forms ask again after every refusal
 * (useHumanCheck's reset).
 */
export function siteKey(): Promise<string> {
	if (known) return known;

	const asking = askDeployment().catch(() => {
		if (known === asking) known = undefined;
		return "";
	});
	known = asking;

	return asking;
}

async function askDeployment(): Promise<string> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), ASKING);

	try {
		const response = await fetch("/api/deployment", { signal: abort.signal });
		if (!response.ok) throw new Error(`the deployment answered ${response.status}`);

		return keyOf((await response.json()) as { turnstile?: { siteKey?: unknown } });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * What the front page already read from /api/deployment, so the sign-in shown
 * after it does not ask a second time.
 */
export function learnSiteKey(body: { turnstile?: { siteKey?: unknown } }): void {
	known = Promise.resolve(keyOf(body));
}

function keyOf(body: { turnstile?: { siteKey?: unknown } } | undefined): string {
	const key = body?.turnstile?.siteKey;

	return typeof key === "string" ? key : "";
}

/** For tests: forget what was learned. */
export function forgetSiteKey(): void {
	known = undefined;
	loading = undefined;
}

/**
 * How long the script is waited for before the widget is said to be
 * unreachable, and then how long the frame it draws is waited for
 * (components/ui/human-check.tsx).
 *
 * Long, because the people this deployment serves are often in mainland China,
 * where Cloudflare's script can take many seconds to arrive and does arrive;
 * and not for ever, because a form that waits silently for a widget that will
 * not come is a form somebody gives up on without knowing why.
 */
export const PATIENCE = 20_000;

let loading: Promise<Turnstile> | undefined;

/**
 * Cloudflare's script, loaded once for the page.
 *
 * Rejects where it cannot be loaded, and forgets the failure, so that pressing
 * "Try again" tries again rather than repeating the first answer.
 */
export function loadTurnstile(): Promise<Turnstile> {
	if (window.turnstile) return Promise.resolve(window.turnstile);

	loading ??= new Promise<Turnstile>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT;
		script.async = true;

		const failed = () => {
			clearTimeout(timer);
			loading = undefined;
			reject(new Error("human_check_unavailable"));
		};

		// The script may still arrive after this has given up on it, and then a
		// second press of "Try again" finds it on the window at once.
		const timer = setTimeout(failed, PATIENCE);

		script.onload = () => {
			clearTimeout(timer);

			if (window.turnstile) resolve(window.turnstile);
			else failed();
		};
		script.onerror = () => {
			script.remove();
			failed();
		};

		document.head.append(script);
	});

	return loading;
}

/**
 * The widget's language for the page's.
 *
 * Named rather than left to Cloudflare's guess from the browser, because the
 * page's language is somebody's choice in the picker and the browser's is not:
 * a Japanese page with a widget speaking English is a page that changed its
 * mind halfway down.
 */
export function languageFor(locale: Locale): string {
	switch (locale) {
		case "zh-Hans":
			return "zh-cn";
		case "zh-Hant":
			return "zh-tw";
		case "ja":
			return "ja";
		default:
			return "en";
	}
}

/**
 * The sentence for a refusal the human check caused, or undefined where the
 * refusal was something else and the form's own sentence applies.
 */
export function humanCheckSaid(reason: string | undefined): string | undefined {
	switch (reason) {
		case "human_check_missing":
			return t("Complete the human check first.");
		case "human_check_failed":
			return t("The human check did not pass. Try again.");
		case "human_check_unavailable":
			return t("The human check can't be reached right now. Try again later.");
		default:
			return undefined;
	}
}

/** The code a refused response came back with, if it can be read. */
export async function reasonOf(response: Response): Promise<string | undefined> {
	try {
		const body = (await response.json()) as { error?: unknown };

		return typeof body.error === "string" ? body.error : undefined;
	} catch {
		return undefined;
	}
}
