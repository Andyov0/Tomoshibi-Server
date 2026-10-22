/**
 * Room names, generated rather than chosen.
 *
 * A room exists because somebody named it, and anybody who knows the name can
 * join. There is no password on top, which is the model every anonymous meeting
 * link uses, and it means the name is the credential: how hard it is to guess is
 * a security property rather than a matter of taste.
 *
 * Three words and four digits is 37 bits. Guessed at the rate the server
 * allows, stumbling onto one of a few thousand rooms in use takes longer than
 * anybody will spend on it. The words carry most of that while keeping the name
 * something one person can read to another over the phone.
 */

// Each list is trimmed to a power of two so a random byte selects a word without
// bias: a modulus over a list that is not a power of two makes the first entries
// fractionally likelier, which is entropy given away for nothing.
const ADJECTIVES = [
	"amber", "ancient", "arctic", "autumn", "azure", "balmy", "blazing", "bold",
	"brave", "breezy", "bright", "brisk", "bronze", "calm", "candid", "cheerful",
	"chilly", "civic", "clear", "clever", "cobalt", "cosmic", "cozy", "crimson",
	"crisp", "curious", "daring", "dawn", "deep", "deft", "dizzy", "dusky",
	"eager", "early", "earnest", "easy", "elder", "electric", "elegant", "ember",
	"empty", "endless", "fair", "faithful", "famous", "fancy", "fearless", "feisty",
	"fertile", "fiery", "final", "fine", "firm", "first", "flat", "fleet",
	"floral", "fluent", "fond", "formal", "forward", "fragrant", "free", "fresh",
	"friendly", "frosty", "frugal", "full", "gallant", "gentle", "giant", "gifted",
	"glad", "glassy", "gleaming", "glossy", "golden", "gracious", "grand", "grassy",
	"gray", "great", "green", "happy", "hardy", "harsh", "hasty", "hazel",
	"healthy", "hearty", "heavy", "helpful", "hidden", "high", "hollow", "honest",
	"hopeful", "humble", "hungry", "ideal", "idle", "indigo", "inner", "ivory",
	"jade", "jolly", "joyful", "keen", "kind", "lanky", "large", "late",
	"lavish", "lean", "level", "light", "lilac", "limber", "lively", "lofty",
	"logical", "lone", "loud", "lower", "loyal", "lucid", "lucky", "lunar",
	"lush", "magenta", "major", "mellow", "merry", "mighty", "mild", "milky",
	"mindful", "minor", "misty", "modern", "modest", "moral", "mossy", "mystic",
	"narrow", "native", "neat", "neutral", "nimble", "noble", "noisy", "normal",
	"northern", "novel", "oaken", "olive", "open", "orange", "ornate", "outer",
	"patient", "peaceful", "pearly", "perfect", "placid", "plain", "playful", "pleasant",
	"plum", "polar", "polite", "prime", "prompt", "proper", "proud", "pure",
	"purple", "quaint", "quick", "quiet", "radiant", "rapid", "rare", "ready",
	"regal", "restful", "rich", "right", "ripe", "rising", "robust", "rosy",
	"round", "royal", "ruby", "rugged", "rural", "rustic", "sable", "safe",
	"sandy", "scarlet", "secret", "serene", "sharp", "sheer", "shiny", "short",
	"silent", "silken", "silver", "simple", "sincere", "skilled", "slender", "slight",
	"small", "smooth", "snowy", "soft", "solar", "solemn", "solid", "sombre",
	"sonic", "sound", "southern", "spare", "spirited", "splendid", "spry", "stable",
	"steady", "stellar", "stern", "still", "stormy", "stout", "straight", "strong",
	"sturdy", "subtle", "sudden", "summer", "sunny", "supple", "sure", "swift",
	"tall", "tame", "tender", "thankful", "thorough", "thrifty", "tidal", "tidy",
] as const;

