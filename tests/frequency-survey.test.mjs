import test from 'node:test';
import assert from 'node:assert/strict';
import { FrequencySurvey } from '../frequency-survey.js';

test('frequency trials exclude calibration, retain weak signals, and separate repeats', () => {
  const survey = new FrequencySurvey();
  survey.begin(19000, 8);
  const result = { calibrating: false, carrierDb: -84, noiseDb: -130, carrierSNR: 46, signalPresent: true };
  survey.observe({ ...result, calibrating: true }, 0);
  for (let i = 0; i < 5; i++) survey.observe({ ...result, carrierDb: [-85, -84, -84, -83, -20][i] }, 2000 + i * 1000);
  const [first] = survey.summaries();
  assert.equal(first.count, 5); assert.equal(first.seconds, 4);
  assert.equal(first.carrier, -84); assert.equal(first.spread, 1);
  survey.begin(16000, 8);
  survey.observe({ ...result, signalPresent: false, carrierDb: -110 }, 9000);
  survey.begin(19000, 8); survey.observe(result, 12000);
  assert.deepEqual(survey.summaries().map(row => row.frequency), [19000, 16000, 19000]);
  assert.equal(survey.summaries()[1].detected, 0);
});
