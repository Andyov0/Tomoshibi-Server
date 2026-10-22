import { Phrased } from "@/hooks/useT";
import { type Phrase, locale } from "@/live/i18n";
import { Laptop, type LucideIcon, Monitor, TabletSmartphone } from "lucide-react";

/**
 * What the two places that offer the apps share: the download page behind an
 * account (account/Apps.tsx) and the page an invitation opens in a browser
 * (routes/Landing.tsx).
 *
 * Here rather than in either, so that the two cannot come to say different
 * things about the same build — one telling somebody to drag the app into
 * Applications and the other forgetting to, or one warning about Play Protect
 * and the other leaving the warning to read as the app being dangerous. The
 * server's description of a build, the words around each platform's download,
 * and the way a version and a size are written are each said once.
 */

/** One platform's newest build, as the server describes it. */
export interface Build {
	available: boolean;
	version?: string;
	size?: number;
}

/**
 * How the iOS app is offered: by invitation to an address, which is for an
 * account, or by the beta's public link, which is for whoever cannot be
 * invited that way (internal/app/apps.go).
 */
export interface IOSOffer {
	invites: boolean;
	left: number;
	link?: string;
}

/** What the server says is offered, everywhere it is asked. */
export interface Offered {
	mac: Build;
	android: Build;
	windows: Build;
	ios: IOSOffer;
}

/** What is drawn for a server that said nothing usable. */
export const NOTHING: Offered = {
	mac: { available: false },
	android: { available: false },
	windows: { available: false },
	ios: { invites: false, left: 0 },
};

/*
 * The platforms' own names, which are not translated in any language these
 * pages speak: Apple, Microsoft and Google spell them the same everywhere.
 */
export const MAC_OS = "macOS";
export const I_OS = "iOS";
export const WINDOWS = "Windows";
export const ANDROID = "Android";

/** A size in megabytes, the way Finder counts them, in the reader's language. */
export function sizeSaid(bytes: number): string {
	return new Intl.NumberFormat(locale(), {
		style: "unit",
		unit: "megabyte",
		unitDisplay: "short",
		maximumFractionDigits: 1,
	}).format(bytes / 1_000_000);
}

/**
 * What tells the apps handed over as files apart. Everything else about them
 * is one card and one row on the download page, and one offer on the
 * invitation's page, each told which of these they are for.
 */
export interface Shelf {
	icon: LucideIcon;
	name: string;
	/** Where the server hands the build over. */
	href: string;
	/** The card's line where there is no build to describe. */
	meant: Phrase;
	/** The card's button. */
	take: Phrase;
	/** The one thing to know about installing it, under the button. */
	install: Phrase;
	/** A warning the system may show on the way, said before it does, where there is one. */
	caution?: Phrase;
	/** What the card and the row say where there is no build. */
	missing: Phrase;
}

export const MAC: Shelf = {
	icon: Laptop,
	name: MAC_OS,
	href: "/api/apps/mac",
	meant: "For your Mac.",
	take: "Download for Mac",
	install: "Open the disk image, then drag Tomoshibi into Applications.",
	missing: "The Mac app is not available yet.",
};

/*
 * Android installs a package from outside the Play Store only once somebody
 * has allowed the app it came from, here the browser, to install apps; the
 * line under the button says so before Android asks, so that the question
 * reads as expected rather than as a warning. The version it names is the
 * oldest the app is built for.
 */
export const ANDROID_APP: Shelf = {
	icon: TabletSmartphone,
	name: ANDROID,
	href: "/api/apps/android",
	meant: "For Android 10 or later.",
	take: "Download for Android",
	install: "Open the downloaded file, and when asked, allow installing apps from your browser. Needs Android 10 or later.",
	/*
	 * And then Play Protect, which on the owner's Fold6 said "App blocked to
	 * protect your device" because it "hasn't seen an app from this developer
	 * before" (2026-10-19): a reputation it has not built yet, with "Install
	 * anyway" under it. Said here first, in its own words, so that somebody
	 * reads the warning as the step they were told about rather than as the
	 * app being dangerous.
	 */
	caution: "If Google Play Protect says it hasn't seen an app from this developer before, tap Install anyway.",
	missing: "The Android app is not available yet.",
};

/*
 * Windows is an installer that is not signed: the owner decided against a
 * code-signing certificate (2026-10-21), so people are to press past the
 * warnings themselves. Two of them, in the order they come. The browser may
 * hold the download back as a file it has not seen often ("isn't commonly
 * downloaded", as Edge puts it, and Chrome much the same), and SmartScreen
 * stops the first run with "Windows protected your PC", whose way on is
 * hidden behind More info. Both are named in their own words before they
 * appear, as Play Protect's is on Android, because a blue full-screen warning
 * nobody mentioned reads as the app being malware, and the one button it
 * shows at first is Don't run.
 *
 * One installer for both kinds of PC, which picks the build for the machine
 * it runs on, so the page asks nothing about the processor, which a browser
 * on an ARM PC mostly reports as x64 anyway. The version named is the oldest
 * the app is built for, Windows 10 2004 (build 19041).
 *
 * Without a build the download page draws Windows as a place kept for it,
 * and the invitation's page says it is coming (account/Apps.tsx,
 * routes/Landing.tsx), so the two lines below for that case are the
 * coming-soon phrases those already use, rather than sentences translated
 * four times for a card nobody is shown.
 */
export const WINDOWS_APP: Shelf = {
	icon: Monitor,
	name: WINDOWS,
	href: "/api/apps/windows",
	meant: "Coming soon",
	take: "Download for Windows",
	install: "One installer for both x64 and ARM PCs. Needs Windows 10 version 2004 or later, or Windows 11.",
	caution:
		"If your browser says the file isn't commonly downloaded, choose Keep. The first time you run it, if Windows says it protected your PC, choose More info, then Run anyway.",
	missing: "The Windows app is coming soon.",
};

/** A build's version and size, the way every place that offers it says them. */
export function Figures({ build }: { build: Build }) {
	return (
		<>
			{/* The figures in the face machine-made things are set in, and the
			    word around them in the reader's language. Each half kept whole,
			    so a narrow row breaks at the dot rather than between a number
			    and its unit: at 375 in English the size wrapped as "24.1" over
			    "MB". */}
			<span className="whitespace-nowrap">
				<Phrased phrase="Version {version}" values={{ version: <span className="readout">{build.version}</span> }} />
			</span>
			{build.size ? (
				<>
					{" · "}
					<span className="readout whitespace-nowrap">{sizeSaid(build.size)}</span>
				</>
			) : null}
		</>
	);
}

/** Whether a build is there to download, by what the server said of it. */
export function offers(build: Build): boolean {
	return build.available && build.version !== undefined;
}
