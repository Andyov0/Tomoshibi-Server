import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALLS_STAY_DARK, appearance, followTheSystem, holdNight, subscribe } from "./appearance";

/*
 * Day, and the one place it is not.
 *
 * Everything here fails quietly. A colour given a night value and no day value
 * is a dark patch on a light page, and nothing about it looks broken in the
 * source; the stylesheet's day block naming one attribute while the code sets
 * another is a call drawn by day, with every test that renders it still green;
 * and a call that stops holding the night when the move overlay is still up
 * lights the join screen under it for the length of a move. None of those can
 * be seen without a browser in a light appearance, which is why they are held
 * here instead.
 */

const root = join(import.meta.dirname, "..");
const css = readFileSync(join(root, "index.css"), "utf8");

/** Every block whose header matches, braces balanced, in order. */
function blocks(text: string, header: RegExp): { header: string; body: string }[] {
	const found: { header: string; body: string }[] = [];

	for (const match of text.matchAll(new RegExp(header.source, "g"))) {
		const open = text.indexOf("{", match.index);
		let depth = 0;
		for (let at = open; at < text.length; at++) {
			if (text[at] === "{") depth++;
			else if (text[at] === "}" && --depth === 0) {
				found.push({ header: text.slice(match.index, open).trim(), body: text.slice(open + 1, at) });
				break;
			}
		}
	}

	return found;
}

