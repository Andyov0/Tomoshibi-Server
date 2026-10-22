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
				<Button variant="ghost" size="sm" aria-label={t("Language")} className="gap-1.5">
					<Languages className="size-3.5" />
					{/* The icon alone on the narrowest phones, where the name of
					    the language was what pushed the page's header past the
					    edge. The button keeps its label for anybody not looking. */}
					<span className="max-[360px]:hidden">{LOCALE_NAMES[current]}</span>
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
