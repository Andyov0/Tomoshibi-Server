/*
 * Day and night.
 *
 * Every screen follows the system's appearance, and follows it live: the
 * stylesheet asks the system directly (index.css, the day block), so the first
 * frame is already right and a change in the system is a change on screen with
 * nothing here to hear it.
 *
 * Except a call, which is night whatever the system says, as FaceTime and Meet
 * are. A call is a screen full of faces looked at for an hour, and a pale frame
 * around them is the brightest thing in the room; the owner's rule for every
 * client is that the meeting stays dark and everything around it follows the
 * system. This is where that is held.
 *
 * Held on the document rather than on the call's own element. A class on the
 * room would reach the room and nothing it opens: every menu is put at the end
 * of the body by Radix, the notices are mounted beside the application rather
 * than inside it, and the browser's own scrollbars and controls take their
 * appearance from the root. A call with its menus drawn by day was the first
 * thing a narrower switch would have produced.
 */

/**
 * Whether a call stays dark when the system is light. The one switch: false
 * lets a call follow the system like every other screen. What a call draws is
 * drawn in the same named colours as the rest, so all of it follows by itself.
 * The things that once would not have — the raised hand, on its button and on
 * its picture, drawn on amber in the ground's own colour, which by day is pale
 * on amber; and the message box's faint white wash, which is nothing on a white
 * panel — now take the colour meant for words on amber and the raised grey
 * every field wears.
 *
 * One of four on purpose: the palette the clients share asks each of them for
 * one named switch of this meaning, so that they can be turned together.
 */
export const CALLS_STAY_DARK = true;

/** What the stylesheet reads: `data-appearance="night"` on the root. */
const NIGHT = "night";

/** The system's own question, the one the stylesheet asks. */
const DAY = "(prefers-color-scheme: light)";

export type Appearance = "day" | "night";

/*
 * Counted rather than a flag. A move draws its overlay while the room it is
 * moving comes down and the next goes up, and both hold the night; the first of
 * them to let go must not light the page under the other.
 */
let holding = 0;

const listeners = new Set<() => void>();

function systemSaysDay(): boolean {
	return typeof matchMedia === "function" && matchMedia(DAY).matches;
}

/** What is on screen now. */
export function appearance(): Appearance {
	return holding === 0 && systemSaysDay() ? "day" : "night";
}

/**
 * Hear the appearance change, from the system or from a call coming and going.
 * Returns a function that stops hearing it.
 *
 * Only for what the stylesheet cannot colour by itself, which is a canvas: the
 * management pages' chart draws its lines in colours given to it once.
 */
export function subscribe(listener: () => void): () => void {
	listeners.add(listener);

	const query = typeof matchMedia === "function" ? matchMedia(DAY) : undefined;
	query?.addEventListener?.("change", listener);

	return () => {
		listeners.delete(listener);
		query?.removeEventListener?.("change", listener);
	};
}

/** What the stylesheet reads while day and night are fading into each other. */
const CHANGING = "appearanceChanging";

/** The root's fade in index.css, and a little over. */
const FADE_MS = 260 + 140;

let still: ReturnType<typeof setTimeout> | undefined;

/*
 * Every element's own transitions, set aside while the colours fade.
 *
 * The fade is the root's (index.css, beside the registered colours): the
 * colours move there, once, and whatever is drawn in them follows frame by
 * frame. Except what has a colour transition of its own, a button's or a
 * link's for its hover, which took each frame's colour as a change to ease
 * towards and so chased the fade from behind: filmed, a card on the account
 * page finished two hundred milliseconds after everything around it, light
 * on a page that had already gone dark. For the length of the fade those
 * transitions are taken away and such an element follows the colours
 * exactly, as everything else does; its hover is its own again after.
 */
function holdStill(): void {
	if (typeof document === "undefined") return;
	if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return;

	const root = document.documentElement;
	root.dataset[CHANGING] = "";
	clearTimeout(still);
	still = setTimeout(() => delete root.dataset[CHANGING], FADE_MS);
}