const theme = blocks(css, /@theme\s*\{/)[0];

// The day values, which are the light block with colours in it: the `day`
// variant asks the same question and holds a slot rather than values.
const daySelector = blocks(css, /@media \(prefers-color-scheme: light\)\s*\{/)
	.map((day) => blocks(day.body, /[^{}]+\{/)[0])
	.find((rule) => rule?.body.includes("--color-"));

describe("the day block", () => {
	it("is found, so that the checks below are checking something", () => {
		expect(theme, "no @theme block in index.css").toBeTruthy();
		expect(daySelector, "no rule inside the prefers-color-scheme: light block").toBeTruthy();
	});

	/*
	 * Named exceptions rather than a loose rule. The foreground on amber is
	 * dark in both and the foreground on red is white in both, which index.css
	 * says beside the block; any other colour without a day value is one
	 * somebody added to the night and forgot.
	 */
	const SAME_BY_DAY = new Set([
		"tally-fg",
		"danger-fg",
		// Mixed from the raised grey and the foreground at the root, so they
		// take the day's values of both without a value of their own; see the
		// comment beside them in the theme.
		"surface-hi-hover",
		"surface-hi-press",
		"wash",
		"wash-press",
	]);

	it("gives every colour the theme defines a day value", () => {
		const night = [...(theme?.body ?? "").matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]);
		const daytime = new Set([...(daySelector?.body ?? "").matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]));

		expect(night.length).toBeGreaterThan(5);
		expect(
			night.filter((name) => name && !daytime.has(name) && !SAME_BY_DAY.has(name)),
			"these have a night value and no day value, so they stay dark on a light page",
		).toEqual([]);
	});

	it("steps aside for exactly the attribute a call sets", () => {
		const selector = daySelector?.header.replace(/\s*\{$/, "") ?? "";
		const element = document.documentElement;

		expect(element.matches(selector), `${selector} should apply when nothing holds the night`).toBe(true);

		const release = holdNight();
		try {
			expect(element.matches(selector), `${selector} still applies while a call holds the night`).toBe(!CALLS_STAY_DARK);
		} finally {
			release();
		}
	});
});

describe("holding the night", () => {
	let light = true;
	const original = globalThis.matchMedia;

	beforeEach(() => {
		light = true;
		globalThis.matchMedia = ((query: string) =>
			({
				media: query,
				matches: query.includes("light") ? light : !light,
				addEventListener() {},
				removeEventListener() {},
			}) as unknown as MediaQueryList) as typeof matchMedia;

		document.head.innerHTML = `
			<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f2f2f7" />
			<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f0e0d" />
		`;
	});

	afterEach(() => {
		globalThis.matchMedia = original;
		document.head.innerHTML = "";
		delete document.documentElement.dataset.appearance;
	});

	it("is what a call does, as things stand", () => {
		// Not a test of a constant so much as a record of the decision, so that
		// flipping it shows up as a red line somebody has to read.
		expect(CALLS_STAY_DARK).toBe(true);
	});

	it("says night on the document, and lets go of it", () => {
		expect(appearance()).toBe("day");

		const release = holdNight();
		expect(document.documentElement.dataset.appearance).toBe("night");
		expect(appearance()).toBe("night");

		release();
		expect(document.documentElement.dataset.appearance).toBeUndefined();
		expect(appearance()).toBe("day");
	});

	it("stays night until the last holder lets go", () => {
		// The move: the overlay holds the night while the room it covers comes
		// down, and the room letting go must not light the page under it.
		const room = holdNight();
		const overlay = holdNight();

		room();
		expect(document.documentElement.dataset.appearance).toBe("night");

		// Letting go twice is one letting go, or a second release from the same
		// holder would take the overlay's hold with it.
		room();
		expect(document.documentElement.dataset.appearance).toBe("night");

		overlay();
		expect(document.documentElement.dataset.appearance).toBeUndefined();
	});

	it("tints the browser's toolbar for the night while it is held", () => {
		const dayTag = document.querySelector<HTMLMetaElement>('meta[media*="light"]');

		const release = holdNight();
		expect(dayTag?.content).toBe("#0f0e0d");

		release();
		expect(dayTag?.content).toBe("#f2f2f7");
	});

	it("is said to whoever is listening", () => {
		const heard = vi.fn();
		const stop = subscribe(heard);

		const release = holdNight();
		release();
		stop();
		holdNight()();

		expect(heard).toHaveBeenCalledTimes(2);
	});

	it("is night in a dark appearance whether or not anything holds it", () => {
		light = false;
		expect(appearance()).toBe("night");
	});
});

describe("day and night fading into each other", () => {
	/*
	 * When the system turned under an open page only the ground faded: the
	 * body had a transition of its own and nothing else did, so for a quarter
	 * of a second there were night cards on a ground still fading from day.
	 * The fade is now the colours' own, at the root, which holds only while
	 * every colour that changes is registered as a colour and named in the
	 * root's transition; and while nothing below the root eases its colour on
	 * its own, or it chases the fade and arrives late, which is what the
	 * attribute below is for. Each of those is a line somebody could delete
	 * and see nothing wrong in a dark appearance.
	 */
	const registered = new Set(
		blocks(css, /@property\s+--color-[a-z0-9-]+\s*\{/)
			.filter((rule) => /syntax:\s*"<color>"/.test(rule.body))
			.map((rule) => rule.header.replace(/^@property\s+--color-/, "")),
	);
	const rootRule = blocks(css, /\n\t:root\s*\{/)[0]?.body ?? "";
	const faded = new Set([...(/transition-property:([^;]*);/.exec(rootRule)?.[1] ?? "").matchAll(/--color-([a-z0-9-]+)/g)].map((m) => m[1]));
	const changes = [...(daySelector?.body ?? "").matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1] ?? "");

	it("registers every colour that changes, and fades it at the root", () => {
		expect(changes.length).toBeGreaterThan(5);
		expect(changes.filter((name) => !registered.has(name)), "not registered as a colour, so it cuts rather than fades").toEqual([]);
		expect(changes.filter((name) => !faded.has(name)), "not in the root's transition, so it cuts rather than fades").toEqual([]);
		expect(rootRule).toMatch(/transition-duration:\s*260ms/);
	});

	it("leaves the body no transition of its own, which would chase the root's", () => {
		const body = blocks(css, /\n\tbody\s*\{/)[0]?.body ?? "";
		expect(body).toContain("background-color: var(--color-bg)");
		expect(body).not.toMatch(/transition/);
	});

	it("sets aside every other transition while it happens, by the attribute the code sets", () => {
		const rule = blocks(css, /:root\[data-appearance-changing\] \*,[^{]*\{/)[0];
		expect(rule, "index.css no longer quiets anything on data-appearance-changing").toBeTruthy();
		expect(rule?.body).toMatch(/transition-property:\s*none !important/);
	});

	describe("and when", () => {
		let reduced = false;
		let light = true;
		let changed: (() => void) | undefined;
		const original = globalThis.matchMedia;
		const quiet = () => document.documentElement.hasAttribute("data-appearance-changing");

		beforeEach(() => {
			vi.useFakeTimers();
			// Left by the tests above, which hold the night with real timers.
			delete document.documentElement.dataset.appearanceChanging;
			reduced = false;
			light = true;
			changed = undefined;
			globalThis.matchMedia = ((query: string) =>
				({
					media: query,
					matches: query.includes("reduced-motion") ? reduced : query.includes("light") ? light : !light,
					addEventListener(_: string, listener: () => void) {
						if (query.includes("color-scheme")) changed = listener;
					},
					removeEventListener() {
						if (query.includes("color-scheme")) changed = undefined;
					},
				}) as unknown as MediaQueryList) as typeof matchMedia;
		});

		afterEach(() => {
			vi.runOnlyPendingTimers();
			vi.useRealTimers();
			globalThis.matchMedia = original;
			delete document.documentElement.dataset.appearance;
			delete document.documentElement.dataset.appearanceChanging;
		});

		it("the system turns under an open page, for the length of the fade and no longer", () => {
			const stop = followTheSystem();

			expect(quiet()).toBe(false);
			changed?.();
			expect(quiet()).toBe(true);

			vi.advanceTimersByTime(260);
			expect(quiet(), "taken away before the fade is over").toBe(true);
			vi.advanceTimersByTime(200);
			expect(quiet(), "left in place, so a hover would no longer ease").toBe(false);

			stop();
			expect(changed).toBeUndefined();
		});

		it("a call takes the night by day, and gives it back", () => {
			const release = holdNight();
			expect(quiet()).toBe(CALLS_STAY_DARK);
			vi.advanceTimersByTime(500);

			release();
			expect(quiet()).toBe(CALLS_STAY_DARK);
		});

		it("but not where nothing on screen changes", () => {
			const stop = followTheSystem();

			// A call by day: the system turning changes nothing in it.
			const release = holdNight();
			vi.advanceTimersByTime(500);
			changed?.();
			expect(quiet()).toBe(!CALLS_STAY_DARK);
			release();
			vi.advanceTimersByTime(500);

			// A call by night: its night is the night already.
			light = false;
			const again = holdNight();
			expect(quiet()).toBe(false);
			again();
			stop();
		});

		it("but not for somebody who asked for less motion, for whom nothing fades", () => {
			reduced = true;
			const stop = followTheSystem();

			changed?.();
			const release = holdNight();
			expect(quiet()).toBe(false);

			release();
			stop();
		});
	});

	it("is listened for by every document", () => {
		for (const entry of ["main.tsx", "account/main.tsx", "manage/main.tsx"]) {
			expect(/\n\s*followTheSystem\(\);/.test(readFileSync(join(root, entry), "utf8")), `${entry} does not follow the system`).toBe(true);
		}
	});
});

describe("what holds it", () => {
	/*
	 * Read from the source, like the controls' lane in styles.test.ts: the room
	 * cannot be rendered here without a media server, and deleting the line
	 * would break nothing any test of it can see. What it breaks is a call
	 * drawn by day.
	 */
	const source = (path: string) => readFileSync(join(root, path), "utf8");

	it("is the room, for as long as it is on screen", () => {
		expect(/\n\s*useNight\(\);/.test(source("routes/Room.tsx")), "Room.tsx no longer holds the night").toBe(true);
	});

	it("is the move overlay, while it is up", () => {
		expect(/useNight\(mounted\)/.test(source("components/room/Moving.tsx")), "Moving.tsx no longer holds the night").toBe(true);
	});
});

describe("by day", () => {
	/*
	 * Two rules from the shared palette that nothing would notice breaking: a
	 * new menu written the night's way — the raised grey, a ring, a deep
	 * shadow — is a grey hole in a white page by day, and a new glow is a
	 * gradient on a page the palette draws flat. Both read as deliberate in
	 * the source. Held by the shapes they are written in, which is narrow on
	 * purpose: a class list that floats something on the raised grey has a
	 * shadow and a ring beside it, and a glow is an arbitrary radial gradient.
	 */
	function sources(dir: string): { path: string; text: string }[] {
		return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) return sources(path);
			return /\.tsx$/.test(entry.name) && !entry.name.includes(".test.") ? [{ path, text: readFileSync(path, "utf8") }] : [];
		});
	}

	const code = sources(root);

	it("floats a raised panel on white", () => {
		const grey = code.flatMap(({ path, text }) =>
			[...text.matchAll(/"[^"\n]*\bbg-surface-hi(?:\/\d+)?\b[^"\n]*"/g)]
				.map((m) => m[0])
				.filter((classes) => /\bshadow-(?:lg|xl|2xl)\b/.test(classes) && /\bring-1\b/.test(classes))
				.filter((classes) => !/\bafloat\b/.test(classes))
				.map((classes) => `${path.replace(root, "")}: ${classes}`),
		);

		expect(grey, "these float on the raised grey and stay grey by day; give them afloat").toEqual([]);
	});

	it("casts one shadow from everything floating", () => {
		// The glass over the join screen's preview kept the night's deep
		// shadow by day, a grey smear on the white preview with the camera
		// off. Whatever floats casts the shadow afloat gives it.
		const shadow = (name: string) => {
			const utility = blocks(css, new RegExp(`@utility ${name}\\s*\\{`))[0]?.body ?? "";
			const day = blocks(utility, /@variant day\s*\{/)[0]?.body ?? "";
			return /box-shadow:([^;]*);/.exec(day)?.[1]?.replace(/\s+/g, " ").trim();
		};

		expect(shadow("afloat")).toBeTruthy();
		expect(shadow("glass"), "the glass has no day shadow, or not the one afloat casts").toBe(shadow("afloat"));
	});

	it("casts no night's shadow on a page that follows the system", () => {
		// The app's mark on the link's landing page wore the night's deepest
		// shadow by day, a grey halo half again as wide as the mark. Outside
		// a call a deep shadow either gives way by day or belongs to
		// something afloat, which brings its own.
		const outside = code.filter(({ path }) => /\/(routes|account|manage|components\/(lobby|apps|ui))\//.test(path) && !path.endsWith("Room.tsx"));
		const deep = outside.flatMap(({ path, text }) =>
			[...text.matchAll(/"[^"\n]*\bshadow-(?:xl|2xl)\b[^"\n]*"/g)]
				.map((m) => m[0])
				.filter((classes) => !/\bday:shadow-|\bafloat\b/.test(classes))
				.map((classes) => `${path.replace(root, "")}: ${classes}`),
		);

		expect(outside.length).toBeGreaterThan(10);
		expect(deep, "a deep shadow by day on a page that follows the system").toEqual([]);
	});

	it("gives the words in an empty field the muted colour by day", () => {
		// The browser's own placeholder is the text at half strength, about
		// three to one on the raised grey by day; most of the management
		// pages' fields name none and were hints nobody could read.
		const day = blocks(css, /@media \(prefers-color-scheme: light\)\s*\{/).map((rule) => rule.body);
		expect(day.some((body) => /::placeholder\s*\{\s*color:\s*var\(--color-fg-muted\)/.test(body))).toBe(true);
	});

	it("outlines a flag by day, whose white is nearly the page's", () => {
		// The flags draw their white as #EEE, which on a white row by day is no
		// edge at all: Japan's was a red dot beside "Tokyo".
		const flag = code.find(({ path }) => path.endsWith("components/room/Flag.tsx"))?.text ?? "";
		const drawn = /<img[\s\S]*?className="([^"]*)"/.exec(flag)?.[1] ?? "";

		expect(drawn).toMatch(/\bday:drop-shadow-\[/);
	});

	it("draws every glow flat", () => {
		const glowing = code.flatMap(({ path, text }) =>
			[...text.matchAll(/[^\n]*radial-gradient[^\n]*(?:\n[^\n]*){0,6}/g)]
				.map((m) => m[0])
				.filter((near) => !/\bday:hidden\b/.test(near))
				.map((near) => `${path.replace(root, "")}: ${near.trim().split("\n")[0]}`),
		);

		expect(glowing, "a glow by day is a gradient on a page the palette draws flat").toEqual([]);
	});
});
