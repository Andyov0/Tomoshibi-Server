/**
 * YouTube's own embedded player, where it can be reached.
 *
 * Its media addresses are bound to whoever resolved them, so nobody can be
 * handed one to play; somebody who can reach YouTube plays it through YouTube's
 * player instead, driven from here through its IFrame API. Whether they can is
 * found by trying: the API's script either arrives within LOAD_MS or it does not,
 * and in the mainland it does not, and that viewer is given the relay.
 */

/** Long enough for a slow connection; short enough that a blocked one is not a long wait at a black tile. */
export const LOAD_MS = 6000;

/** The part of a YT.Player this uses. */
export interface YouTubePlayer {
	playVideo(): void;
	pauseVideo(): void;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
	getCurrentTime(): number;
	getDuration(): number;
	getPlayerState(): number;
	setVolume(volume: number): void;
	mute(): void;
	unMute(): void;
	destroy(): void;
}

interface YouTubeApi {
	Player: new (
		element: HTMLElement,
		options: {
			videoId: string;
			width?: string;
			height?: string;
			playerVars?: Record<string, number | string>;
			events?: {
				onReady?: () => void;
				onStateChange?: (event: { data: number }) => void;
				onError?: (event: { data: number }) => void;
			};
		},
	) => YouTubePlayer;
}

/** YT.PlayerState, by the numbers the API sends. */
export const ENDED = 0;
export const PLAYING = 1;
export const PAUSED = 2;
export const BUFFERING = 3;

let loading: Promise<YouTubeApi> | undefined;

/** The API, once; rejected if it does not arrive in time, and then tried afresh next time. */
export function youtubeApi(): Promise<YouTubeApi> {
	const ready = (window as { YT?: YouTubeApi & { loaded?: number } }).YT;
	if (ready?.Player && ready.loaded) return Promise.resolve(ready);

	loading ??= new Promise<YouTubeApi>((resolve, reject) => {
		const timer = setTimeout(() => {
			loading = undefined;
			reject(new Error("YouTube did not answer"));
		}, LOAD_MS);

		const previous = (window as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady;
		(window as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = () => {
			previous?.();
			clearTimeout(timer);
			resolve((window as unknown as { YT: YouTubeApi }).YT);
		};

		const script = document.createElement("script");
		script.src = "https://www.youtube.com/iframe_api";
		script.async = true;
		script.onerror = () => {
			clearTimeout(timer);
			loading = undefined;
			script.remove();
			reject(new Error("YouTube could not be reached"));
		};
		document.head.append(script);
	});

	return loading;
}
