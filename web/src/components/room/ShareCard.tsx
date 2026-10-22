import { useT } from "@/hooks/useT";
import { MonitorUp } from "lucide-react";
import { Tile } from "./Tile";

/**
 * Stands in for a screen share that is not on the stage.
 *
 * A 1080p desktop scaled into a grid cell is unreadable, so subscribing to it
 * would spend the bandwidth and deliver nothing. The card says who is sharing
 * and takes the click that makes it big.
 *
 * The whole card is the target rather than a button inside it. A button would
 * sit on a surface that already responds to a click, so the two would fire
 * together, and the smaller target is the worse one anyway.
 */
export function ShareCard({
	label,
	silenced,
	onOpen,
}: {
	label: string;
	/**
	 * The sound is silenced, though the card is not what silenced it.
	 *
	 * Worth the mark here more than anywhere: a share that is not on the stage
	 * is a card rather than a picture, and its sound has been playing all along
	 * regardless — so this is the one place somebody can be looking straight at
	 * a share and hear nothing with no idea why.
	 */
	silenced?: boolean;
	onOpen: () => void;
}) {
	const t = useT();
	return (
		<Tile label={label} silenced={silenced} onSelect={onOpen}>
			<div className="absolute inset-0 grid place-items-center bg-surface-hi/40">
				<div className="flex flex-col items-center gap-2 px-4 text-center">
					<MonitorUp className="size-8 text-fg-muted" />
					<p className="text-fg-muted text-sm">{t("{name} is sharing", { name: label })}</p>
					<p className="text-fg-muted/70 text-xs">{t("Watch")}</p>
				</div>
			</div>
		</Tile>
	);
}
