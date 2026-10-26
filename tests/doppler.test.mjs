import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateVelocity } from '../velocity.js';
import { readFile } from 'node:fs/promises';

// Loading through a data URL keeps this static site's test independent of a
// package.json or any installation step.
const code = await readFile(new URL('../doppler.js', import.meta.url), 'utf8');
const { DopplerDetector } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const options = { sampleRate: 48000, fftSize: 8192, carrierHz: 20000 };
const binHz = options.sampleRate / options.fftSize;
function spectrum({ carrier = -35, toward, away, noise = -110 } = {}) {
  const bins = new Float32Array(options.fftSize / 2).fill(noise);
  function peak(frequency, db) {
    const center = Math.round(frequency / binHz);
    for (let delta = -2; delta <= 2; delta++) {
      const value = db - 8 * Math.abs(delta);
      bins[center + delta] = Math.max(bins[center + delta], value);
    }
  }
  if (carrier !== null) peak(options.carrierHz, carrier);
  if (toward) peak(options.carrierHz + toward.shift, toward.db);
  if (away) peak(options.carrierHz - away.shift, away.db);
  return bins;
}
function makeCalibrated(frame = spectrum(), step = 20) {
  const detector = new DopplerDetector(options);
  let result;
  for (let t = 0; t <= 2100; t += step) result = detector.process(frame, t);
  assert.equal(result.baselineReady, true);
  return detector;
}
function feed(detector, frame, { start = 2120, duration = 600, step = 20 } = {}) {
  let result;
  for (let t = start; t <= start + duration; t += step) result = detector.process(frame, t);
  return result;
}

test('stationary carrier calibrates, remains still, and reports no artificial motion', () => {
  const detector = makeCalibrated();
  const result = feed(detector, spectrum());
  assert.equal(result.signalPresent, true);
  assert.equal(result.direction, 'still');
  assert.equal(result.shiftHz, 0);
  assert.equal(result.activity, 0);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
  assert.equal(result.confidence, 0);
});

test('positive reflected sideband is toward and negative is away', () => {
  for (const [direction, side, sign] of [['toward', 'toward', 1], ['away', 'away', -1]]) {
    const result = feed(makeCalibrated(), spectrum({ [side]: { shift: 165, db: -57 } }));
    assert.equal(result.direction, direction);
    assert.ok(Math.abs(result.shiftHz - 165 * sign) < 8);
    assert.ok(result.confidence > 0.5);
    assert.ok(result.activity <= 1 && result.activity > 0.5);
  }
});

test('simultaneous strong sidebands are mixed, without a fictional signed velocity', () => {
  const result = feed(makeCalibrated(), spectrum({
    toward: { shift: 150, db: -57 }, away: { shift: 190, db: -58 }
  }));
  assert.equal(result.direction, 'mixed');
  assert.equal(result.shiftHz, 0);
  assert.equal(result.carrierHz, 20000);
  assert.ok(Math.abs(result.towardShiftHz - 150) < 8);
  assert.ok(Math.abs(result.awayShiftHz + 190) < 8);
  const velocity = estimateVelocity(result);
  assert.ok(velocity.toward > 1.2 && velocity.toward < 1.4);
  assert.ok(velocity.away < -1.5 && velocity.away > -1.8);
  assert.ok(result.towardEnergy > 0.5 && result.awayEnergy > 0.5);
});

test('silence and missing pilot cannot become directional gestures', () => {
  for (const frame of [new Float32Array(4096).fill(-Infinity), spectrum({ carrier: null, toward: { shift: 165, db: -40 } })]) {
    const result = feed(makeCalibrated(), frame);
    assert.equal(result.signalPresent, false);
    assert.equal(result.direction, 'still');
    assert.equal(result.confidence, 0);
    assert.equal(result.activity, 0);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
  }
});

test('a stationary adjacent interference peak learned during calibration is ignored', () => {
  const frame = spectrum({ toward: { shift: 165, db: -55 } });
  const result = feed(makeCalibrated(frame), frame);
  assert.equal(result.direction, 'still');
  assert.equal(result.activity, 0);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
});

test('short bursts fail the time-based gate; sustained gestures pass at both 30 and 60 fps', () => {
  const moving = spectrum({ toward: { shift: 165, db: -57 } });
  for (const step of [1000 / 30, 1000 / 60]) {
    const detector = makeCalibrated(spectrum(), step);
    let result = feed(detector, moving, { duration: 60, step });
    assert.equal(result.direction, 'still');
    result = feed(detector, moving, { start: 2200, duration: 400, step });
    assert.equal(result.direction, 'toward');
  }
});

test('motion decays back to still and removing carrier clears immediately', () => {
  const detector = makeCalibrated();
  assert.equal(feed(detector, spectrum({ away: { shift: 200, db: -58 } })).direction, 'away');
  assert.equal(feed(detector, spectrum(), { start: 2740, duration: 800 }).direction, 'still');
  feed(detector, spectrum({ toward: { shift: 150, db: -55 } }), { start: 3560, duration: 500 });
  const result = detector.process(spectrum({ carrier: null }), 4080);
  assert.equal(result.direction, 'still');
  assert.equal(result.activity, 0);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
});

test('uniform broadband change is rejected despite a pilot tone', () => {
  const frame = spectrum({ noise: -65 });
  const result = feed(makeCalibrated(), frame);
  assert.equal(result.direction, 'still');
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
});

test('guard band rejects small carrier-neighborhood variations', () => {
  const frame = spectrum({ toward: { shift: 12, db: -45 } });
  const result = feed(makeCalibrated(), frame);
  assert.equal(result.direction, 'still');
});

test('reset clears all motion, starts calibration, and sensitivity clamps', () => {
  const detector = makeCalibrated();
  feed(detector, spectrum({ toward: { shift: 150, db: -55 } }));
  detector.setSensitivity(99);
  assert.equal(detector.sensitivity, 2);
  detector.setSensitivity(0);
  assert.equal(detector.sensitivity, 0.5);
  detector.resetCalibration();
  const result = detector.process(spectrum(), 5000);
  assert.equal(result.calibrating, true);
  assert.equal(result.calibrationProgress, 0);
  assert.equal(result.direction, 'still');
  assert.equal(result.activity, 0);
  assert.deepEqual(estimateVelocity(result), { toward: null, away: null });
});

test('invalid configurations, wrong data size, and invalid times fail clearly', () => {
  assert.throws(() => new DopplerDetector({ ...options, sampleRate: 32000 }), /Nyquist/);
  assert.throws(() => new DopplerDetector({ ...options, fftSize: 8000 }), /power-of-two/);
  const detector = new DopplerDetector(options);
  assert.throws(() => detector.process(new Float32Array(32), 0), /frequency bins/);
  assert.throws(() => detector.process(spectrum(), NaN), /timestamp/);
});
