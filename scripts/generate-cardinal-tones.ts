import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Deterministic per-direction fixture tones (ADR 0003 / PRD v1.7 delta D-8).
 * Four simultaneous identical 440 Hz tones are ear-indistinguishable, so each
 * cardinal target gets its own pitch for the eyes-closed pointing test.
 * Format matches the WP-0 test-tone fixture: 48 kHz, mono, 16-bit PCM, 1 s,
 * with 5 ms edge ramps so overlapping starts/stops do not click.
 */
const SAMPLE_RATE_HZ = 48_000;
const DURATION_SEC = 1;
const AMPLITUDE = 0.5;
const RAMP_SEC = 0.005;

const CARDINAL_TONES: readonly { file: string; frequencyHz: number; direction: string }[] = [
  { file: 'tone-440.wav', frequencyHz: 440, direction: 'north' },
  { file: 'tone-550.wav', frequencyHz: 550, direction: 'east' },
  { file: 'tone-660.wav', frequencyHz: 660, direction: 'south' },
  { file: 'tone-880.wav', frequencyHz: 880, direction: 'west' },
];

function renderTone(frequencyHz: number): Buffer {
  const sampleCount = SAMPLE_RATE_HZ * DURATION_SEC;
  const dataBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  buffer.writeUInt32LE(SAMPLE_RATE_HZ * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  const rampSamples = Math.floor(RAMP_SEC * SAMPLE_RATE_HZ);
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / SAMPLE_RATE_HZ;
    const fadeIn = index < rampSamples ? index / rampSamples : 1;
    const remaining = sampleCount - 1 - index;
    const fadeOut = remaining < rampSamples ? remaining / rampSamples : 1;
    const sample = AMPLITUDE * fadeIn * fadeOut * Math.sin(2 * Math.PI * frequencyHz * time);
    buffer.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return buffer;
}

for (const tone of CARDINAL_TONES) {
  const path = resolve('public/audio', tone.file);
  writeFileSync(path, renderTone(tone.frequencyHz));
  console.log(`wrote public/audio/${tone.file} (${tone.frequencyHz} Hz, ${tone.direction})`);
}
