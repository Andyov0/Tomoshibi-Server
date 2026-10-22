import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import { useLingering } from "@/hooks/useLingering";
import { possible } from "@/live/secrecy";
import { Lock } from "lucide-react";
import { useState } from "react";

/**
 * A word that makes the relay unable to read the call.
 *
 * Folded away, because it is not a question most people should be asked. A call
 * held on a machine somebody rents is exactly as private as that machine, which
 * is the ordinary bargain and is the one this deployment made until now; anybody
 * who does not open this has the call they always had.
 *
 * Opened, it is one field and one sentence. There is nothing to configure: the
 * word and the room name make the key, everybody who types the same word can
 * hear each other, and anybody who does not cannot.
 *
 * Absent where the browser cannot do it. Safari has no insertable streams and
 * Firefox's support is partial, so a field offered there would be a promise the
 * page cannot keep — and a promise about who can read a conversation is the
 * worst kind to break quietly.
 */
export function Sealed({ value, onChange }: { value: string; onChange: (word: string) => void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { mounted, leaving } = useLingering(open);

	if (!possible()) return null;

	return (
		<div className="flex flex-col gap-2">
			<button
				type="button"
				onClick={() => setOpen((was) => !was)}
				aria-expanded={open}
				className={cn(
					"flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[11px]",
					"text-fg-muted transition-colors hover:bg-surface-hi hover:text-fg",
					value && "text-tally",
				)}
			>
				<Lock className="size-3" />
				{value ? t("This call is sealed") : t("Seal this call")}
			</button>

			{mounted && (
				<div className={cn("flex flex-col gap-1.5", leaving ? "animate-depart" : "animate-arrive")}>
					<input
						type="password"
						value={value}
						onChange={(event) => onChange(event.target.value)}
						aria-label={t("Sealing word")}
						placeholder={t("Sealing word")}
						// Not the browser's password manager. It remembers per site,
						// and this belongs to one meeting and the people in it —
						// offering to save it would put it somewhere the passphrase
						// deliberately is and this deliberately is not.
						autoComplete="off"
						maxLength={128}
						className={cn(
							"w-full rounded-md border border-border bg-surface-hi px-2.5 py-1.5",
							"text-sm outline-none focus-visible:ring-2 focus-visible:ring-fg/40",
						)}
					/>

					<p className="text-fg-muted text-xs leading-snug">
						{t(
							"Everybody who types the same word can hear each other, and the server carrying the call cannot. Tell people the word some other way.",
						)}
					</p>
				</div>
			)}
		</div>
	);
}
