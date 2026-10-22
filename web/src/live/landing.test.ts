import { afterEach, describe, expect, it } from "vitest";
import { NOTHING, type Offered } from "@/components/apps/shelves";
import {
	appLink,
	asksAtOnce,
	downloadHref,
	downloadsByItself,
	fromHere,
	insideAnApp,
	offerFor,
	opened,
	pass,
	passed,
} from "./landing";

/*
 * The decisions behind the step that offers the app, each of which goes wrong
 * where nobody watching a test would see it.
 *
 * A link built in a form the apps do not read opens the app on its lobby and
 * nowhere near the meeting. An app's own browser taken for a real one is a
 * button that does nothing inside WeChat; a real one taken for an app's is a
 * whole browser told to go and find a browser. An offer made for a device with
 * nothing to install is a page of nothing in front of the join screen, and the
 * step shown to somebody who came from the lobby is a host asked whether they
 * have the app every time they open their own meeting.
 */

afterEach(() => sessionStorage.clear());

describe("the link the page was opened with", () => {
	it("is the invitation or the meeting in the address, the invitation first", () => {
		expect(opened("?invite=abc")).toEqual({ kind: "invite", token: "abc" });
		expect(opened("?meeting=xyz")).toEqual({ kind: "meeting", token: "xyz" });
		expect(opened("?meeting=xyz&invite=abc")).toEqual({ kind: "invite", token: "abc" });
	});

	it("is nothing without one, or with an empty one", () => {
		expect(opened("")).toBeUndefined();
		expect(opened("?invite=")).toBeUndefined();
		expect(opened("?meeting=%20")).toBeUndefined();
		expect(opened("?room=standup")).toBeUndefined();
	});
});

/*
 * tomoshibi://<deployment host><the same path, query and fragment>, which is
 * what the apps read: the Apple apps' AppModel.open and the Android app's
 * OpenedLink put the scheme back to https and read the host, invite= or
 * meeting=, and the room after #/.
 */
describe("the link the app is given", () => {
	it("is the deployment's own link under the app's scheme", () => {
		expect(appLink({ kind: "invite", token: "T0k3n_-" }, "standup", "meet.example.com")).toBe(
			"tomoshibi://meet.example.com/?invite=T0k3n_-#/standup",
		);
		expect(appLink({ kind: "meeting", token: "M33t" }, "weekly", "meet.example.com")).toBe(
			"tomoshibi://meet.example.com/?meeting=M33t#/weekly",
		);
	});

	it("keeps a port, and carries a token whole whatever is in it", () => {
		const said = new URL(appLink({ kind: "invite", token: "a+b/c=" }, "board@acme", "127.0.0.1:19660"));

		expect(said.protocol).toBe("tomoshibi:");
		expect(said.host).toBe("127.0.0.1:19660");
		expect(said.searchParams.get("invite")).toBe("a+b/c=");
		expect(said.hash).toBe("#/board@acme");
	});

	it("has no fragment where there is no room", () => {
		expect(appLink({ kind: "invite", token: "T" }, "", "meet.example.com")).toBe("tomoshibi://meet.example.com/?invite=T");
	});
});