const NOUNS = [
	"abbey", "acorn", "alcove", "anchor", "anthem", "arbour", "arch", "archer",
	"arrow", "aspen", "atlas", "aurora", "badger", "banner", "basalt", "basin",
	"bay", "beacon", "beam", "bear", "beaver", "beech", "bell", "birch",
	"bison", "blossom", "bluff", "bough", "boulder", "branch", "breaker", "breeze",
	"bridge", "brook", "buffalo", "bugle", "burrow", "cabin", "canal", "canopy",
	"canyon", "cape", "cardinal", "cascade", "castle", "cavern", "cedar", "channel",
	"chapel", "chart", "chasm", "cliff", "cloud", "clover", "comet", "compass",
	"copper", "coral", "cottage", "cove", "crane", "crater", "creek", "crest",
	"crow", "crown", "crystal", "current", "cypress", "dahlia", "dawn", "dell",
	"delta", "dew", "dolphin", "dove", "drift", "dune", "dusk", "eagle",
	"echo", "elm", "ember", "estuary", "falcon", "fawn", "fell", "fern",
	"field", "finch", "fissure", "fjord", "flame", "flint", "forest", "fountain",
	"fox", "gale", "garden", "gate", "geyser", "glacier", "glade", "glen",
	"gorge", "granite", "grove", "gull", "hamlet", "harbour", "harvest", "haven",
	"hawk", "hazel", "heath", "heather", "hedge", "heron", "hickory", "hill",
	"hollow", "horizon", "hummock", "ibis", "inlet", "iris", "island", "ivy",
	"jasmine", "jetty", "juniper", "kestrel", "key", "kite", "knoll", "lagoon",
	"lake", "lantern", "larch", "lark", "laurel", "ledge", "lemur", "lighthouse",
	"lily", "linden", "lion", "lotus", "lynx", "magnolia", "maple", "marsh",
	"meadow", "meander", "mesa", "meteor", "mill", "mist", "moor", "moss",
	"moth", "mountain", "mulberry", "narrows", "nebula", "nest", "oak", "oasis",
	"ocean", "orchard", "orchid", "osprey", "otter", "owl", "palm", "panther",
	"pasture", "path", "peak", "pearl", "pebble", "pelican", "petal", "pier",
	"pigeon", "pillar", "pine", "plateau", "plum", "pond", "poplar", "prairie",
	"quail", "quarry", "quartz", "quay", "rabbit", "rain", "rapids", "raven",
	"reef", "ridge", "rift", "ripple", "river", "robin", "rock", "rook",
	"root", "rose", "sable", "sage", "sail", "sand", "sapling", "savanna",
	"sequoia", "shale", "shell", "shoal", "shore", "shrub", "sierra", "silo",
	"sky", "slope", "snow", "sparrow", "spire", "spring", "spruce", "spur",
	"stag", "star", "steppe", "stone", "stork", "strand", "stream", "summit",
	"sun", "swallow", "swan", "sycamore", "tarn", "teal", "temple", "terrace",
	"thermal", "thicket", "thistle", "thorn", "thrush", "tide", "timber", "toucan",
] as const;

const VERBS = [
	"abide", "adorn", "amble", "anchor", "arch", "arise", "ascend", "balance",
	"bank", "bask", "beam", "beckon", "bend", "bide", "blaze", "bloom",
	"blossom", "bound", "brace", "branch", "breeze", "brighten", "bristle", "broaden",
	"buoy", "burrow", "carry", "carve", "cascade", "cast", "chart", "chase",
	"cheer", "chime", "circle", "claim", "clasp", "clear", "cleave", "climb",
	"cling", "coast", "coax", "coil", "collect", "comb", "crest", "cross",
	"crown", "cruise", "cull", "curl", "curve", "dance", "dart", "dash",
	"dawn", "deepen", "descend", "dip", "dive", "draw", "drift", "dwell",
	"ease", "ebb", "echo", "edge", "elevate", "ember", "emerge", "enfold",
	"enter", "escort", "fall", "fan", "fasten", "ferry", "fetch", "fill",
	"filter", "finish", "flag", "flank", "flare", "flee", "flick", "fling",
	"flip", "float", "flourish", "flow", "flutter", "fold", "follow", "forage",
	"forge", "gather", "glide", "glimmer", "glisten", "glow", "grace", "graze",
	"grow", "guard", "guide", "gust", "harbour", "harvest", "haul", "haunt",
	"heave", "herd", "hold", "hover", "hurry", "ignite", "journey", "keep",
	"kindle", "laze", "leap", "lift", "linger", "listen", "loop", "lull",
	"mantle", "mark", "meander", "mend", "mingle", "mirror", "mount", "muster",
	"nestle", "open", "orbit", "paddle", "pass", "pause", "perch", "pivot",
	"plait", "play", "plume", "ponder", "pool", "press", "prowl", "pull",
	"quiver", "race", "radiate", "ramble", "range", "reach", "rebound", "recall",
	"reflect", "rest", "return", "ride", "rise", "roam", "rock", "roll",
	"rove", "rush", "sail", "scale", "scatter", "search", "settle", "shape",
	"shelter", "shift", "shimmer", "shine", "sift", "signal", "sing", "skim",
	"skip", "slide", "slip", "soar", "sound", "spark", "speak", "spin",
	"spiral", "split", "spread", "spring", "sprout", "stack", "stand", "steady",
	"steer", "stir", "stitch", "stray", "stream", "stretch", "stride", "strike",
	"stroll", "surge", "sway", "sweep", "swell", "swim", "swing", "tack",
	"tail", "take", "tally", "tap", "temper", "tend", "thread", "thrive",
	"tilt", "tip", "toll", "top", "toss", "trace", "track", "trail",
	"travel", "traverse", "trek", "trim", "trot", "tumble", "turn", "twine",
	"twirl", "unfold", "unfurl", "usher", "vault", "veer", "venture", "voyage",
	"wade", "wake", "wander", "watch", "wave", "weave", "wheel", "whirl",
] as const;

