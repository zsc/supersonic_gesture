import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SoundWaveAudio } from '../audio-engine.js';

class FakeParam {
  value = 0;
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}
class FakeNode {
  connections = [];
  connect(node) { this.connections.push(node); return node; }
  disconnect() { this.disconnected = true; }
}
class FakeOscillator extends FakeNode {
  frequency = new FakeParam();
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  get frequencyBinCount() { return this.fftSize / 2; }
  getFloatFrequencyData(target) { target.fill(-90); }
  getFloatTimeDomainData(target) { target.fill(this.inputAmplitude ?? 0); }
}
class FakeTrack extends EventTarget {
  readyState = 'live';
  label = 'Test microphone';
  stop() { this.readyState = 'ended'; this.stopCount = (this.stopCount || 0) + 1; }
  getSettings() { return { echoCancellation: false, sampleRate: 48000 }; }
  externalEnd() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}
class FakeContext extends EventTarget {
  static instances = [];
  static nextSampleRate = 48000;
  static resumeError = null;
  state = 'suspended';
  currentTime = 0;
  destination = new FakeNode();
  constructor() { super(); this.sampleRate = FakeContext.nextSampleRate; FakeContext.instances.push(this); }
  resume() {
    if (FakeContext.resumeError) return Promise.reject(FakeContext.resumeError);
    this.state = 'running'; this.dispatchEvent(new Event('statechange')); return Promise.resolve();
  }
  close() { this.state = 'closed'; this.dispatchEvent(new Event('statechange')); return Promise.resolve(); }
  createAnalyser() { return this.analyser = new FakeAnalyser(); }
  createMediaStreamSource() { return this.source = new FakeNode(); }
  createOscillator() { return this.oscillator = new FakeOscillator(); }
  createGain() { this.gainNode = new FakeNode(); this.gainNode.gain = new FakeParam(); return this.gainNode; }
}
const stream = () => { const track = new FakeTrack(); return { track, getTracks: () => [track], getAudioTracks: () => [track] }; };
const deferred = () => { let resolve; let reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const originals = new Map();
let requests;
let microphone;
beforeEach(() => {
  for (const key of ['navigator', 'AudioContext', 'isSecureContext']) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  requests = []; microphone = stream();
  FakeContext.instances = []; FakeContext.nextSampleRate = 48000; FakeContext.resumeError = null;
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: FakeContext });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: (constraints) => { requests.push(constraints); return Promise.resolve(microphone); } } } });
});
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

test('live capture analyzes only microphone; stop releases the entire graph', async () => {
  const audio = new SoundWaveAudio();
  const info = await audio.start();
  const context = FakeContext.instances[0];
  assert.equal(info.sampleRate, 48000);
  assert.equal(info.fftSize, 8192);
  assert.equal(info.carrierHz, 20000);
  assert.equal(info.deviceLabel, 'Test microphone');
  assert.deepEqual(context.source.connections, [context.analyser]);
  assert.deepEqual(context.analyser.connections, []);
  assert.deepEqual(context.oscillator.connections, [context.gainNode]);
  assert.deepEqual(context.gainNode.connections, [context.destination]);
  assert.deepEqual(requests[0].audio.echoCancellation, { exact: false });
  assert.deepEqual(requests[0].audio.noiseSuppression, { exact: false });
  assert.deepEqual(requests[0].audio.autoGainControl, { exact: false });
  assert.equal(requests[0].video, false);
  assert.equal(audio.active, true);
  const samples = audio.readSpectrum();
  assert.equal(samples.length, 4096);
  assert.strictEqual(samples, audio.readSpectrum());
  assert.equal(samples[0], -90);
  info.trackSettings.echoCancellation = true;
  assert.equal(audio.info.trackSettings.echoCancellation, false);
  await audio.stop();
  await audio.stop();
  assert.equal(audio.active, false);
  assert.equal(audio.readSpectrum(), null);
  assert.equal(audio.info, null);
  assert.equal(context.gainNode.gain.value, 0);
  assert.equal(context.oscillator.stopped, true);
  assert.equal(microphone.track.stopCount, 1);
  assert.equal(context.state, 'closed');
});

test('cancel while permission is pending rejects promptly and stops a later grant', async () => {
  const pending = deferred();
  navigator.mediaDevices.getUserMedia = () => pending.promise;
  const audio = new SoundWaveAudio();
  const starting = audio.start();
  const rejected = assert.rejects(starting, { code: 'ABORTED' });
  await audio.stop();
  await rejected;
  pending.resolve(microphone);
  await Promise.resolve();
  assert.equal(microphone.track.readyState, 'ended');
  assert.equal(audio.active, false);
});

test('input monitor measures microphone RMS and peak, reports mute, and clears after stop', async () => {
  const audio = new SoundWaveAudio();
  assert.equal(audio.readInput(), null);
  await audio.start();
  const context = FakeContext.instances[0];
  context.analyser.inputAmplitude = .25;
  const input = audio.readInput();
  assert.ok(Math.abs(input.rmsDb - (-12.0412)) < .0001);
  assert.equal(input.peak, .25);
  assert.equal(input.waveform.length, 8192);
  assert.equal(input.deviceLabel, 'Test microphone');
  assert.equal(input.sampleRate, 48000);
  assert.equal(input.muted, false);
  assert.equal(input.trackSettings.echoCancellation, false);
  // Monitor must observe input, not the independently emitted pilot gain.
  audio.setGain(.25);
  context.analyser.inputAmplitude = 0;
  microphone.track.muted = true;
  const silent = audio.readInput();
  assert.strictEqual(silent.waveform, input.waveform);
  assert.equal(silent.rmsDb, -Infinity);
  assert.equal(silent.peak, 0);
  assert.equal(silent.muted, true);
  await audio.stop();
  assert.equal(audio.readInput(), null);
});

