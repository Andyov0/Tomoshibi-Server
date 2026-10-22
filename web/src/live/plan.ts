import { arrange } from "./layout";

/**
 * Where every picture sits, as coordinates rather than as a tree.
 *
 * The arrangement used to be expressed by which component a tile was rendered
 * inside: a grid in one mode, a stage and a filmstrip in the other. Switching
 * between them replaced one tree with the other, so React destroyed every video
 * element and built new ones — and a video element that unmounts takes its
 * subscription with it. Putting somebody on the stage therefore stopped their
 * stream, started it again, and waited for a keyframe before anything appeared.
 * That wait is the black screen.
 *
 * Positions do not have that problem. Every picture is rendered once, in one
 * place, for as long as its owner is in the room; what changes is where it is
 * and how large. Nothing unmounts, so nothing unsubscribes, and moving to the
 * stage becomes an animation rather than an interruption.
 *
 * The geometry lives here, apart from React, because it is arithmetic and
 * arithmetic can be checked.
 */

/** Space between pictures, and between a picture and the edge. */
export const GAP = 8;

/**
 * Pictures per page in the grid.
 *
 * Nine keeps a grid readable on a laptop, and caps how many streams the call
 * asks for at once however many people joined. The filmstrip has no fixed number
 * of its own — what it holds is whatever fits, which is [`stripCapacity`](#stripCapacity).
 */
export const TILES_PER_PAGE = 9;

/** How far above the bottom of the window the controls sit, without a home indicator: max(1.25rem, …). */
export const ISLAND_OFFSET = 20;

/** How tall the controls are at their largest: forty-four pixel buttons, six of padding each side, a border. */
export const ISLAND_HEIGHT = 58;

/**
 * Height the floating controls occupy at the bottom of the window: how far up
 * they sit, how tall they are, and a gap.
 *
 * Reserved so that nothing is laid out underneath them. The filmstrip used to
 * run to the bottom edge and pass beneath the island, which put whoever happened
 * to be in the middle of the strip behind a row of buttons.
 *
 * This is the figure for a screen with no home indicator, and it is only where
 * nothing has been measured: the room measures the island where it is drawn and
 * passes what it found (`island`, below, and ControlBar's `onReserve`). It was a
 * single constant of 68 once, written when the island was forty pixels tall and
 * twenty from the edge, and it outlived both: the island grew to 58, a phone with
 * a home indicator lifts it to the inset and eight more, and the strip's last
 * ten pixels on a laptop — thirty-two on an iPhone, where the names are — sat
 * under the buttons, so a press on somebody's name pressed the controls (found
 * in review, 2026-10-14).
 */
export const ISLAND = ISLAND_OFFSET + ISLAND_HEIGHT + GAP;

/** How tall a picture is in the filmstrip. */
const STRIP = 112;

/**
 * The shape a picture keeps, which is not one shape.
 *
 * A phone films in the shape it is held in, and a layout that only knows
 * sixteen by nine crops a face standing upright down to a band across its eyes.
 * The same arrangement upright wastes most of the screen: measured, one other
 * person on a phone took twenty-eight per cent of it and left the rest black.
 *
 * So the tile follows the viewport. Three by four upright rather than the full
 * nine by sixteen, because a tile as narrow as the camera would leave two
 * columns impossible and the grid is worth more than the last of the crop.
 */
const LANDSCAPE = 16 / 9;
const UPRIGHT = 3 / 4;

/**
 * Whether this is a screen held upright, rather than a window that happens to
 * be tall.
 *
 * A fifth taller than it is wide, not merely taller. Flipping at exactly square
 * makes the whole arrangement change shape as a window is dragged through that
 * point, and a layout that reshapes itself under the pointer is worse than one
 * that is slightly wrong. A phone held upright is past two to one and never
 * near the boundary.
 */
export function upright(container: Size): boolean {
	return container.height > container.width * 1.2;
}

function aspectFor(container: Size): number {
	return upright(container) ? UPRIGHT : LANDSCAPE;
}

/**
 * How many pictures share the screen before one of them is given the whole of
 * it.
 *
 * Two people is not a grid of two. It is one person being looked at and one
 * being checked on, and every telephone made since video calling existed draws
 * it that way: the other person fills the screen and you are a card in the
 * corner. The grid begins at three.
 */
export const ALONE_TOGETHER = 2;

