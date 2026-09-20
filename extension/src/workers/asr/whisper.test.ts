import { expect, it } from 'vitest';
import { WhisperFeatureExtractor } from '@huggingface/transformers';
import { liveFeatures, maxTokensFor } from './whisper.js';

it('fast live preprocessing matches all 240,000 features of full Whisper preprocessing', async () => {
  const extractor = new WhisperFeatureExtractor({
    n_fft: 400, hop_length: 160, feature_size: 80, sampling_rate: 16000,
    n_samples: 480000, nb_max_frames: 3000,
  });
  for (const amplitude of [0, 0.001, 0.4]) {
    // Non-aligned length exercises the final FFT window and zero padding.
    const samples = Float32Array.from({ length: 9137 }, (_, i) => amplitude * Math.sin(i * 0.12) * Math.sin(i * 0.009));
    const expected = (await extractor(samples)).input_features;
    const actual = await liveFeatures(extractor, samples);
    expect(actual.dims).toEqual(expected.dims);
    let error = 0;
    for (let i = 0; i < actual.data.length; i++) error = Math.max(error, Math.abs(Number(actual.data[i]) - Number(expected.data[i])));
    expect(error).toBeLessThan(0.00001);
  }
});

it('bounds the decode to roughly twice the fastest real speech, never to zero', () => {
  // A 2.5 s chunk: ~60 tokens is far more than 2.5 s of speech ever produces,
  // and far less than the 448 a repetition loop would spend.
  expect(maxTokensFor(2.5)).toBe(60);
  // A 0.48 s preview still gets enough to say something.
  expect(maxTokensFor(0.48)).toBe(24);
  expect(maxTokensFor(0)).toBe(24);
  // Never above Whisper's own ceiling, whatever it is handed.
  expect(maxTokensFor(30)).toBe(224);
  expect(maxTokensFor(1e6)).toBe(224);
});
