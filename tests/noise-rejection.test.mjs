import test from 'node:test';
import assert from 'node:assert/strict';
import { DopplerDetector } from '../doppler.js';
import { estimateVelocity } from '../velocity.js';
import { calibratedNoiseDetector, noisySpectrum } from './helpers/noisy-spectrum.mjs';

test('colored noise humps are rejected on both sides, not interpreted as speed', () => {
  for (const sign of [-1, 1]) {
    const detector = calibratedNoiseDetector(DopplerDetector);
    for (let t = 2240; t <= 3040; t += 40) {
      const result = detector.process(noisySpectrum({ humpHz: sign * 240 }), t);
      assert.equal(result.direction, 'still');
      assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
      assert.equal(result.noiseRejected, true);
    }
  }
});

test('a moving colored-noise burst cannot become a reflection track', () => {
  const detector = calibratedNoiseDetector(DopplerDetector);
  for (let t = 2240; t <= 3040; t += 40) {
    const result = detector.process(noisySpectrum({ humpHz: 200 + 120 * Math.sin(t / 90), humpDb: -65 }), t);
    assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
    assert.equal(result.direction, 'still');
  }
});

test('an isolated reflection survives a broad pedestal and opposing-side interference', () => {
  for (const sign of [-1, 1]) {
    for (const humpSign of [-1, 1]) {
      const detector = calibratedNoiseDetector(DopplerDetector);
      let result;
      for (let t = 2240; t <= 3040; t += 40) result = detector.process(noisySpectrum({ humpHz: humpSign * 200, humpDb: -80, reflectionHz: sign * 165 }), t);
      const velocity = estimateVelocity(result);
      const side = sign > 0 ? 'toward' : 'away';
      assert.ok(velocity[side] * sign > 1.5 && velocity[side] * sign < 2);
      assert.equal(result.direction, sign > 0 ? 'toward' : 'away');
    }
  }
});


test('isolated narrow peaks jumping across frequency bins do not form a velocity track', () => {
  for (const sign of [-1, 1]) {
    const detector = calibratedNoiseDetector(DopplerDetector);
    const offsets = [100, 400, 150, 600, 250, 500];
    for (let i = 0; i < 24; i++) {
      const result = detector.process(noisySpectrum({ reflectionHz: sign * offsets[i % offsets.length] }), 2240 + i * 40);
      assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
      assert.equal(result.direction, 'still');
    }
  }
});
