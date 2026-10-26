import test from 'node:test';
import assert from 'node:assert/strict';
import { SignalHistory } from '../signal-history.js';
import { melColor } from '../mel.js';

test('synchronized history copies observations and leaves dropped slots empty', () => {
  const history = new SignalHistory();
  const bands = new Float32Array([-120, -83]);
  const result = { calibrating: false, signalPresent: true, direction: 'toward', confidence: .8 };
  history.push(bands, result, 1);
  bands[1] = -30; result.direction = 'away';
  history.push(bands, result, 3);
  assert.equal(history.samples.length, 200);
  assert.equal(history.samples[196].bands[1], -83);
  assert.equal(history.samples[196].state, 'toward');
  assert.deepEqual(history.samples.slice(197, 199), [null, null]);
  assert.equal(history.samples[199].state, 'away');
  history.push(bands, { ...result, calibrating: true }, 200);
  assert.equal(history.samples.filter(Boolean).length, 1);
  assert.equal(history.samples[199].state, 'calibrating');
  history.push(bands, { ...result, signalPresent: false }, 1);
  assert.equal(history.samples[199].state, 'absent');
  history.clear();
  assert.ok(history.samples.every(sample => sample === null));
});

test('fixed monochrome mapping preserves relative dB levels and gain is display-only', () => {
  assert.deepEqual(melColor(-140), [0, 0, 0]);
  assert.deepEqual(melColor(-80), [255, 255, 255]);
  assert.deepEqual(melColor(-110), [128, 128, 128]);
  assert.deepEqual(melColor(-120, 10), melColor(-110));
  assert.ok(melColor(-83)[0] > 230);
  assert.ok(melColor(-120)[0] > 70);
});
