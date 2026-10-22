/**
 * What stands in for somebody whose camera is off.
 *
 * A crossed-out camera says what is missing rather than who is missing. An
 * avatar derived from the identity says the second thing: it is the same
 * picture every time that person appears, and different enough between people
 * that a grid of dark tiles is still a grid of individuals.
 */

/**
 * Muted and warm, replacing the stock palette.
 *
 * The default one is brighter than anything else in this room, and one of its
 * colours is very nearly the tally. An avatar is content — it stands in for
 * video, which carries colour the interface does not — but it must never
 * out-shout the one thing that has to be seen.
 */
export const AVATAR_COLOURS = [
	"#8a6a45",
	"#a1584a",
	"#5d6b58",
	"#4b5a6b",
	"#96814f",
	"#6b5566",
] as const;

/**
 * Derived from the identity rather than the display name.
 *
 * A name can be changed and can collide; the identity is signed into the token
 * and belongs to exactly one participant, so the picture stays put for as long
 * as they do.
 */
export function avatarSeed(identity: string): string {
	return identity;
}
