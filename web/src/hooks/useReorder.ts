import {
	type PointerEvent as Pointing,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * Picking a row up and putting it down somewhere else.
 *
 * Pointer events rather than a drag-and-drop library, and rather than the
 * browser's own drag events.
 *
 * A library is the obvious answer and is a great deal of package for one list.
 * What a fleet of eleven relays needs is a target index and one call to save
 * it; the rest of what such a library brings — sensors, collision strategies,
 * sortable contexts, a second copy of the list kept in its own store — is
 * machinery for problems this page does not have, and it would arrive with
 * every one of them installed on everybody who clones this.
 *
 * The browser's own drag events are not an option at all: `dragstart` never
 * fires from a finger, so an interface built on them works everywhere except
 * the device somebody reorders a list on while standing up.
 *
 * A pointer is a mouse, a finger and a pen at once, which is the whole reason
 * the API exists, and it is captured so the row keeps following even when the
 * pointer leaves the narrow handle it was taken by. Anybody who has dragged
 * something and had it stop halfway because their finger strayed off the target
 * has met the version without capture.
 *
 * Nothing is saved until the drop. The rows move as the pointer moves, but the
 * order that reaches the server is the one somebody let go of: saving each
 * intermediate position would write a dozen orders nobody chose, and on a list
 * two administrators can both see, every one of them is an order the other one
 * watches the page jump into.
 */

/** Where a row sits, as the list stood at the moment one was picked up. */
export interface Placed {
	top: number;
	height: number;
}

/**
 * Which position the carried row is being held over.
 *
 * Measured against the gaps the shortened list has rather than against the
 * midpoints of the other rows. The midpoint version reads as obviously right
 * and is wrong the moment two rows differ in height — a tall row's midpoint is
 * nowhere near the place the carried row would land beside it, so dragging a
 * short row over a tall one swapped them a good deal later than the pointer
 * said. These rows are cards that grow when their settings are opened, so that
 * is the ordinary case here and not an edge of one.
 */
export function landing(rows: Placed[], from: number, dy: number, gap: number): number {
	const carried = rows[from];
	if (!carried) return from;

	const middle = carried.top + carried.height / 2 + dy;

	let top = rows[0]?.top ?? 0;
	let nearest = Number.POSITIVE_INFINITY;
	let best = 0;

	for (let slot = 0; slot < rows.length; slot++) {
		const away = Math.abs(middle - (top + carried.height / 2));

		if (away < nearest) {
			nearest = away;
			best = slot;
		}

		// The row that would sit in this slot if the carried one were not in the
		// list at all, which is what the remaining rows close up into.
		const next = rows[slot < from ? slot : slot + 1];
		if (next) top += next.height + gap;
	}

	return best;
}

/**
 * How far a row that is not being carried stands aside.
 *
 * Every row between where the carried one came from and where it is being held
 * moves by exactly one place; nothing else moves at all. Drawn as a transform
 * rather than by reordering the list under the pointer, because the list is
 * what the drop is computed against — reordering it mid-drag would mean the
 * measurements taken at the start describing a list that no longer exists.
 */
export function aside(rows: Placed[], from: number, to: number, gap: number, index: number): number {
	const carried = rows[from];
	if (!carried || index === from) return 0;

	const span = carried.height + gap;
	// Where this row stands once the carried one is lifted out of the list.
	const place = index < from ? index : index - 1;

	if (index < from) return place >= to ? span : 0;

	return place < to ? -span : 0;
}

/** A drag in progress, as the rows need to draw it. */
interface Carry {
	from: number;
	to: number;
	dy: number;
}

interface Held extends Carry {
	rows: Placed[];
	gap: number;
	/** Where the pointer was when the row was taken. */
	start: number;
	/** The list as it stood then, so a drop onto a list that changed can be refused. */
	order: string[];
}

export interface Reorder {
	/** Goes on the element whose children are the rows. */
	list: RefObject<HTMLDivElement>;
	/** The row being carried, by index, or nothing when the list is at rest. */
	carrying?: number;
	/** Begins a drag. Goes on the handle, which is what says a row can be moved. */
	take: (index: number) => (event: Pointing<HTMLElement>) => void;
	/** How far to draw the row at this index from where the page laid it out. */
	shift: (index: number) => number;
}

export function useReorder({
	order,
	onSettle,
}: {
	order: string[];
	onSettle: (order: string[]) => void;
}): Reorder {
	const list = useRef<HTMLDivElement>(null);
	const held = useRef<Held>(undefined);
	const [carry, setCarry] = useState<Carry>();

	// Read at the drop rather than closed over at the pointer down, so that a
	// list which changed while somebody was dragging is noticed instead of
	// being overwritten with an order describing relays that have gone.
	const now = useRef(order);
	now.current = order;

	const settle = useRef(onSettle);
	settle.current = onSettle;

	const take = useCallback(
		(from: number) => (event: Pointing<HTMLElement>) => {
			// Anything but the primary button is somebody opening a context menu
			// on the handle, which is not a drag and must not swallow the menu.
			if (event.button !== 0) return;

			// Offsets rather than bounding rectangles, because the panel behind
			// this list scrolls: a rectangle read when the row was taken and
			// compared against the page after a scroll describes rows that have
			// all moved, when what moved was the window.
			const rows = [...(list.current?.children ?? [])].map((row) => ({
				top: (row as HTMLElement).offsetTop,
				height: (row as HTMLElement).offsetHeight,
			}));

			// The rows on screen and the list they are drawn from, disagreeing.
			// Nothing good can be computed from that, and a drag begun on it
			// would end in a saved order.
			if (rows.length !== now.current.length || !rows[from]) return;

			const first = rows[0];
			const second = rows[1];
			const gap = first && second ? second.top - (first.top + first.height) : 0;

			held.current = {
				rows,
				gap,
				from,
				to: from,
				dy: 0,
				start: event.clientY,
				order: now.current,
			};
			setCarry({ from, to: from, dy: 0 });

			event.currentTarget.setPointerCapture(event.pointerId);
			// Or the handle is dragged as though it were a link, and the row
			// underneath is selected as text on the way past.
			event.preventDefault();
		},
		[],
	);

	// Subscribed on the window rather than on the handle, so that a pointer
	// released outside the page still ends the drag. The dependency is whether
	// anything is being carried and not the carry itself: the position changes
	// on every frame of a drag, and listeners torn down and rebuilt that often
	// miss the events raised in between.
	const carrying = carry !== undefined;

	useEffect(() => {
		if (!carrying) return;

		const move = (event: PointerEvent) => {
			const drag = held.current;
			if (!drag) return;

			const dy = event.clientY - drag.start;
			const to = landing(drag.rows, drag.from, dy, drag.gap);

			drag.dy = dy;
			drag.to = to;

			setCarry({ from: drag.from, to, dy });
		};

		const drop = () => {
			const drag = held.current;

			held.current = undefined;
			setCarry(undefined);

			if (!drag || drag.to === drag.from) return;

			// A relay added or removed by somebody else while this drag was in
			// the air. The order in hand describes a list that no longer exists,
			// and saving it would put a machine somewhere nobody asked for.
			const unchanged =
				drag.order.length === now.current.length &&
				drag.order.every((name, at) => name === now.current[at]);

			if (!unchanged) return;

			const moved = [...drag.order];
			const [row] = moved.splice(drag.from, 1);
			if (row === undefined) return;
			moved.splice(drag.to, 0, row);

			settle.current(moved);
		};

		// Put back where it came from, saving nothing.
		//
		// What a cancelled pointer means is that the gesture was taken away
		// rather than finished — the system claimed it for something of its own,
		// or the touch was interrupted — so there is no drop to honour. Treating
		// one as a drop saves an order nobody let go of.
		const abandon = () => {
			held.current = undefined;
			setCarry(undefined);
		};

		// And an escape hatch for a drag somebody has thought better of halfway
		// through, because otherwise the only way out of one is to complete it.
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") abandon();
		};

		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", drop);
		window.addEventListener("pointercancel", abandon);
		window.addEventListener("keydown", escape);

		return () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", drop);
			window.removeEventListener("pointercancel", abandon);
			window.removeEventListener("keydown", escape);
		};
	}, [carrying]);

	const shift = useCallback(
		(index: number) => {
			const drag = held.current;
			if (!carry || !drag) return 0;

			if (index === carry.from) return carry.dy;

			return aside(drag.rows, carry.from, carry.to, drag.gap, index);
		},
		[carry],
	);

	return { list, carrying: carry?.from, take, shift };
}
