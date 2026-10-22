/**
 * Where the tiles go.
 *
 * The obvious approach is to divide the container into equal cells and let the
 * pictures stretch, which is what a plain CSS grid does. It produces tall thin
 * cells for two people on a wide screen, and a 16:9 picture in one of those is
 * mostly cropped away. What people expect instead, and what every meeting
 * application does, is pictures that keep their shape and sit centred with space
 * around them.
 *
 * So the arrangement is chosen rather than derived: every column count is tried
 * and the one giving each person the most space wins.
 */

/**
 * The shape a picture keeps, given by the caller.
 *
 * Not a constant any more. A phone films in the shape it is held in, and an
 * arrangement that only knows sixteen by nine crops a face standing upright to
 * a band across its eyes — while leaving most of the screen black around it.
 */
const DEFAULT_ASPECT = 16 / 9;

/**
 * How much of the container's height an arrangement may occupy.
 *
 * Without a ceiling one participant fills the window edge to edge, which reads
 * as a wall rather than a picture, and is the difference between this and the
 * layout it replaces. It also settles two people on a wide screen: side by side
 * and stacked are within a few per cent of each other by area, and the ceiling
 * is what tips it to the arrangement everybody already expects.
 */
const FILL = 0.92;

/** One way of laying the tiles out. */
export interface Arrangement {
	columns: number;
	rows: number;
	/** Pixels, already rounded for use as a style. */
	width: number;
	height: number;
}

/**
 * Choose an arrangement for `count` tiles in a container.
 *
 * Returns undefined when there is nothing to arrange or nowhere to put it,
 * which is the state on the first render before the container has been
 * measured.
 */
export function arrange(
	container: { width: number; height: number },
	count: number,
	gap = 8,
	aspect = DEFAULT_ASPECT,
): Arrangement | undefined {
	const { width, height } = container;
	if (count <= 0 || width <= 0 || height <= 0) return undefined;

	let best: Arrangement | undefined;
	let bestScore = 0;

	for (let columns = 1; columns <= count; columns++) {
		const rows = Math.ceil(count / columns);

		const cellWidth = (width - (columns - 1) * gap) / columns;
		const cellHeight = (height - (rows - 1) * gap) / rows;
		if (cellWidth <= 0 || cellHeight <= 0) continue;

		// Whichever dimension runs out first decides the size; the other keeps
		// the aspect ratio, and the slack becomes the space around the tiles.
		let tileWidth = Math.min(cellWidth, cellHeight * aspect);
		let tileHeight = tileWidth / aspect;

		// The ceiling exists to stop one person filling a wide window edge to
		// edge, which reads as a wall rather than a picture. Upright there is no
		// such danger — the screen is narrow and the picture is bounded by the
		// width long before it is by the height — and applying it there throws
		// away the height the arrangement was reshaped to use.
		const fill = container.height > container.width * 1.2 ? 1 : FILL;
		const ceiling = (height * fill - (rows - 1) * gap) / rows;
		if (tileHeight > ceiling) {
			tileHeight = ceiling;
			tileWidth = tileHeight * aspect;
		}

		// Empty cells hold space without showing anybody, so what is compared is
		// the area each person actually gets rather than the area of one cell.
		// That is what stops four people being spread over six cells when the
		// same tile size fits in four.
		const score = tileWidth * tileHeight * (count / (columns * rows));

		if (score > bestScore) {
			bestScore = score;
			best = {
				columns,
				rows,
				width: Math.floor(tileWidth),
				height: Math.floor(tileHeight),
			};
		}
	}

	return best;
}
