/**
 * The step in front of the join screen for somebody who opened an invitation
 * or a meeting link in a browser: open the app if they have it, offer it if
 * they do not, and the browser either way.
 *
 * ## Why there is a step at all
 *
 * A link opens the app without asking only where the system has been told the
 * app may have it: Android once /.well-known/assetlinks.json names the app,
 * Apple's devices once /.well-known/apple-app-site-association does and the app
 * carries the domain. Everywhere else — a computer, a link pasted into the
 * address bar, a phone that was told once to keep links in the browser — the
 * link lands here, on the web client, and the app the person may have
 * installed, or would install if they knew it existed, is never mentioned.
 * Every meeting service has this page for that reason.
 *
 * ## What it does, and where
 *
 * It asks the app to open the link by its own scheme first, which on a Mac
 * Chrome and the browsers built on it turn into a question ("Open Tomoshibi?")
 * and on Android simply does — in Chrome, and in the Custom Tabs most apps
 * open links in, though not in an app's own WebView (see asksAtOnce). The
 * link the app is given is the deployment's own link with the scheme changed,
 * tomoshibi://<host>/?invite=T#/room — the form the apps read (AppModel.open
 * in the Apple apps, OpenedLink in the Android one, and the Windows app, which
 * its installer registers for the scheme: the scheme is put back to https and
 * the host, the query and the fragment are read as they would be from the
 * https link).
 *
 * Not on an iPhone or iPad without a press. Safari answers a scheme no app has
 * claimed with an alert saying the address is invalid, which is the first thing
 * everybody without the app would see — and everybody with it is mostly sent
 * straight to the app by the universal link before this page loads at all. So
 * there it is a button. And the same on a Mac in anything but Chrome and its
 * kin: Safari there is the same WebKit with the same alert ("Safari can't open
 * the page because macOS doesn't recognise Internet addresses starting with
 * tomoshibi:"), its universal links take the people who have the app, and it
 * is the browser a Mac comes with, so asking on arrival greeted most of the
 * people this page is for with an error. It went unseen because the step was
 * tried in Chrome told to say it was a Mac, and Chrome says nothing about a
 * scheme nobody claims.
 *
 * Nor on Windows, for the same reason. A scheme no app has registered is
 * answered there by Windows itself, with a dialog offering to look for an app
 * that opens the link, and by Firefox with an error in place of the page;
 * asked on arrival, that would be the first thing everybody without the app
 * saw. So there, too, it is a button, beside the download.
 *
 * Not inside WeChat, QQ and the other apps whose built-in browser will open no
 * app and download nothing: there the page says to open the link in the
 * browser, from the menu every one of them keeps at the top right.
 *
 * If the app has not taken over after two seconds — the page still showing,
 * still in front — it is offered: downloaded at once on a Mac, which is what
 * a computer is for and what every meeting service does; a button on a
 * phone, where a package of fifty-odd megabytes started by itself is a
 * surprise on somebody's mobile data, and Android asks before installing
 * anyway. And a button on Windows, though it is a computer (see
 * downloadsByItself).
 *
 * And joining in the browser is a press away throughout, never behind the
 * rest: the step is an offer, and a person who would rather not is one press
 * from the join screen they would have had without it.
 *
 * ## When it is not shown
 *
 * To somebody coming back: a reload while in a call, or a rejoin, goes straight
 * back in (doorway's rejoin), and a tab that has already been past this step
 * for this link does not see it again. To somebody who reached the link from
 * this deployment's own pages, who is in the browser by choice. Where there is
 * nothing to offer for the device — no build, no TestFlight link, a platform
 * with no app at all — because a page offering nothing is only a delay. And
 * never over a call, which App.tsx draws before anything else.
 */

import type { Offered } from "@/components/apps/shelves";
import { keepForTab, recallForTab } from "@/lib/storage";
import type { Platform } from "./platform";

/** A link somebody opened, as the address carried it. */
export interface Opened {
	kind: "invite" | "meeting";
	token: string;
}

/**
 * The link the page was opened with, read from the address and from nowhere
 * else.
 *
 * Not from what the tab kept. A token kept for the tab is one this page put
 * there itself, after the link had done its work — a join, a knock answered, a
 * meeting begun — and somebody holding only that is coming back rather than
 * arriving.
 */
