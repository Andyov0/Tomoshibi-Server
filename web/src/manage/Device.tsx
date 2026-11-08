import { AppWindow, CircleHelp, Computer, Globe, Laptop, Monitor, Smartphone, Tablet } from "lucide-react";
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

	const { label, details, Icon } = described(client, t);

	// Two lines rather than one cut short: what it is, then the system and
	// the model. On one line the history's column cut an Android phone off at
	// "Android 16 · sa…", which is the half an operator was looking for.
	return (
		<span className={cn("flex min-w-0 items-start gap-1", className)} title={client.agent}>
			<Icon className="mt-[0.2em] size-3 shrink-0" />
			<span className="min-w-0">
				<span className="block break-words">{label}</span>
				{/* Each part kept whole where it fits on a line, so a model name
				    breaks between the system and itself rather than at its own
				    hyphen; and broken inside only where it is longer than the
				    line, as DeviceLine's are, for the reason given there. */}
				{details.length > 0 && (
					<span className="block opacity-70">
						{details.map((part, i) => (
							<span key={part}>
								{i > 0 && " · "}
								<span className="inline-block max-w-full break-words align-top">{part}</span>
							</span>
						))}
					</span>
				)}
			</span>
		</span>
	);
}

/**
 * The same, on one line: the icon, what it is, and the system and model
 * after it in a quieter weight, for a row that already has a line above it.
 * The parts sit apart by a gap rather than a dot between them, so the line
 * wraps between them on a phone rather than inside one.
 *
 * Inside one only where that part is longer than the whole line. Each part
 * was held to one line, which suited an iPhone17,1 and clipped the Linux
 * app's machine, the firmware's maker and product with the processor last:
 * at 375 the list of lockouts and the log page showed "Parallels
 * International GmbH. Parallels ARM Virtual" and nothing after it, the
 * processor being what decides which build somebody needs. A part that fits
 * is still moved whole to the next line, since a wrapping row places each
 * part by its whole width; only one wider than the row is let shrink and
 * break between its words.
 */
export function DeviceLine({ client, className }: { client: Client; className?: string }) {
	const t = useT();

	const { label, details, Icon } = described(client, t);

	return (
		<span className={cn("flex min-w-0 flex-wrap items-center gap-x-2", className)} title={client.agent}>
			<span className="flex items-center gap-1.5 whitespace-nowrap text-fg">
				<Icon className="size-3.5 shrink-0 text-fg-muted" />
				{label}
			</span>
			{details.map((part) => (
				<span key={part} className="min-w-0 max-w-full break-words">
					{part}
				</span>
			))}
		</span>
	);
}

/** What a client is called, what is said under it, and its icon. */
export function described(client: Client, t: ReturnType<typeof useT>): { label: string; details: string[]; Icon: typeof Smartphone } {

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
		linux: [t("Linux app"), Computer],
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

	return { label, details, Icon };
}
