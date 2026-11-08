import { cn } from "@/lib/utils";

/*
 * One height and one shape for everything in the corner: the account, signing
 * out, the console and the language. They were thirty, twenty-six and thirty-
 * two pixels tall, three of them outlined and one not, so a row of four
 * controls read as four leftovers; and a finger's forty-four under a finger.
 */
export const CORNER = cn(
	"pressable flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[12.5px] outline-none",
	"focus-visible:ring-2 focus-visible:ring-fg/70 pointer-coarse:h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center pointer-coarse:px-3",
);