export function opened(search = window.location.search): Opened | undefined {
	const query = new URLSearchParams(search);

	const invite = query.get("invite")?.trim();
	if (invite) return { kind: "invite", token: invite };

	const meeting = query.get("meeting")?.trim();
	if (meeting) return { kind: "meeting", token: meeting };

	return undefined;
}

/**
 * The link the app is asked to open: the deployment's own, under the app's
 * scheme. Built from the token rather than from the address, which by the time
 * anybody presses has had the meeting's token taken out of it (live/meeting.ts).
 */
export function appLink({ kind, token }: Opened, room: string, host = window.location.host): string {
	const fragment = room ? `#/${room}` : "";

	return `tomoshibi://${host}/?${kind}=${encodeURIComponent(token)}${fragment}`;
}

/**
 * Whether the page is inside an app's own browser that opens no app and
 * downloads nothing.
 *
 * By the names those apps put in their agents, which is the only thing they
 * say about themselves: WeChat and WeCom, QQ (as a word of its own, so that QQ
 * Browser, a real browser, is not taken for it), Weibo, DingTalk, Alipay,
 * Douyin, Feishu and Lark, and the Facebook, Instagram and LINE apps. A wrong
 * yes costs somebody a sentence asking them to open the link in their browser,
 * with the browser join beside it; a wrong no costs a button that does nothing,
 * or that replaces the page with an error a press on back undoes — never a
 * jump on arrival, which asksAtOnce does not make in any Android WebView — so
 * the list stops at the apps people actually send these links through.
 */
export function insideAnApp(userAgent = navigator.userAgent): boolean {
	return /MicroMessenger|wxwork|(?:^|[^A-Za-z])QQ\/\d|Weibo|DingTalk|AlipayClient|aweme|Lark\/|Feishu|FBAN|FBAV|Instagram|\bLine\//i.test(
		userAgent,
	);
}

/**
 * What this device can be offered, by what the server said is offered.
 *
 * The build for the device where there is one, and nothing for a platform
 * with no app. Windows without a build is the exception, and is offered a
 * sentence: its app is coming, and somebody on a computer who was told
 * nothing would not know to come back for it — but only on a deployment that
 * offers some app at all, or the sentence would be about a deployment that has
 * none.
 */
export type Offer =
	| { kind: "mac" }
	| { kind: "android" }
	| { kind: "windows" }
	| { kind: "ios-invite" }
	| { kind: "ios-link"; link: string }
	| { kind: "windows-soon" };

export function offerFor(device: Platform | undefined, offered: Offered): Offer | undefined {
	switch (device) {
		case "mac":
			return offered.mac.available ? { kind: "mac" } : undefined;
		case "android":
			return offered.android.available ? { kind: "android" } : undefined;
		case "windows":
			if (offered.windows.available) return { kind: "windows" };
			return offered.mac.available || offered.android.available || offered.ios.invites || offered.ios.link
				? { kind: "windows-soon" }
				: undefined;
		case "ios":
			if (offered.ios.invites) return { kind: "ios-invite" };
			return offered.ios.link ? { kind: "ios-link", link: offered.ios.link } : undefined;
		default:
			return undefined;
	}
}

/**
 * Whether the app is downloaded without a press once it has not taken over,
 * which is the Mac's alone.
 *
 * Windows is a computer as well, and was to be downloaded at once like the
 * Mac. It is not, because its installer is not signed: the browser may flag
 * it as a file it has not often seen, and SmartScreen stops it with a warning
 * of its own. A file somebody did not ask for, arriving with a warning that it
 * may be dangerous, reads as the page pushing something on them, and the line
 * that says what to press at each warning is on the page beside the button,
 * read before the press rather than after the file has landed. And since the
 * app is not asked on arrival there (see asksAtOnce), there are no two
 * seconds whose end the download could follow.
 */
export function downloadsByItself(kind: Offer["kind"] | undefined): boolean {
	return kind === "mac";
}

