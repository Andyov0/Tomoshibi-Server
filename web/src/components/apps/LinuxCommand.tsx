import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/useT";
import { actionFailed } from "@/live/notices";

/**
 * The Linux app in one command, for somebody who does not know which of the
 * two downloads above is theirs: the script it runs (internal/app/linux.sh)
 * checks the machine has a desktop, picks the build for its processor, checks
 * it and adds it to the desktop's apps.
 *
 * The address is the page's own origin, never one assembled here, so that the
 * command fetches from the deployment the reader is looking at, behind
 * whatever path or port it is served on. Written with curl: it is on every
 * desktop the app runs on, and the script falls back to wget for its own
 * requests where curl is missing.
 *
 * Wrapped rather than scrolled sideways, like the relay's command on the
 * management pages: a command that runs off the edge gets copied in half by
 * anybody selecting it by hand.
 */
export function linuxCommand(origin: string): string {
	return `curl -fsSL ${origin}/linux.sh | sh`;
}

export function LinuxCommand({ origin = window.location.origin }: { origin?: string }) {
	const t = useT();
	const command = linuxCommand(origin);
	const [copied, setCopied] = useState(false);

	// Back to "Copy" after a moment; nothing scheduled into an unmounted row.
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 2000);
		return () => clearTimeout(timer);
	}, [copied]);

	return (
		<div className="flex w-full flex-col gap-2">
			<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">
				{t("Not sure which one? Paste this into a terminal:")}
			</p>
			<div className="flex items-start gap-2">
				<pre className="readout min-w-0 flex-1 whitespace-pre-wrap break-all rounded-[10px] border border-border bg-bg px-3 py-2 text-[12px] leading-relaxed">
					<code>{command}</code>
				</pre>
				<Button
					variant="secondary"
					size="sm"
					className="shrink-0"
					aria-label={copied ? t("Copied") : t("Copy")}
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(command);
							setCopied(true);
						} catch {
							actionFailed(t("Could not copy. Select the text and copy it."));
						}
					}}
				>
					{copied ? <Check /> : <Copy />}
					{copied ? t("Copied") : t("Copy")}
				</Button>
			</div>
			<p className="text-pretty text-[11.5px] text-fg-muted leading-snug">
				{t("It picks x86-64 or ARM64 by itself, checks that this computer has a desktop, and adds Tomoshibi to your apps.")}
			</p>
		</div>
	);
}
