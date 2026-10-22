/*
 * Storage that may not be there.
 *
 * With site data blocked, and in some private windows, local and session
 * storage throw on first touch rather than answering empty. This client read
 * them while drawing -- the language, the name, the controls -- so in such a
 * browser the first screen did not draw at all, and a join wrote them at the top
 * of the press, so the button threw before anything else happened and simply
 * did nothing. Everything remembered here is a convenience, and a browser that
 * will not remember still has to be able to hold a call. So every read and
 * write goes through these, and a refusal reads as nothing kept.
 */

function read(storage: () => Storage, key: string): string | null {
	try {
		return storage().getItem(key);
	} catch {
		return null;
	}
}

function write(storage: () => Storage, key: string, value: string | undefined): void {
	try {
		if (value === undefined) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
		// Nothing kept, which is what that browser asked for.
	}
}

// Through a function, because in those browsers even naming the property
// throws: `localStorage` is a getter, and it is the getter that refuses.
const local = () => localStorage;
const session = () => sessionStorage;

/** What this browser kept under key, or null. */
export const recall = (key: string) => read(local, key);

/** Keep value under key, or forget it when value is undefined. */
export const keep = (key: string, value: string | undefined) => write(local, key, value);

/** The same, for what lasts only as long as the tab. */
export const recallForTab = (key: string) => read(session, key);
export const keepForTab = (key: string, value: string | undefined) => write(session, key, value);
