/**
 * Hand a passphrase to the one thing built to keep it.
 *
 * Nothing here writes a secret down. What it does is offer one to the browser's
 * own password manager, which is encrypted at rest, behind whatever unlocks the
 * machine, synced to the same person's other devices, and — the part no
 * application can imitate — visible to its owner and deletable by them.
 *
 * That this was needed at all was a design fault rather than a missing feature.
 * A passphrase used to be the half of a plain text field after a hash, and no
 * password manager on earth can see that: not the browser's, not the one in the
 * extension bar. The field is a password field now, which is most of the fix.
 * This is the rest of it, for a page that never navigates and so never gives
 * Chromium the submission its heuristic is watching for.
 *
 * Everywhere else, the same submission is what the browser's own prompt watches
 * for, and it needs nothing from here.
 */

/**
 * Offer a name and passphrase to the password manager.
 *
 * Silent about everything. A refused prompt, a browser without the interface, a
 * page served over plain HTTP — all of them mean the passphrase is typed again
 * next time, which is exactly what happened before any of this existed.
 */
export async function remember(name: string, passphrase: string): Promise<void> {
	if (!name || !passphrase) return;

	// Present only in a secure context, and only in Chromium. The check is the
	// feature rather than a browser test: where this is missing the form itself
	// is what the browser is reading, and it is reading it already.
	const Stored = (window as { PasswordCredential?: new (data: PasswordCredentialData) => Credential })
		.PasswordCredential;

	if (!Stored || !navigator.credentials?.store) return;

	try {
		await navigator.credentials.store(new Stored({ id: name, password: passphrase }));
	} catch {
		// Storing a credential is an offer, and a refusal is an answer. Nothing
		// about joining a call depends on it.
	}
}

/** The half of the credential interface this uses, which TypeScript does not ship. */
interface PasswordCredentialData {
	id: string;
	password: string;
	name?: string;
}
