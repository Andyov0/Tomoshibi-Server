import { Button } from "@/components/ui/button";
import { useMeasure } from "@/hooks/useMeasure";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Plan } from "@/live/plan";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The one place a picture is ever rendered.
 *
 * Every participant's tile is mounted here for as long as they are in the room,
 * whatever the arrangement is doing. Where a tile sits, how large it is, and
 * whether it is on screen at all are read from the plan and applied as style —
 * so changing the arrangement moves elements rather than replacing them.
 *
 * That distinction is the whole reason this exists. A video element that
 * unmounts drops its subscription with it, and a subscription that has to be
 * made again stops the stream, starts it, and waits for a keyframe before
 * anything is visible. Putting somebody on the stage used to cost exactly that:
 * a black picture, for as long as the keyframe took.
 *
 * Whoever the plan leaves out is not removed. It is moved out of sight, which
 * costs nothing worth saving — an element out of the viewport does not
 * intersect it, and a track nobody is looking at is dropped by the subscription
 * that follows visibility.
 */
export function Plane({
	tiles,
	plan,
	page,
	pages,
	onNext,
	onPrevious,
	measure,
}: {
	/** Everybody, in a stable order, each with the id the plan refers to. */
	tiles: { id: string; node: ReactNode }[];
	plan: Plan;
	page?: number;
	pages?: number;
	onNext?: () => void;
	onPrevious?: () => void;
	/** Handed the element whose size the plan was made for. */
	measure: ReturnType<typeof useMeasure>[0];
}) {
	const t = useT();
	const paged = (pages ?? 1) > 1;

	return (
		<div ref={measure} className="relative h-full w-full overflow-hidden">
			{tiles.map(({ id, node }) => {
				const spot = plan.get(id);

				return (
					<div
						key={id}
						// Absolute, so a tile owes its position to the plan alone and
						// nothing above it can reflow the rest by growing.
						className={cn(
							"absolute",
							// Sizes and positions are animated rather than the tile
							// being drawn straight into its new place: a room that
							// rearranges itself is legible, and one that jumps reads
							// as a glitch. Composited properties are not available
							// here — a picture scaled into place is a picture
							// distorted on the way — so the honest four are used, and
							// there are never more than a handful of them moving.
							"transition-[left,top,width,height] duration-300 ease-[cubic-bezier(0.2,0.9,0.3,1)]",
							"motion-reduce:transition-none",
							// Out of sight rather than out of the tree. `hidden` would
							// be simpler and would also drop the element out of the
							// transition, so it would reappear by jumping.
							!spot && "pointer-events-none opacity-0",
						)}
						style={
							spot
								? { left: spot.x, top: spot.y, width: spot.width, height: spot.height }
								: // Parked off the bottom edge at the size it last had
									// no business keeping. Zero would collapse it, and a
									// collapsed video element reports no dimensions to
									// the subscription that reads them.
									{ left: 0, top: "100%", width: 320, height: 180 }
						}
						aria-hidden={spot ? undefined : true}
					>
						{node}
					</div>
				);
			})}

			{paged && (
				<>
					<PageButton side="left" onClick={onPrevious} label={t("Previous page")}>
						<ChevronLeft />
					</PageButton>
					<PageButton side="right" onClick={onNext} label={t("Next page")}>
						<ChevronRight />
					</PageButton>

					{/*
					 * At the top rather than the bottom, and that is not a
					 * preference.
					 *
					 * It was centred at the bottom, which is exactly where the
					 * control island is — same centring, lower down, wider, and
					 * z-20 against nothing. So the only thing on the screen saying
					 * which page somebody is on was underneath the controls on
					 * every size, from the moment there were enough people to have
					 * a second page. The arrows either side loop, so there is no
					 * other way to tell.
					 */}
					<div className="-translate-x-1/2 absolute top-3 left-1/2 rounded-full bg-black/50 px-2.5 py-1 text-white/80 text-xs">
						{(page ?? 0) + 1} / {pages}
					</div>
				</>
			)}
		</div>
	);
}

function PageButton({
	side,
	onClick,
	label,
	children,
}: {
	side: "left" | "right";
	onClick?: () => void;
	label: string;
	children: ReactNode;
}) {
	return (
		<Button
			variant="secondary"
			size="icon"
			aria-label={label}
			onClick={onClick}
			className={cn(
				"-translate-y-1/2 absolute top-1/2 z-10 rounded-full opacity-60 hover:opacity-100",
				side === "left" ? "left-3" : "right-3",
			)}
		>
			{children}
		</Button>
	);
}
