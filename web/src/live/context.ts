import { t } from "./i18n";

/**
 * Whether this page may touch cameras and microphones at all.
 *
 * Browsers gate device access on the page being a secure context, and only
 * `localhost` and the loopback addresses are exempt from needing TLS. Over plain
 * HTTP from anywhere else `navigator.mediaDevices` is not merely restricted, it
 * is absent, so the first thing that touches it fails with a type error naming a
 * property rather than the reason it is missing.
 *
 * Checked once, up front, so that the reason can be shown instead.
 */
export function devicesAvailable(): boolean {
	return window.isSecureContext && navigator.mediaDevices !== undefined;
}

/** What to tell somebody who arrived over plain HTTP from another machine. */
export function insecureReason(): string {
	const { protocol, hostname } = window.location;

	if (protocol === "https:") {
		// Secure but still no devices: an old browser, or one where the feature
		// has been switched off by policy.
		return t("This browser blocks camera and microphone access.");
	}

	return t(
		"Cameras and microphones need HTTPS, and {host} is not secure.",
		{ host: hostname },
	);
}

/**
 * Whether this browser can share a screen at all.
 *
 * Safari on iPhone has no `getDisplayMedia`, and no amount of permission
 * changes that. A control that cannot work should not be drawn: pressing it
 * raises a type error naming a property, which says nothing to the person who
 * pressed it and sends whoever reads the report looking at permissions.
 */
export function canShareScreen(): boolean {
	return typeof navigator?.mediaDevices?.getDisplayMedia === "function";
}