/** How many digits follow the words. */
const DIGITS = 4;

/** The longest name the server will accept, before any scope. */
export const MAX_ROOM_NAME = 64;

/** The longest scope the server will accept after the `@`. */
export const MAX_SCOPE = 32;

/** The longest a whole name can be: a room, its `@`, and its scope. */
export const MAX_SCOPED_NAME = MAX_ROOM_NAME + 1 + MAX_SCOPE;

/**
 * Generate a room name.
 *
 * Drawn from `crypto.getRandomValues` rather than `Math.random`, which is not
 * seeded or advanced in any way worth relying on for a value that decides who
 * can enter a room.
 */
export function generateRoomName(): string {
	const bytes = new Uint8Array(5);
	crypto.getRandomValues(bytes);

	// Destructured with defaults so the indexing is provably in range. The array
	// was just filled to this length, so the fallbacks never run; stating them
	// beats asserting the compiler is wrong.
	const [word = 0, thing = 0, action = 0, high = 0, low = 0] = bytes;

	const digits = (((high << 8) | low) % 10 ** DIGITS).toString().padStart(DIGITS, "0");

	return [ADJECTIVES[word], NOUNS[thing], VERBS[action], digits].join("-");
}

/**
 * Reduce what somebody typed to a name the server will accept.
 *
 * Applied as they type rather than on submit, so a rejected character is
 * something they watch not happen instead of an error afterwards. The rules
 * match the server's, and it is still the server that decides.
 */
export function normaliseRoomName(typed: string): string {
	const lowered = typed.toLowerCase();
	const at = lowered.indexOf("@");

	if (at < 0) return plain(lowered, MAX_ROOM_NAME);

	// One `@`, and each side held to its own rule. A second `@` is folded into
	// the scope as a dash like any other character the server would refuse,
	// because a name that splits two ways is the one thing a scope must never be.
	//
	// The `@` itself is kept while nothing follows it. This runs as somebody
	// types, and a separator that vanished the moment it was pressed would be a
	// scope nobody could type — only paste.
	const local = plain(lowered.slice(0, at), MAX_ROOM_NAME);
	const scope = plain(lowered.slice(at + 1), MAX_SCOPE);

	return `${local}@${scope}`;
}

/** The rule a room name has always been held to, for either half of one. */
function plain(typed: string, longest: number): string {
	return typed
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+/, "")
		.slice(0, longest)
		.replace(/-+$/, "");
}

const PLAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Whether a name is one the server will authorise.
 *
 * A room, or a room and the scope it is held under after a single `@`. Each half
 * is a plain name, which is the server's rule as well; it is still the server
 * that decides.
 */
export function validRoomName(name: string): boolean {
	const [local = "", scope, ...more] = name.split("@");

	if (more.length > 0) return false;
	if (local.length > MAX_ROOM_NAME || !PLAIN.test(local)) return false;

	return scope === undefined || validScope(scope);
}

/** Whether a scope is one an account may carry and a room may name. */
export function validScope(scope: string): boolean {
	return scope.length <= MAX_SCOPE && PLAIN.test(scope);
}

/**
 * The scope a room is held under, or nothing for a plain room.
 *
 * Read from the name because that is the only place it is written. There is no
 * scope object to ask: a room under one is a name a group of people share, and
 * what the suffix changes is who the server lets say it.
 */
export function scopeOf(name: string): string {
	const at = name.indexOf("@");

	return at < 0 ? "" : name.slice(at + 1);
}

/**
 * Whether a name looks generated rather than chosen.
 *
 * Decides whether to say that a room can be guessed. A name somebody typed is
 * usually short and meaningful, which is exactly what makes it guessable; one
 * from here is not, and saying so about it would be noise.
 */
export function looksGenerated(name: string): boolean {
	const parts = name.split("-");

	const [word, thing, action, digits] = parts;

	return (
		parts.length === 4 &&
		digits !== undefined &&
		digits.length === DIGITS &&
		/^\d+$/.test(digits) &&
		(ADJECTIVES as readonly string[]).includes(word ?? "") &&
		(NOUNS as readonly string[]).includes(thing ?? "") &&
		(VERBS as readonly string[]).includes(action ?? "")
	);
}