/**
 * Whether the app is asked to open the link the moment the page arrives:
 * where there is an app that could, and nothing would come of asking but the
 * app or a question about it. See the header for why not on iOS, nor on a Mac
 * outside Chrome and its kin (chromium below), nor on Windows.
 *
 * Not in an Android WebView, which says so in its agent ("; wv)") and which
 * Chrome and the Custom Tabs most apps open links in do not. A WebView hands
 * a scheme to the system only if the app around it was written to, and one
 * that was not loads the address itself and replaces this page with "net::
 * ERR_UNKNOWN_URL_SCHEME" — the step, the download that was to follow and
 * the way into the browser join, all of it gone before anybody pressed
 * anything. Going back reloads the page with the invitation still in the
 * address, so it asked again and was replaced again, and that app could not
 * reach the join screen at all. insideAnApp names the apps known to do this
 * and says to open the browser; this is every other one, where asking when
 * pressed costs somebody the page once, by their own hand, with the way back
 * leading to the same buttons rather than to the same jump.
 */
export function asksAtOnce(device: Platform | undefined, inApp: boolean, userAgent = navigator.userAgent): boolean {
	if (inApp) return false;

	switch (device) {
		case "android":
			return !/;\s*wv\)/.test(userAgent);
		case "mac":
			return chromium(userAgent);
		default:
			return false;
	}
}

/**
 * Whether a Mac browser is Chrome or one built on it — Edge, Brave, Arc,
 * Opera, Vivaldi — which all carry "Chrome/" in their agents and all ask
 * before opening an app and say nothing when none is there.
 *
 * Named rather than Safari excluded, because what decides this is knowing
 * what a browser does with a scheme nobody claims, and that is known for
 * these. Safari shows an error (see the header); Firefox is not known to do
 * any better, and one that replaced the page with an error would cost what
 * it cost in an Android WebView. Those are offered the app with a button to
 * open it instead, and nobody arriving is asked anything they did not press.
 */
function chromium(userAgent: string): boolean {
	return /\bChrome\/\d/.test(userAgent);
}

/**
 * Whether the person reached the link from this deployment's own pages — the
 * lobby's list of meetings, say — and so is in the browser on purpose.
 */
export function fromHere(referrer = document.referrer, origin = window.location.origin): boolean {
	try {
		return referrer !== "" && new URL(referrer).origin === origin;
	} catch {
		return false;
	}
}

/*
 * The link this tab has already been past the step for.
 *
 * For the tab, like the token itself, and keeping the old product's prefix like
 * every other key (see live/api.ts). Without it, an invitation still in the
 * address after "Join in the browser" put the step back in front of somebody
 * on every reload of the join screen.
 */
const LANDED_KEY = "meet-live.landed";

export function passed(token: string): boolean {
	return recallForTab(LANDED_KEY) === token;
}

export function pass(token: string): void {
	keepForTab(LANDED_KEY, token);
}

/*
 * The two things the page does to the world outside it, apart so that tests
 * can watch them rather than a browser carry them out.
 */

/** Ask the app to open a link. */
export function launch(link: string): void {
	window.location.href = link;
}

/**
 * Start a download, the way a press on a download link would.
 *
 * An anchor rather than an assignment to the address. Both leave the page
 * where it is when the server answers with a file, and only the anchor does
 * when it answers with anything else: an address set to a refusal would
 * replace this page with the refusal's JSON.
 */
export function download(href: string): void {
	const anchor = document.createElement("a");

	anchor.href = href;
	anchor.download = "";
	anchor.rel = "noopener";
	anchor.style.display = "none";

	document.body.append(anchor);
	anchor.click();
	anchor.remove();
}

/** Where a platform's build is downloaded from, carrying the link as the page has it. */
export function downloadHref(path: string, link: Opened): string {
	return `${path}?${link.kind}=${encodeURIComponent(link.token)}`;
}

/** Ask what is offered, carrying the link; nothing where the server will not say. */
export async function offeredTo(link: Opened): Promise<Offered | undefined> {
	try {
		const response = await fetch(downloadHref("/api/apps", link), { credentials: "same-origin" });
		if (!response.ok) return undefined;

		return (await response.json()) as Offered;
	} catch {
		return undefined;
	}
}