describe("an app's own browser", () => {
	const inside = {
		"WeChat on Android":
			"Mozilla/5.0 (Linux; Android 14; SM-S9180 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.120 Mobile Safari/537.36 XWEB/1220133 MMWEBSDK/20240404 MMWEBID/1234 MicroMessenger/8.0.49.2600(0x28003133) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64",
		"WeChat on an iPhone":
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x18003231) NetType/WIFI Language/zh_CN",
		WeCom: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 wxwork/4.1.22 MicroMessenger/7.0.1 Language/zh",
		"QQ on Android":
			"Mozilla/5.0 (Linux; U; Android 14; zh-cn; PJD110 Build/UKQ1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/6.2 TBS/047601 Mobile Safari/537.36 V1_AND_SQ_9.0.50_6248_YYB_D QQ/9.0.50.16545 NetType/WIFI WebP/0.3.0 AppId/537231791",
		"QQ on an iPhone":
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.0.60.611 V1_IPH_SQ_9.0.60_1_APP_A Pixel/1179 MiniAppEnable SimpleUISwitch/0 StudyMode/0 CurrentMode/0 CurrentFontScale/1.000000 QQTheme/1000 AppId/537230561 Core/WKWebView Device/Apple(iPhone 15 Pro) NetType/WIFI QBWebViewType/1 WKType/1",
		Weibo: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Weibo (iPhone15,2__weibo__14.6.0__iphone__os18.0)",
		DingTalk: "Mozilla/5.0 (Linux; Android 14; V2309A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 AliApp(DingTalk/7.6.0) com.alibaba.android.rimet/36186028 Channel/700159 language/zh-CN",
		Alipay: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AlipayClient/10.6.20.6000",
		Douyin: "Mozilla/5.0 (Linux; Android 14; 23013RK75C; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 aweme_310100 JsSdk/1.0 NetType/WIFI Channel/xiaomi_1128_64 app_version/31.1.0",
		Feishu: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Lark/7.30.6 LarkLocale/zh_CN ChannelName/Feishu",
		Facebook: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.40.108;FBBV/645557380]",
		Instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.30.98 (iPhone15,2; iOS 18_0; en_US)",
		LINE: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.16.0",
	};

	const browsers = {
		"Chrome on a Mac":
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
		"Safari on an iPhone":
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
		"Chrome on Android":
			"Mozilla/5.0 (Linux; Android 16; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
		"QQ Browser, which is a browser":
			"Mozilla/5.0 (Linux; U; Android 14; zh-cn; V2309A Build/UP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/109.0.5414.86 MQQBrowser/15.4 Mobile Safari/537.36 COVC/047601",
		"Edge on Windows":
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
		"Firefox on Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
		"Chrome on an iPhone":
			"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1",
	};

	it("is each of the apps people send these links through", () => {
		for (const [name, agent] of Object.entries(inside)) expect(insideAnApp(agent), name).toBe(true);
	});

	it("is not a browser", () => {
		for (const [name, agent] of Object.entries(browsers)) expect(insideAnApp(agent), name).toBe(false);
	});
});

describe("what a device is offered", () => {
	const everything: Offered = {
		mac: { available: true, version: "1.4.2", size: 84_213_760 },
		android: { available: true, version: "0.1.0.6", size: 31_457_280 },
		windows: { available: true, version: "0.1.0.2", size: 41_943_040 },
		ios: { invites: false, left: 0, link: "https://testflight.apple.com/join/AbCd1234" },
	};

	it("is the build for the device, where there is one", () => {
		expect(offerFor("mac", everything)).toEqual({ kind: "mac" });
		expect(offerFor("android", everything)).toEqual({ kind: "android" });
		expect(offerFor("windows", everything)).toEqual({ kind: "windows" });
		expect(offerFor("mac", { ...everything, mac: { available: false } })).toBeUndefined();
		expect(offerFor("android", { ...everything, android: { available: false } })).toBeUndefined();

		// The Windows build is offered on its own account, whatever else is.
		expect(offerFor("windows", { ...NOTHING, windows: everything.windows })).toEqual({ kind: "windows" });
	});

	it("is an invitation by address on iOS for an account, and the public link otherwise", () => {
		expect(offerFor("ios", { ...everything, ios: { invites: true, left: 5 } })).toEqual({ kind: "ios-invite" });
		expect(offerFor("ios", everything)).toEqual({ kind: "ios-link", link: "https://testflight.apple.com/join/AbCd1234" });
		expect(offerFor("ios", { ...everything, ios: { invites: false, left: 0 } })).toBeUndefined();
	});

	it("is the sentence that Windows is coming where it has no build, only where some app is offered at all", () => {
		expect(offerFor("windows", { ...everything, windows: { available: false } })).toEqual({ kind: "windows-soon" });
		expect(offerFor("windows", NOTHING)).toBeUndefined();
	});

	it("is nothing for a device this cannot place", () => {
		expect(offerFor(undefined, everything)).toBeUndefined();
	});
});