/** Somewhere for one picture to be. */
export interface Spot {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Where each picture goes, by id.
 *
 * An id that is absent is not shown at all. It is still rendered — that is the
 * point — but it is out of sight, which costs nothing: a hidden element does not
 * intersect the viewport, and a track nobody is looking at is dropped to nothing
 * by the subscription that follows visibility.
 */
export type Plan = Map<string, Spot>;

export interface Size {
	width: number;
	height: number;
}

/**
 * Lay pictures out in a grid, centred.
 *
 * Sizes come from [`arrange`](./layout.ts); this places them. The island is
 * taken out of the space an arrangement may fill but not out of the space it is
 * centred in, so a grid sits where the eye expects it rather than being pushed
 * upward with a band of nothing beneath it.
 *
 * Each row is centred on its own. Only the last row is ever short, and a short
 * row aligned to the left leaves its gap at one end, which reads as a mistake
 * rather than as a room with somebody missing from it.
 */
export function planGrid(container: Size, ids: string[], island = ISLAND): Plan {
	const plan: Plan = new Map();

	const layout = arrange(
		{ width: container.width, height: Math.max(0, container.height - island) },
		ids.length,
		GAP,
		aspectFor(container),
	);
	if (!layout) return plan;

	const { columns, rows, width, height } = layout;
	const gridHeight = rows * height + (rows - 1) * GAP;
	const top = (container.height - gridHeight) / 2;

	ids.forEach((id, index) => {
		const row = Math.floor(index / columns);
		const column = index % columns;

		const inRow = row === rows - 1 ? ids.length - row * columns : columns;
		const rowWidth = inRow * width + (inRow - 1) * GAP;

		plan.set(id, {
			x: (container.width - rowWidth) / 2 + column * (width + GAP),
			y: top + row * (height + GAP),
			width,
			height,
		});
	});

	return plan;
}

/**
 * Lay one picture on a stage with the rest in a filmstrip beneath it.
 *
 * Whoever is given in `strip` is placed in it. Deciding how many that may be
 * belongs to the caller, which has to page the remainder anyway; asking
 * [`stripCapacity`](#stripCapacity) twice would be two places to get it wrong.
 */
export function planFocus(
	container: Size,
	stage: string,
	strip: string[],
	options: { fullscreen?: boolean; island?: number } = {},
): Plan {
	const plan: Plan = new Map();
	if (container.width <= 0 || container.height <= 0) return plan;

	// Somebody who asked for the whole screen asked for the whole screen: no
	// padding, no strip, and nothing reserved for controls that have stepped
	// aside themselves.
	if (options.fullscreen) {
		plan.set(stage, { x: 0, y: 0, width: container.width, height: container.height });
		return plan;
	}

	const bottom = container.height - (options.island ?? ISLAND);
	const showStrip = strip.length > 0;
	const stripTop = bottom - STRIP;

	plan.set(stage, {
		x: GAP,
		y: GAP,
		width: Math.max(0, container.width - 2 * GAP),
		height: Math.max(0, (showStrip ? stripTop - GAP : bottom) - GAP),
	});

	if (!showStrip) return plan;

	const width = STRIP * aspectFor(container);
	const total = strip.length * width + (strip.length - 1) * GAP;
	const left = (container.width - total) / 2;

	strip.forEach((id, index) => {
		plan.set(id, {
			x: left + index * (width + GAP),
			y: stripTop,
			width,
			height: STRIP,
		});
	});

	return plan;
}

/**
 * How far above the bottom of the room something drawn over the pictures has to
 * end to leave these ones uncovered: the distance to the top of the highest of
 * them, and a gap. Nothing where none of them has been placed.
 *
 * For the filmstrip, which the card saying that a share is more than the line
 * carries was drawn straight across. That card sat just clear of the controls,
 * which is exactly where the strip begins — the strip is laid out from the
 * island up — so at every width from a phone to a laptop a press on the
 * pictures in it landed on the card, and the person sharing could not put
 * anybody on the stage until they had answered it. Read from the plan rather
 * than worked out again from ISLAND and the strip's height, so that it follows
 * the strip wherever the plan moves it, and is nothing when there is no strip.
 */
export function clearOf(plan: Plan, ids: string[], container: Size): number | undefined {
	const tops = ids.flatMap((id) => {
		const spot = plan.get(id);
		return spot ? [spot.y] : [];
	});

	if (tops.length === 0) return undefined;

	return container.height - Math.min(...tops) + GAP;
}

/**
 * How many pictures the filmstrip holds at this width.
 *
 * At least one, because a strip that holds nobody would page for ever without
 * ever showing anything.
 */
export function stripCapacity(container: Size): number {
	const width = STRIP * aspectFor(container);
	const usable = container.width - 2 * GAP + GAP;

	return Math.max(1, Math.floor(usable / (width + GAP)));
}

/**
 * One picture filling the screen, with the rest as cards over it.
 *
 * The arrangement two people deserve and the one every telephone uses: the
 * other person takes the whole screen and you are a card in the corner. A grid
 * of two on a phone measured fifty-six per cent of the screen and read as two
 * strangers rather than a conversation.
 *
 * The cards sit over the picture rather than beside it, so nothing is taken
 * from the person being looked at. They are placed from the top down the
 * trailing edge, clear of the controls at the foot and of the room's name at
 * the head.
 */
export function planClose(container: Size, filling: string, cards: string[], island = ISLAND): Plan {
	const plan: Plan = new Map();
	if (container.width <= 0 || container.height <= 0) return plan;

	plan.set(filling, { x: 0, y: 0, width: container.width, height: container.height });

	// A quarter of the width upright, a fifth across, and never past what the
	// space beside the controls can hold.
	const width = Math.min(
		container.width * (upright(container) ? 0.26 : 0.18),
		(container.height - island - 2 * GAP) / 2,
	);
	const height = width / aspectFor(container);

	cards.forEach((id, index) => {
		const top = HEADROOM + index * (height + GAP);
		if (top + height > container.height - island) return;

		plan.set(id, {
			x: container.width - width - GAP,
			y: top,
			width,
			height,
		});
	});

	return plan;
}

/**
 * Room left at the head for whatever is drawn over the picture.
 *
 * The room's name sits there, and on a phone so does the notch. Cards begin
 * below it rather than under either.
 */
const HEADROOM = 56;
