/**
 * Generates the Spanish clip the e2e asserts against. macOS only; the .wav and
 * its reference are committed so the suite runs anywhere.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';

const TEXT = 'Buenos días. Me gustaría aprender español contigo. El tren llega a las siete.';
execFileSync('say', ['-v', 'Mónica', '-o', 'fixtures/spanish.aiff', TEXT]);
execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', 'fixtures/spanish.aiff', 'fixtures/spanish.wav']);
rmSync('fixtures/spanish.aiff');
writeFileSync('fixtures/spanish.txt', TEXT + '\n');
console.log('wrote fixtures/spanish.wav');
