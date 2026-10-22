import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Plan } from "@/live/plan";
import { Plane } from "./Plane";

/*
 * What this guards is the reason the plane exists.
 *
 * The arrangement used to be expressed by which component a tile was rendered
 * inside — a grid in one mode, a stage and a filmstrip in the other — so moving
 * between them replaced one tree with the other and React destroyed every video
 * element on the way. A video element that unmounts drops its subscription with
 * it, so putting somebody on the stage stopped their stream, started it again,
 * and showed nothing until a keyframe arrived. That wait was the black screen.
 *
 * Nothing about the fix is visible in a rendered page: the same pictures appear
 * either way, in the same places, and only their history differs. So what is
 * asserted here is the history — that a picture is mounted once and stays
 * mounted through every rearrangement that follows.
 */

/** A tile that says every time it is built. */
function Counted({ onMount }: { onMount: () => void }) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: counting mounts is the point
	useEffect(() => onMount(), []);
	return <span>tile</span>;
}

const GRID: Plan = new Map([
	["a", { x: 0, y: 0, width: 320, height: 180 }],
	["b", { x: 328, y: 0, width: 320, height: 180 }],
]);

const FOCUS: Plan = new Map([
	["a", { x: 8, y: 8, width: 960, height: 540 }],
	["b", { x: 8, y: 560, width: 199, height: 112 }],
]);

function planeOf(plan: Plan, mounted: Record<string, () => void>) {
	return (
		<Plane
			measure={() => {}}
			plan={plan}
			tiles={["a", "b"].map((id) => ({
				id,
				node: <Counted onMount={mounted[id]!} />,
			}))}
		/>
	);
}

describe("Plane", () => {
	it("keeps every picture through a change of arrangement", () => {
		const mounted = { a: vi.fn(), b: vi.fn() };
		const { rerender } = render(planeOf(GRID, mounted));

		expect(mounted.a).toHaveBeenCalledOnce();
		expect(mounted.b).toHaveBeenCalledOnce();

		// Grid to stage, stage back to grid, and once more: the arrangement that
		// used to cost a rebuild each way round.
		rerender(planeOf(FOCUS, mounted));
		rerender(planeOf(GRID, mounted));
		rerender(planeOf(FOCUS, mounted));

		expect(mounted.a).toHaveBeenCalledOnce();
		expect(mounted.b).toHaveBeenCalledOnce();
	});

	it("keeps a picture the plan leaves out", () => {
		const mounted = { a: vi.fn(), b: vi.fn() };
		const onlyOne: Plan = new Map([["a", { x: 0, y: 0, width: 320, height: 180 }]]);

		const { rerender } = render(planeOf(GRID, mounted));
		rerender(planeOf(onlyOne, mounted));
		rerender(planeOf(GRID, mounted));

		// Out of sight is not out of the tree. Unmounting whoever paged away
		// would bring the black screen back for anybody returning to page one.
		expect(mounted.b).toHaveBeenCalledOnce();
	});

	it("takes its position from the plan", () => {
		const mounted = { a: vi.fn(), b: vi.fn() };
		const { container } = render(planeOf(GRID, mounted));

		const placed = container.querySelectorAll<HTMLElement>("[style]");
		const first = [...placed].find((element) => element.style.width === "320px");

		expect(first?.style.left).toBe("0px");
		expect(first?.style.height).toBe("180px");
	});

	it("hides whoever has nowhere to be, without removing them", () => {
		const mounted = { a: vi.fn(), b: vi.fn() };
		const onlyOne: Plan = new Map([["a", { x: 0, y: 0, width: 320, height: 180 }]]);

		const { container } = render(planeOf(onlyOne, mounted));

		expect(screen.getAllByText("tile")).toHaveLength(2);
		expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
	});

	it("offers the pages only when there is more than one", () => {
		const mounted = { a: vi.fn(), b: vi.fn() };
		const { queryByLabelText, rerender } = render(planeOf(GRID, mounted));
		expect(queryByLabelText("Next page")).toBeNull();

		rerender(
			<Plane
				measure={() => {}}
				plan={GRID}
				page={0}
				pages={3}
				tiles={[{ id: "a", node: <span>tile</span> }]}
			/>,
		);
		expect(queryByLabelText("Next page")).not.toBeNull();
	});
});
