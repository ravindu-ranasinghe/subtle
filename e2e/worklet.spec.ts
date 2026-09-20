/**
 * The resampler worklet, as built, running on a real audio thread.
 *
 * `dsp.test.ts` covers the filter maths in Node. What it cannot cover is the
 * part that only exists in a browser: that `worklets/resampler.js` loads as a
 * classic script through `addModule`, registers under the expected name,
 * survives being fed by a live AudioContext at the device's own sample rate,
 * and posts transferable 100 ms frames with a contiguous clock.
 *
 * Driven from an extension page so `chrome.runtime.getURL` resolves, and
 * fed by an oscillator rather than tabCapture — see env.spec.ts for why
 * tabCapture cannot be reached from automation.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';

let harness: Harness;

test.beforeAll(async () => {
  harness = await launch();
});
test.afterAll(async () => {
  await harness?.close();
});

interface Captured {
  contextRate: number;
  ready: { sampleRate: number; targetRate: number } | null;
  chunks: { length: number; audioStart: number; rms: number }[];
  /** Amplitude at `probeHz` in the concatenated 16 kHz output. */
  amplitude: number;
  error: string | null;
}

/** Runs the worklet against a tone and reports what came back. */
async function runTone(harness: Harness, freq: number, probeHz: number, seconds = 1.6): Promise<Captured> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  const result = await page.evaluate(
    async ([hz, probe, secs]) => {
      const out: {
        contextRate: number;
        ready: { sampleRate: number; targetRate: number } | null;
        chunks: { length: number; audioStart: number; rms: number }[];
        amplitude: number;
        error: string | null;
      } = { contextRate: 0, ready: null, chunks: [], amplitude: 0, error: null };
      try {
        const ctx = new AudioContext();
        out.contextRate = ctx.sampleRate;
        await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklets/resampler.js'));
        await ctx.resume();

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = hz as number;
        const node = new AudioWorkletNode(ctx, 'subtle-resampler', {
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        osc.connect(node);
        // The same muted path capture.ts uses: a worklet with no route to the
        // destination is never pulled.
        const silence = new GainNode(ctx, { gain: 0 });
        node.connect(silence).connect(ctx.destination);

        const all: number[] = [];
        node.port.onmessage = (e: MessageEvent) => {
          const d = e.data as { type: string; samples?: Float32Array; audioStart?: number; sampleRate?: number; targetRate?: number };
          if (d.type === 'ready') {
            out.ready = { sampleRate: d.sampleRate!, targetRate: d.targetRate! };
            return;
          }
          if (d.type !== 'audioChunk' || !d.samples) return;
          let energy = 0;
          for (const v of d.samples) energy += v * v;
          out.chunks.push({
            length: d.samples.length,
            audioStart: d.audioStart!,
            rms: Math.sqrt(energy / d.samples.length),
          });
          for (const v of d.samples) all.push(v);
        };

        osc.start();
        await new Promise((r) => setTimeout(r, (secs as number) * 1000));
        osc.stop();

        // Skip the filter's start-up transient, then measure the tone.
        const body = all.slice(2000, all.length - 800);
        let re = 0;
        let im = 0;
        for (let i = 0; i < body.length; i++) {
          const a = (2 * Math.PI * (probe as number) * i) / 16000;
          re += body[i]! * Math.cos(a);
          im += body[i]! * Math.sin(a);
        }
        out.amplitude = body.length > 0 ? (2 * Math.hypot(re, im)) / body.length : 0;
        await ctx.close();
      } catch (err) {
        out.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      return out;
    },
    [freq, probeHz, seconds] as const,
  );
  await page.close();
  return result as Captured;
}

test('the built worklet loads, resamples and stamps a contiguous clock', async () => {
  const r = await runTone(harness, 1000, 1000);
  console.log(
    `context ${r.contextRate} Hz → ready ${JSON.stringify(r.ready)} · ${r.chunks.length} chunks · ` +
      `1 kHz amplitude ${r.amplitude.toFixed(3)}`,
  );
  expect(r.error, 'worklet threw').toBeNull();

  // It registered under the name capture.ts asks for, and told us the rates.
  expect(r.ready).not.toBeNull();
  expect(r.ready!.targetRate).toBe(16000);
  expect(r.ready!.sampleRate).toBe(r.contextRate);

  // 1.6 s of audio at 100 ms a frame, minus whatever is still buffered.
  expect(r.chunks.length).toBeGreaterThanOrEqual(12);
  for (const c of r.chunks) expect(c.length, 'every frame is 100 ms at 16 kHz').toBe(1600);

  // The clock is contiguous and monotonic, which is what the whole timing
  // layer downstream assumes.
  for (let i = 1; i < r.chunks.length; i++) {
    expect(r.chunks[i]!.audioStart - r.chunks[i - 1]!.audioStart).toBeCloseTo(0.1, 6);
  }

  // The tone survived resampling at close to unity gain.
  expect(r.amplitude).toBeGreaterThan(0.85);
  expect(r.amplitude).toBeLessThan(1.15);
});

test('the built worklet rejects content above the 16 kHz Nyquist instead of aliasing it', async () => {
  // At a 48 kHz context, naive decimation would fold 10 kHz down to 6 kHz at
  // full amplitude. dsp.test.ts asserts this on the maths; this asserts it on
  // the artifact that actually ships.
  const r = await runTone(harness, 10000, 6000);
  console.log(`context ${r.contextRate} Hz · 10 kHz in · 6 kHz alias amplitude ${r.amplitude.toFixed(5)}`);
  expect(r.error).toBeNull();
  expect(r.chunks.length).toBeGreaterThan(0);
  expect(r.amplitude, 'a 10 kHz tone aliased into the speech band').toBeLessThan(0.02);

  const loudest = Math.max(...r.chunks.map((c) => c.rms));
  expect(loudest, 'the whole band should be near silent').toBeLessThan(0.05);
});
