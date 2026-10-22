import { AppWindow, CircleHelp, Globe, Laptop, Monitor, Smartphone, Tablet } from "lucide-react";
import { useT } from "@/hooks/useT";
import { cn } from "@/lib/utils";
import type { Client } from "./api";

/**
 * What somebody joined from: a browser and the system under it, or one of
 * the apps, its version and the model.
 *
 * The first thing an operator asks somebody whose call is not working, and
 * until the join wrote it down nothing on this page could answer it: the
 * media server knows the SDK, not whether that is an iPhone app or Chrome on
 * Windows. The user agent as sent is the title, for whatever the summary did
 * not catch, and it is only what the request said.
 *
 * Nothing at all for a join recorded before this was kept, rather than a
 * dash: a blank says nothing was written down, and a dash reads as a value.
 */
export function Device({ client, className }: { client?: Client; className?: string }) {
	const t = useT();

	if (!client) return null;

	// The browsers somebody here would call by another name. The rest are
	// names everywhere.
	const browsers: Record<string, string> = {
		WeChat: t("WeChat"),
		"QQ Browser": t("QQ Browser"),
		"UC Browser": t("UC Browser"),
		"Samsung Internet": t("Samsung Internet"),
	};

	const apps: Record<string, [string, typeof Smartphone]> = {
		iphone: [t("iPhone app"), Smartphone],
		ipad: [t("iPad app"), Tablet],
		mac: [t("Mac app"), Laptop],
		android: [t("Android app"), Smartphone],
		windows: [t("Windows app"), Monitor],
	};

	let label: string;
	let Icon = CircleHelp;
	const details: string[] = [];

	if (client.kind === "web") {
		Icon = Globe;
		// "Chrome 155" is the browser and its major version.
		const split = (client.browser ?? "").match(/^(.*?)(?: (\d+))?$/);
		const name = split?.[1] ?? "";
		label = [browsers[name] ?? name, split?.[2]].filter(Boolean).join(" ") || t("Something else");
		if (client.system) details.push(client.system);
	} else if (client.kind in apps) {
		const [named, drawn] = apps[client.kind] as [string, typeof Smartphone];
		label = named;
		Icon = drawn;
		if (client.app) label = `${label} ${client.app}`;
		for (const one of [client.system, client.device]) if (one) details.push(one);
	} else if (client.kind === "app") {
		Icon = AppWindow;
		label = client.app ? `${t("An older app that did not say which")} ${client.app}` : t("An older app that did not say which");
		if (client.system) details.push(client.system);
	} else {
		label = t("Something else");
	}

	// Two lines rather than one cut short: what it is, then the system and
	// the model. On one line the history's column cut an Android phone off at
	// "Android 16 · sa…", which is the half an operator was looking for.
	return (
		<span className={cn("flex min-w-0 items-start gap-1", className)} title={client.agent}>
			<Icon className="mt-[0.2em] size-3 shrink-0" />
			<span className="min-w-0">
				<span className="block break-words">{label}</span>
				{/* Each part kept whole, so a model name breaks between the
				    system and itself rather than at its own hyphen. */}
				{details.length > 0 && (
					<span className="block opacity-70">
						{details.map((part, i) => (
							<span key={part}>
								{i > 0 && " · "}
								<span className="whitespace-nowrap">{part}</span>
							</span>
						))}
					</span>
				)}
			</span>
		</span>
	);
}
