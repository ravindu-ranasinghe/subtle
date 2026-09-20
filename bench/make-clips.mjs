/**
 * Generates a clip folder from the sentence list below using macOS `say`.
 *
 * These are text-to-speech, not real recordings: clean, evenly paced, no
 * background. WER against them is a floor, not a forecast — see the warning
 * bench/run.ts prints. They exist so the harness can be run end to end
 * without shipping audio, and so the pipeline can be smoke-tested offline.
 *
 * Point run.ts at a folder of real recordings for numbers that mean anything.
 *
 *   node make-clips.mjs [outDir]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SENTENCES = {
  en: [
    ['Samantha', 'The quick brown fox jumps over the lazy dog.'],
    ['Samantha', 'She sells seashells by the sea shore on a bright summer morning.'],
    ['Alex', 'Could you tell me how to get to the railway station from here?'],
  ],
  es: [
    ['Mónica', 'Buenos días, ¿cómo estás hoy?'],
    ['Mónica', 'Me gustaría aprender español contigo durante el verano.'],
    ['Paulina', 'El tren de las siete llega siempre con mucho retraso.'],
  ],
  fr: [
    ['Thomas', 'Bonjour, comment allez-vous aujourd\'hui ?'],
    ['Thomas', 'Je voudrais apprendre le français avec vous cet été.'],
    ['Amélie', 'Le train de sept heures arrive toujours en retard.'],
  ],
  ja: [
    ['Kyoko', 'おはようございます、今日はいい天気ですね。'],
    ['Kyoko', '日本語を勉強するのはとても楽しいです。'],
    ['Kyoko', '七時の電車はいつも遅れています。'],
  ],
};

const outDir = process.argv[2] ?? './clips';
rmSync(outDir, { recursive: true, force: true });

let made = 0;
for (const [lang, sentences] of Object.entries(SENTENCES)) {
  const dir = join(outDir, lang);
  mkdirSync(dir, { recursive: true });
  sentences.forEach(([voice, text], i) => {
    const name = `${lang}-${String(i + 1).padStart(2, '0')}`;
    const aiff = join(dir, `${name}.aiff`);
    try {
      execFileSync('say', ['-v', voice, '-o', aiff, text]);
    } catch {
      console.warn(`skipped ${name}: voice "${voice}" is not installed`);
      return;
    }
    // 16 kHz mono PCM16 — what the capture worklet delivers.
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, join(dir, `${name}.wav`)]);
    rmSync(aiff);
    writeFileSync(join(dir, `${name}.txt`), text + '\n');
    made++;
  });
}
console.log(`wrote ${made} clips to ${outDir}`);