describe("asking the app at once", () => {
	const CHROME_ON_A_MAC =
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
	const CHROME_ON_ANDROID =
		"Mozilla/5.0 (Linux; Android 16; SM-F956B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";
	// An app that is on nobody's list, opening the link in a WebView of its own.
	const A_WEBVIEW =
		"Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240905.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36 Reader/5.2.1";

	it("is where there is an app that could answer and nothing else would", () => {
		expect(asksAtOnce("mac", false, CHROME_ON_A_MAC)).toBe(true);
		expect(asksAtOnce("android", false, CHROME_ON_ANDROID)).toBe(true);
	});

	it("is not in an Android WebView, which may load the scheme itself and replace the page", () => {
		expect(asksAtOnce("android", false, A_WEBVIEW)).toBe(false);
	});

	it("is on a Mac only in Chrome and the browsers built on it, which ask or say nothing", () => {
		expect(
			asksAtOnce(
				"mac",
				false,
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
			),
		).toBe(true);
		// Safari says the address is invalid, as it does on an iPhone.
		expect(
			asksAtOnce(
				"mac",
				false,
				"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
			),
		).toBe(false);
		expect(asksAtOnce("mac", false, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0")).toBe(
			false,
		);
	});

	it("is not on iOS, where an app that is not there is an alert, nor on Windows, where it is a dialog", () => {
		expect(asksAtOnce("ios", false)).toBe(false);
		// Chrome on Windows, which on a Mac would be asked at once.
		expect(
			asksAtOnce(
				"windows",
				false,
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
			),
		).toBe(false);
		expect(asksAtOnce(undefined, false)).toBe(false);
	});

	it("is never inside an app's own browser", () => {
		expect(asksAtOnce("mac", true)).toBe(false);
		expect(asksAtOnce("android", true)).toBe(false);
	});

	// Only the Mac: Windows is a computer too, but its installer is not signed
	// and every browser warns about it, so it waits for a press beside the
	// line that says what to do about the warnings.
	it("downloads by itself only on a Mac", () => {
		expect(downloadsByItself("mac")).toBe(true);
		expect(downloadsByItself("windows")).toBe(false);
		expect(downloadsByItself("android")).toBe(false);
		expect(downloadsByItself("ios-link")).toBe(false);
		expect(downloadsByItself(undefined)).toBe(false);
	});
});

describe("arriving from this deployment's own pages", () => {
	it("is a referrer on this origin", () => {
		expect(fromHere("https://meet.example.com/", "https://meet.example.com")).toBe(true);
		expect(fromHere("https://meet.example.com/#/lobby", "https://meet.example.com")).toBe(true);
	});

	it("is not a referrer from anywhere else, or none", () => {
		expect(fromHere("https://mail.example.com/", "https://meet.example.com")).toBe(false);
		expect(fromHere("https://meet.example.com.example.com/", "https://meet.example.com")).toBe(false);
		expect(fromHere("", "https://meet.example.com")).toBe(false);
		expect(fromHere("not a url", "https://meet.example.com")).toBe(false);
	});
});

describe("having been past the step", () => {
	it("is remembered for the tab, for that link only", () => {
		expect(passed("one")).toBe(false);

		pass("one");

		expect(passed("one")).toBe(true);
		expect(passed("two")).toBe(false);
	});
});

it("downloads carry the link as the page has it", () => {
	expect(downloadHref("/api/apps/mac", { kind: "invite", token: "a+b" })).toBe("/api/apps/mac?invite=a%2Bb");
	expect(downloadHref("/api/apps", { kind: "meeting", token: "M" })).toBe("/api/apps?meeting=M");
});
