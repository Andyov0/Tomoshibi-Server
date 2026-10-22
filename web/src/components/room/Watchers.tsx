import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Participant } from "livekit-client";
import { Eye } from "lucide-react";

/**
 * Who is looking at the screen being shared.
 *
 * Somebody sharing their screen is doing it blind. They can see that eleven
 * people are in the call and not whether any of them has the picture in front of
 * them, and the two are genuinely different: a share sitting unopened in the
 * strip is a share nobody is watching. What that costs is small and constant —
 * pausing to ask "can you all see this?" — and it is asked because there is
 * nowhere to look.
 *
 * Beside the picture rather than over it. A share is being pointed at, and a
 * panel across the corner of it covers whatever was there.
 *
 * The list is what people say, not what the server knows: the media server tells
 * a publisher nothing about who subscribed, so each viewer announces the share
 * they have open. Somebody with the picture up and their attention elsewhere
 * counts, which is the honest limit of the question and worth knowing when
 * reading it.
 */
export function Watchers({ watchers }: { watchers: Participant[] }) {
	const t = useT();

	return (
		<aside
			className={cn(
				"pointer-events-auto flex max-h-full w-40 shrink-0 flex-col gap-1 overflow-hidden",
				"rounded-lg border border-border bg-surface/90 p-2 backdrop-blur",
			)}
		>
			<h2 className="flex items-center gap-1.5 px-0.5 text-[11px] text-fg-muted">
				<Eye className="size-3" />
				{t("Watching")}
				<span className="ml-auto tabular-nums">{watchers.length}</span>
			</h2>

			{watchers.length === 0 ? (
				/*
				 * Said rather than left blank. An empty box beside a share reads
				 * as something that has not loaded; the useful reading is that
				 * the share is up and nobody has opened it, which is a thing the
				 * person sharing would want to act on.
				 */
				<p className="px-0.5 text-[11px] text-fg-muted/70 leading-snug">
					{t("Nobody has this open yet.")}
				</p>
			) : (
				<ul className="flex flex-col gap-0.5 overflow-y-auto">
					{watchers.map((one) => (
						<li
							key={one.identity}
							className="truncate rounded px-1 py-0.5 text-[12px] text-fg"
							title={one.name || one.identity}
						>
							{one.name || one.identity}
						</li>
					))}
				</ul>
			)}
		</aside>
	);
}
