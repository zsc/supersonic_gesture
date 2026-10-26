import test from 'node:test';
import assert from 'node:assert/strict';
import { DopplerDetector } from '../doppler.js';
import { estimateVelocity } from '../velocity.js';
import { periodicMotion } from './helpers/periodic-motion.mjs';

test('symmetric periodic speeds survive unequal side amplitudes and swapping the weak side', () => {
  for (const carrierHz of [16000, 19000]) {
    for (const [towardDb, awayDb] of [[-76, -82], [-82, -76], [-79, -79]]) {
      const { summary } = periodicMotion(DopplerDetector, estimateVelocity, { carrierHz, towardDb, awayDb });
      for (const side of ['toward', 'away']) {
        assert.ok(summary[side].coverage > .95, JSON.stringify(summary));
        assert.ok(summary[side].meanError < .18, JSON.stringify(summary));
      }
      assert.ok(Math.abs(summary.toward.peak - summary.away.peak) < .05, JSON.stringify(summary));
    }
  }
});

test('lost peaks are immediately unknown and reacquisition does not reuse old half-cycle speed', () => {
  const { detector, spectrum, lastTime } = periodicMotion(DopplerDetector, estimateVelocity);
  let now = lastTime;
  let result;
  for (let i = 0; i < 10; i++) result = detector.process(spectrum(1), now += 40);
  assert.ok(estimateVelocity(result).toward > .9);
  result = detector.process(spectrum(), now += 40);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
  result = detector.process(spectrum(3), now += 40);
  assert.ok(Math.abs(estimateVelocity(result).toward - 3) < .08);
  detector.resetCalibration();
  result = detector.process(spectrum(3), now += 40);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
});

test('direction debounce cannot suppress a currently validated spectral speed', () => {
  const result = { direction: 'still', calibrating: false, signalPresent: true, carrierHz: 16000, velocityShifts: { toward: 100, away: -100 } };
  const velocity = estimateVelocity(result);
  assert.ok(velocity.toward > 1 && velocity.away < -1);
  // Conversely, a stale direction cannot invent a speed after the peak is gone.
  assert.deepEqual(estimateVelocity({ ...result, direction: 'toward', velocityShifts: { toward: null, away: null } }), { toward: null, away: null });
});
