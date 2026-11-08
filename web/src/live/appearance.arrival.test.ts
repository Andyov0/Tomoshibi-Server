import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/*
 * The night a page arrives with, on a reload in the middle of a call.
 *
 * By day a reload drew the join screen pale for as long as the way back into
 * the call took, between two dark frames. The document's head now says night
 * before anything is drawn when the tab was in the room its address names, and
 * the module counts that as a hold when it loads; App lets it go once it knows
 * where the page is going. A module that ignored the attribute would leave the
 * page night for good the first time a call let go of it, or day under a call
 * on its way back: neither shows by night, which is why it is held here. Each
 * test loads the module afresh, since the arrival is read when it loads.
 */

const root = join(import.meta.dirname, "..");
const original = globalThis.matchMedia;

beforeEach(() => {
	vi.resetModules();
	globalThis.matchMedia = ((query: string) =>
		({
			media: query,
			matches: query.includes("light"),
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
	delete document.documentElement.dataset.appearanceChanging;
});

it("holds the night a reload arrives with until it is let go", async () => {
	document.documentElement.dataset.appearance = "night";
	const { appearance, arrivalOver, holdNight } = await import("./appearance");

	// By day, with nothing in the page holding it yet.
	expect(appearance()).toBe("night");
	expect(document.querySelector<HTMLMetaElement>('meta[media*="light"]')?.content).toBe("#0f0e0d");

	// The call comes back and holds it, and the arrival lets go under it.
	const call = holdNight();
	arrivalOver();
	expect(document.documentElement.dataset.appearance).toBe("night");

	// Twice is once: a second letting go must not take the call's hold.
	arrivalOver();
	expect(document.documentElement.dataset.appearance).toBe("night");

	call();
	expect(document.documentElement.dataset.appearance).toBeUndefined();
	expect(appearance()).toBe("day");
});

it("gives the day back where the page is not going into a call", async () => {
	document.documentElement.dataset.appearance = "night";
	const { appearance, arrivalOver } = await import("./appearance");

	arrivalOver();
	expect(document.documentElement.dataset.appearance).toBeUndefined();
	expect(appearance()).toBe("day");
	expect(document.querySelector<HTMLMetaElement>('meta[media*="light"]')?.content).toBe("#f2f2f7");
});

it("lets go of nothing where the page arrived by day", async () => {
	const { arrivalOver, holdNight } = await import("./appearance");

	const call = holdNight();
	arrivalOver();
	expect(document.documentElement.dataset.appearance).toBe("night");
	call();
	expect(document.documentElement.dataset.appearance).toBeUndefined();
});

it("is said by the head in the key the tab's last room is kept under", () => {
	const html = readFileSync(join(root, "..", "index.html"), "utf8");
	const key = /const WAS_IN_KEY = "([^"]+)"/.exec(readFileSync(join(root, "live/api.ts"), "utf8"))?.[1];
	const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

	expect(key).toBeTruthy();
	expect(script).toContain(`sessionStorage.getItem("${key}")`);
	expect(script).toContain('setAttribute("data-appearance", "night")');
});

it("is let go by App, after the doorway and once the call is on screen", () => {
	const app = readFileSync(join(root, "App.tsx"), "utf8");

	expect(app).toMatch(/if \(!straightIn\) arrivalOver\(\);/);
	expect(app).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(live\) arrivalOver\(\);\s*\}, \[live\]\);/);
	expect((app.match(/\.catch\(arrivalOver\)/g) ?? []).length).toBe(2);
});
