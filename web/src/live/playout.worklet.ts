/**
 * The audio-thread side of lossless playout: a shell around Playout.
 *
 * Built by Vite as a separate script (imported with `?worker&url`) and loaded
 * with `audioWorklet.addModule`. It takes decoded blocks from the page, hands
 * the sound card whatever Playout gives it, and reports its counts back about
 * once a second so the page can tell a stalled stream from a quiet one.
 */
import { Playout } from "./playout";

/*
 * The audio thread's globals, which the DOM library this project compiles
 * against does not declare.
 */
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: unknown): void;
declare class AudioWorkletProcessor {
	readonly port: MessagePort;
}

interface Options {
	processorOptions: { channels: number; target: number; ceiling: number };
}

class LosslessPlayout extends AudioWorkletProcessor {
	private playout: Playout;
	private sinceReport = 0;

	constructor(options: Options) {
		super();
		const { channels, target, ceiling } = options.processorOptions;
		this.playout = new Playout(channels, target, ceiling);
		this.port.onmessage = (event: MessageEvent<Float32Array[]>) => this.playout.push(event.data);
	}

	process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
		const out = outputs[0];
		if (out && out.length > 0) this.playout.pull(out);

		this.sinceReport += out?.[0]?.length ?? 128;
		if (this.sinceReport >= sampleRate) {
			this.sinceReport = 0;
			this.port.postMessage(this.playout.counts());
		}

		return true;
	}
}

registerProcessor("tomoshibi-lossless", LosslessPlayout);
