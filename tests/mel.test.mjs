import test from 'node:test';
import assert from 'node:assert/strict';
import { MelFilterBank, hzToMel, melToHz, historyAdvance, melColor } from '../mel.js';

const bank = (minHz = 19300, maxHz = 20700) => new MelFilterBank({ sampleRate: 48000, fftSize: 8192, minHz, maxHz });

test('Mel mapping is invertible and compresses high frequencies', () => {
  for (const hz of [0, 1000, 19000, 24000]) assert.ok(Math.abs(melToHz(hzToMel(hz)) - hz) < 1e-8);
  assert.ok(hzToMel(20000) - hzToMel(19000) < hzToMel(2000) - hzToMel(1000));
});

test('normalized Mel powers preserve a flat floor and reject absent samples', () => {
  for (const b of [bank(), bank(0, 24000)]) {
    const data = new Float32Array(4096).fill(-80);
    assert.ok(b.process(data).every(value => Math.abs(value + 80) < .0001));
    data.fill(-Infinity);
    assert.ok(b.process(data).every(value => value === -150));
  }
});

test('ultrasonic Mel bands distinguish carrier and positive and negative sidebands', () => {
  const b = bank();
  const peaks = [];
  for (const frequency of [19850, 20000, 20150]) {
    const data = new Float32Array(4096).fill(-120);
    data[Math.round(frequency / (48000 / 8192))] = -30;
    const result = b.process(data);
    const peak = result.indexOf(Math.max(...result));
    peaks.push(peak);
    assert.ok(Math.abs(b.centers[peak] - frequency) < 20);
  }
  assert.ok(peaks[0] < peaks[1] && peaks[1] < peaks[2]);
});

test('history advances with elapsed time, including gaps and full ten-second expiry', () => {
  assert.deepEqual(historyAdvance(null, 1000), { columns: 1, time: 1000 });
  assert.deepEqual(historyAdvance(1000, 1049), { columns: 0, time: 1000 });
  assert.deepEqual(historyAdvance(1000, 1155), { columns: 3, time: 1150 });
  assert.deepEqual(historyAdvance(1000, 12000), { columns: 200, time: 12000 });
});

test('display colors saturate at the legend bounds', () => {
  assert.deepEqual(melColor(-150), melColor(-140));
  assert.deepEqual(melColor(0), melColor(-80));
});
