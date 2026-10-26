import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSignal } from '../live-monitor.js';

const ready = { calibrating: false, signalPresent: true, direction: 'still' };
const input = { rmsDb: -30, peak: .2, muted: false };

test('audible input and ultrasonic reception are diagnosed independently', () => {
  assert.match(describeSignal('real', ready, input)[1], /采集正常/);
  assert.match(describeSignal('real', { ...ready, signalPresent: false }, input)[1], /有声音输入，但未检测到有效载频/);
  assert.match(describeSignal('real', ready, { ...input, rmsDb: -Infinity })[1], /输入电平很低/);
  assert.match(describeSignal('real', ready, { ...input, peak: 1 })[1], /削波/);
});

test('simulation, permission wait and stopped state never claim live microphone success', () => {
  assert.match(describeSignal('simulation', ready, null)[1], /模拟/);
  assert.match(describeSignal('starting', ready, input)[1], /等待麦克风授权/);
  assert.match(describeSignal('stopped', ready, input)[1], /检测已停止/);
});

test('muted or missing capture cannot show a successful gesture from an old result', () => {
  const moving = { ...ready, direction: 'toward' };
  assert.equal(describeSignal('real', moving, null)[0], 'warning');
  assert.equal(describeSignal('real', moving, { ...input, muted: true })[0], 'warning');
  assert.match(describeSignal('real', { ...moving, calibrating: true }, input)[1], /正在校准/);
  assert.match(describeSignal('real', moving, input)[1], /靠近/);
});