/**
 * Hear the system change appearance under an open page, so that what has
 * transitions of its own follows the fade rather than chasing it (holdStill).
 * Returns a function that stops.
 *
 * The fade itself needs nothing from here and happens without this. It is
 * the media query's own change event, which Chrome sends a frame after it
 * has restyled the page for the new appearance, so the first frame of the
 * fade may still be chased; every frame after it is not. Not while a call
 * holds the night, where the system changing changes nothing on screen.
 */
export function followTheSystem(): () => void {
	if (typeof matchMedia !== "function") return () => {};

	const query = matchMedia(DAY);
	const changed = () => {
		if (holding === 0) holdStill();
	};

	query.addEventListener?.("change", changed);

	return () => query.removeEventListener?.("change", changed);
}

/**
 * Night on the whole document, until the function this returns is called.
 *
 * Does nothing where calls follow the system (CALLS_STAY_DARK), so that every
 * caller can ask unconditionally and the decision stays in one place.
 */
export function holdNight(): () => void {
	if (!CALLS_STAY_DARK) return () => {};

	holding++;
	if (holding === 1) settle();

	let held = true;

	return () => {
		if (!held) return;
		held = false;

		holding--;
		if (holding === 0) settle();
	};
}

function settle(): void {
	const root = document.documentElement;

	// Before the attribute below, in the same task, so that the restyle that
	// changes the colours is the one that finds every element still.
	if (systemSaysDay()) holdStill();

	if (holding > 0) root.dataset.appearance = NIGHT;
	else delete root.dataset.appearance;

	paintBrowser();

	for (const listener of listeners) listener();
}

/*
 * The browser's own frame around the page: the toolbar a phone tints to match
 * it. Each document carries one colour for each appearance, chosen by the
 * system as the stylesheet is; while a call holds the night the day one says
 * the night's colour, or a phone held in a light appearance would wrap a dark
 * call in a pale toolbar. Read from the tags rather than written here, so the
 * colours are said once, beside each other, in the documents.
 */
function paintBrowser(): void {
	// The attribute rather than the property, which not every engine reflects
	// on a meta tag: jsdom has no such property, and reading it threw here with
	// the hold already counted, which left the document night for good.
	const tags = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
	const media = (tag: HTMLMetaElement) => tag.getAttribute("media") ?? "";
	const night = tags.find((tag) => media(tag).includes("dark"))?.content;

	for (const tag of tags) {
		if (!media(tag).includes("light")) continue;

		tag.dataset.day ??= tag.content;
		tag.content = holding > 0 && night ? night : tag.dataset.day;
	}
}

/*
 * The night a page arrives with, when it is a reload in the middle of a call.
 *
 * A reload goes straight back into the call, but only once the page has asked
 * the server who is here and joined again, and until then it drew what every
 * page draws by day: a pale ground, then the join screen, pale, for as long
 * as the join took, and then the call, dark. Filmed by day, the frame a tenth
 * of a second after a reload was the whole join screen in day colours, on a
 * local server with nothing to wait for. A call is night; so is the way back
 * into one. The document's head says night before anything is drawn when this
 * tab was in the room its address names (index.html, which reads the same
 * key as wasIn in api.ts), and it is counted here as one more hold, let go by
 * App once the doorway has said where the page is going: kept until the call
 * is on screen and holds the night itself, or let go at once where the next
 * screen follows the system.
 */
let arrived = false;

if (typeof document !== "undefined" && document.documentElement.dataset.appearance === NIGHT) {
	if (CALLS_STAY_DARK) {
		holding++;
		arrived = true;
		paintBrowser();
	} else {
		delete document.documentElement.dataset.appearance;
	}
}

/** Let go of the night the page arrived with. Does nothing the second time, or where there was none. */
export function arrivalOver(): void {
	if (!arrived) return;
	arrived = false;

	holding--;
	if (holding === 0) settle();
}