test('an old permission result never stops or replaces the newer session', async () => {
  const first = deferred();
  const second = deferred();
  const oldStream = stream();
  const newStream = stream();
  const queue = [first, second];
  navigator.mediaDevices.getUserMedia = () => queue.shift().promise;
  const audio = new SoundWaveAudio();
  const firstStart = audio.start();
  const firstRejected = assert.rejects(firstStart, { code: 'ABORTED' });
  const secondStart = audio.start();
  second.resolve(newStream);
  await secondStart;
  first.resolve(oldStream);
  await firstRejected;
  await Promise.resolve();
  assert.equal(oldStream.track.readyState, 'ended');
  assert.equal(newStream.track.readyState, 'live');
  assert.equal(FakeContext.instances[1].state, 'running');
  assert.equal(audio.active, true);
  await audio.stop();
});

test('permission denial closes context and emits a useful error', async () => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  const audio = new SoundWaveAudio();
  await assert.rejects(audio.start(), { code: 'MICROPHONE_PERMISSION' });
  assert.equal(FakeContext.instances[0].state, 'closed');
  assert.equal(audio.active, false);
});

test('unsupported sample rate fails before requesting the microphone', async () => {
  FakeContext.nextSampleRate = 32000;
  const audio = new SoundWaveAudio();
  await assert.rejects(audio.start(), { code: 'SAMPLE_RATE_TOO_LOW' });
  assert.equal(requests.length, 0);
  assert.equal(FakeContext.instances[0].state, 'closed');
});

test('reported AEC or voice processing prevents emission and releases capture', async () => {
  for (const [key, value] of [['echoCancellation', true], ['echoCancellation', 'all'], ['noiseSuppression', true], ['autoGainControl', true]]) {
    microphone = stream();
    microphone.track.getSettings = () => ({ [key]: value });
    const audio = new SoundWaveAudio();
    await assert.rejects(audio.start(), { code: 'AUDIO_PROCESSING_ENABLED' });
    const context = FakeContext.instances.at(-1);
    assert.equal(context.oscillator, undefined);
    assert.equal(context.state, 'closed');
    assert.equal(microphone.track.readyState, 'ended');
  }
});

test('unsupported raw capture explains the exact failing constraint without fallback', async () => {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('unsupported'), {
    name: 'OverconstrainedError', constraint: 'echoCancellation',
  }));
  const audio = new SoundWaveAudio();
  await assert.rejects(audio.start(), { code: 'AUDIO_PROCESSING_REQUIRED', message: /echoCancellation/ });
  assert.equal(FakeContext.instances.length, 1);
  assert.equal(FakeContext.instances[0].state, 'closed');
});

test('gain is bounded and the whole sideband must fit below Nyquist', async () => {
  FakeContext.nextSampleRate = 43500;
  const audio = new SoundWaveAudio();
  await audio.start();
  assert.equal(audio.setGain(1), 0.25);
  assert.equal(audio.setGain(0), 0.01);
  assert.equal(audio.setCarrier(16000), 16000);
  assert.throws(() => audio.setCarrier(15900), { code: 'INVALID_FREQUENCY' });
  assert.equal(audio.setCarrier(19000), 19000);
  assert.equal(audio.info.carrierHz, 19000);
  assert.throws(() => audio.setCarrier(21000), { code: 'SAMPLE_RATE_TOO_LOW' });
  assert.equal(audio.info.carrierHz, 19000);
  await audio.stop();
});

test('external track termination shuts off the speaker and notifies the UI', async () => {
  const ended = [];
  const audio = new SoundWaveAudio({ onEnded: (detail) => ended.push(detail) });
  await audio.start();
  microphone.track.externalEnd();
  assert.equal(audio.active, false);
  assert.equal(FakeContext.instances[0].oscillator.stopped, true);
  assert.equal(ended[0].code, 'MICROPHONE_ENDED');
  assert.equal(FakeContext.instances[0].state, 'closed');
});

test('system suspension silences the output and requires explicit restart', async () => {
  const states = [];
  const ended = [];
  const audio = new SoundWaveAudio({ onStateChange: (state) => states.push(state), onEnded: (detail) => ended.push(detail) });
  await audio.start();
  const context = FakeContext.instances[0];
  context.state = 'suspended';
  context.dispatchEvent(new Event('statechange'));
  assert.equal(audio.active, false);
  assert.equal(context.gainNode.gain.value, 0);
  assert.equal(microphone.track.readyState, 'ended');
  assert.equal(ended[0].code, 'AUDIO_INTERRUPTED');
  assert.deepEqual(states, ['running', 'suspended']);
});

test('resume failure also disposes a microphone granted afterwards', async () => {
  FakeContext.resumeError = new Error('audio blocked');
  const pending = deferred();
  navigator.mediaDevices.getUserMedia = () => pending.promise;
  const audio = new SoundWaveAudio();
  await assert.rejects(audio.start(), { code: 'AUDIO_START' });
  pending.resolve(microphone);
  await Promise.resolve();
  assert.equal(microphone.track.readyState, 'ended');
  assert.equal(FakeContext.instances[0].state, 'closed');
});
