import { SteadyText } from "@/components/Steady";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/useT";
import { LOCALES, LOCALE_NAMES, locale, setLocale, subscribe } from "@/live/i18n";
import { Languages } from "lucide-react";
import { useSyncExternalStore } from "react";

/**
 * Which language the interface speaks.
 *
 * It belongs before the call rather than during it. Sitting among the
 * microphone and the camera it read as a third switch of the same kind, and it
 * is not one: those are pressed repeatedly while a call is happening, and this
 * is settled once, by somebody who has not started yet.
 *
 * The trigger says the current language in that language rather than showing a
 * globe. A globe is a guess about what the icon means; a word is the word.
 */
export function LanguagePicker() {
	const t = useT();
	const current = useSyncExternalStore(subscribe, locale, locale);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{/* The corner's one shape: outlined, thirty-two tall, forty-four
				    under a finger, like the account and sign-out beside it. */}
				<Button
					variant="outline"
					size="sm"
					aria-label={t("Language")}
					className="h-8 gap-1.5 rounded-[10px] px-2.5 font-normal text-[12.5px] text-fg-muted hover:text-fg pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:px-3"
				>
					<Languages className="size-3.5" />
					{/* The icon alone on a phone, where the name of the language was
					    what pushed the page's header past the edge: below 360 when
					    the corner's buttons were twenty-eight pixels, and below 420
					    now that a finger is given forty-four — at 375 the lobby's
					    corner ran into the fleet's count beside the name. The button
					    keeps its label for anybody not looking. */}
					{/* As wide as the widest of the names, so that choosing another
					    does not move the buttons beside it (Steady). */}
					<SteadyText texts={LOCALE_NAMES} className="max-[420px]:hidden" />
				</Button>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="end" side="bottom">
				{LOCALES.map((candidate) => (
					// Each is written in itself and never translated. This is the one
					// list read by somebody who may not read the language it is
					// currently displayed in.
					<DropdownMenuCheckboxItem
						key={candidate}
						checked={candidate === current}
						onCheckedChange={() => setLocale(candidate)}
					>
						{LOCALE_NAMES[candidate]}
					</DropdownMenuCheckboxItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
