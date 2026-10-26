import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftToVelocity, estimateVelocity, velocityText } from '../velocity.js';
import { SignalHistory } from '../signal-history.js';

test('reflection velocity inversion recovers known signed speeds across carriers', () => {
  for (const frequency of [16000, 18000, 20000]) {
    for (const speed of [-4, -1, 0, 1, 4]) {
      const received = frequency * (343 + speed) / (343 - speed);
      assert.ok(Math.abs(shiftToVelocity(received - frequency, frequency) - speed) < 1e-10);
    }
  }
  assert.equal(shiftToVelocity(NaN, 16000), null);
  assert.equal(shiftToVelocity(10, 0), null);
  assert.equal(shiftToVelocity(-16000, 16000), null);
});

test('mixed returns both branches while calibration and absent remain unknown without direction gating', () => {
  const mixed = { direction: 'mixed', calibrating: false, signalPresent: true, carrierHz: 16000, velocityShifts: { toward: 100, away: -150 }, shiftHz: 0 };
  const velocity = estimateVelocity(mixed);
  assert.ok(velocity.toward > 1 && velocity.away < -1.5);
  assert.equal(velocityText(velocity), '+1.07 / -1.62');
  for (const overrides of [{ calibrating: true }, { signalPresent: false }, { velocityShifts: { toward: null, away: null } }]) {
    const v = estimateVelocity({ ...mixed, ...overrides });
    assert.deepEqual(v, { toward: null, away: null });
    assert.equal(velocityText(v), '—');
  }
  const history = new SignalHistory();
  history.push(new Float32Array([-80]), mixed, 1);
  mixed.velocityShifts.toward = 200;
  history.push(new Float32Array([-80]), { ...mixed, direction: 'away', velocityShifts: { toward: null, away: -150 } }, 2);
  assert.equal(history.samples[197].velocity.toward, velocity.toward);
  assert.equal(history.samples[198], null);
  assert.equal(history.samples[199].velocity.toward, null);
  assert.ok(history.samples[199].velocity.away < 0);
});
