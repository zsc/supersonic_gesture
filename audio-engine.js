/**
 * Speaker and microphone lifecycle for the SoundWave browser experiment.
 * The microphone graph is deliberately separate from the emitted pilot tone.
 * AnalyserNode works without connecting its output to the destination.
 */
export class SoundWaveAudioError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'SoundWaveAudioError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

const aborted = () => new SoundWaveAudioError('ABORTED', '音频启动已取消。');
const clampGain = (value) => {
  if (!Number.isFinite(Number(value))) {
    throw new SoundWaveAudioError('INVALID_GAIN', '发声音量必须是有效数字。');
  }
  return Math.min(0.25, Math.max(0.01, Number(value)));
};

function friendlyError(error) {
  if (error instanceof SoundWaveAudioError) return error;
  if (error?.name === 'OverconstrainedError' &&
      ['echoCancellation', 'noiseSuppression', 'autoGainControl'].includes(error.constraint)) {
    return new SoundWaveAudioError('AUDIO_PROCESSING_REQUIRED',
      `当前设备无法关闭 ${error.constraint}，未启动发声。请换用支持关闭语音处理的麦克风。`, error);
  }
  const messages = {
    NotAllowedError: ['MICROPHONE_PERMISSION', '麦克风权限未获允许。请在浏览器地址栏允许麦克风，然后重新开始；嵌入页面可能需要在新标签页打开。'],
    SecurityError: ['MICROPHONE_PERMISSION', '当前页面无法访问麦克风。请通过 HTTPS 打开完整页面，并检查浏览器的麦克风权限。'],
    NotFoundError: ['MICROPHONE_NOT_FOUND', '没有找到麦克风。请连接或启用麦克风，再重新开始。'],
    NotReadableError: ['MICROPHONE_BUSY', '麦克风暂时无法读取。请检查系统权限，或关闭正在独占麦克风的其他应用。'],
    OverconstrainedError: ['MICROPHONE_CONSTRAINTS', '当前麦克风不支持所需的音频配置。请尝试设备内置麦克风。'],
    AbortError: ['AUDIO_ABORTED', '浏览器中断了音频请求，请重新开始。'],
  };
  const [code, message] = messages[error?.name] || ['AUDIO_ERROR', '音频启动失败。请检查扬声器与麦克风设置，然后重新开始。'];
  return new SoundWaveAudioError(code, message, error);
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
  }
}

/**
 * start() must be called directly from a user action. It requests audio only.
 * onStateChange receives a context state string. onEnded receives {code,message}.
 * A cancelled start rejects with code ABORTED; a late permission grant is released.
 */
export class SoundWaveAudio {
  constructor({ onEnded, onStateChange } = {}) {
    this._onEnded = onEnded;
    this._onStateChange = onStateChange;
    this._session = null;
    this._generation = 0;
  }

  get active() {
    const session = this._session;
    return Boolean(session?.started && !session.closing && session.context.state === 'running');
  }

  get info() {
    const info = this._session?.info;
    return info ? { ...info, trackSettings: { ...info.trackSettings } } : null;
  }

  _isCurrent(session) {
    return this._session === session && this._generation === session.generation && !session.closing;
  }

  _emit(callback, value) {
    if (typeof callback === 'function') {
      try { callback(value); } catch { /* UI callbacks must not prevent cleanup. */ }
    }
  }

  _validateCarrier(hz, sampleRate) {
    const frequency = Number(hz);
    if (!Number.isFinite(frequency) || frequency < 16000 || frequency > 21000) {
      throw new SoundWaveAudioError('INVALID_FREQUENCY', '载频需在 16–21 kHz 之间。');
    }
    // Keep both ±700 Hz detector sidebands plus a small edge margin available.
    if (frequency + 900 >= sampleRate / 2) {
      throw new SoundWaveAudioError('SAMPLE_RATE_TOO_LOW', `当前音频采样率为 ${(sampleRate / 1000).toFixed(1)} kHz，无法完整分析此载频。请调低载频，或使用支持 44.1 / 48 kHz 的音频设备。`);
    }
    return frequency;
  }

  async start({ carrierHz = 20000, gain = 0.08, fftSize = 8192 } = {}) {
    const generation = ++this._generation;
    const previous = this._session;
    this._session = null;
    void this._dispose(previous);

    if (globalThis.isSecureContext === false) {
      throw new SoundWaveAudioError('INSECURE_CONTEXT', '麦克风需要安全连接。请使用 HTTPS 页面（例如 GitHub Pages），或通过 localhost 运行。');
    }
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    const mediaDevices = globalThis.navigator?.mediaDevices;
    if (!AudioContextClass || !mediaDevices?.getUserMedia) {
      throw new SoundWaveAudioError('UNSUPPORTED_BROWSER', '此浏览器无法使用 Web Audio 或麦克风接口。请通过 HTTPS 在支持这些接口的浏览器中打开。');
    }
    if (!Number.isInteger(fftSize) || fftSize < 32 || fftSize > 32768 || (fftSize & (fftSize - 1))) {
      throw new SoundWaveAudioError('INVALID_FFT', 'FFT 长度必须为 32–32768 之间的 2 的整数次幂。');
    }
    const outputGain = clampGain(gain);
    let session;
    try {
      const context = new AudioContextClass({ latencyHint: 'interactive' });
      session = {
        generation, context, stream: null, source: null, analyser: null,
        oscillator: null, gainNode: null, data: null, info: null,
        started: false, closing: false, trackHandlers: [],
      };
      session.cancelled = new Promise((resolve) => { session.cancel = resolve; });
      this._session = session;
      const frequency = this._validateCarrier(carrierHz, context.sampleRate);
      session.stateHandler = () => {
        if (!this._isCurrent(session)) return;
        this._emit(this._onStateChange, context.state);
        if (session.started && ['suspended', 'interrupted', 'closed'].includes(context.state)) {
          this._unexpectedEnd(session, {
            code: 'AUDIO_INTERRUPTED',
            message: '音频已被浏览器或系统暂停，发声和麦克风已停止。点击开始可重新校准。',
          });
        }
      };
      context.addEventListener('statechange', session.stateHandler);

      // Invoke resume while the initiating click still carries user activation.
      // Promise.all handles either rejection immediately; a cancelled permission
      // request may resolve later, in which case its tracks are stopped below.
      const resumePromise = Promise.resolve(context.resume()).catch((error) => {
        throw new SoundWaveAudioError('AUDIO_START', '浏览器未能启动音频。请点击开始按钮重试，并检查当前标签页是否允许播放声音。', error);
      });
      let request;
      try {
        request = mediaDevices.getUserMedia({
          audio: {
            echoCancellation: { exact: false },
            noiseSuppression: { exact: false },
            autoGainControl: { exact: false },
            channelCount: { ideal: 1 },
            sampleRate: { ideal: 48000 },
          },
          video: false,
        });
      } catch (error) { request = Promise.reject(error); }
      const microphonePromise = Promise.resolve(request).then((stream) => {
        if (!this._isCurrent(session)) {
          stopTracks(stream);
          throw aborted();
        }
        session.stream = stream;
        return stream;
      });
      await Promise.race([
        Promise.all([resumePromise, microphonePromise]),
        session.cancelled.then(() => { throw aborted(); }),
      ]);
      if (!this._isCurrent(session)) throw aborted();
      if (context.state !== 'running') {
        throw new SoundWaveAudioError('AUDIO_START', '音频仍处于暂停状态，请返回此页面并再次点击开始。');
      }
      const track = session.stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') {
        throw new SoundWaveAudioError('MICROPHONE_ENDED', '麦克风连接已结束，请重新开始。');
      }
      const trackSettings = { ...(track.getSettings?.() || {}) };
      const enabledProcessing = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
        .filter(key => trackSettings[key] !== undefined && trackSettings[key] !== false);
      if (enabledProcessing.length) {
        throw new SoundWaveAudioError('AUDIO_PROCESSING_ENABLED',
          `浏览器仍报告启用了 ${enabledProcessing.join(' / ')}，已取消启动，避免把经过语音处理的信号用于实验。`);
      }
      for (const audioTrack of session.stream.getAudioTracks()) {
        const handler = () => this._unexpectedEnd(session, {
          code: 'MICROPHONE_ENDED',
          message: '麦克风连接已断开或权限已撤销，发声已停止。请检查设备后重新开始。',
        });
        audioTrack.addEventListener('ended', handler);
        session.trackHandlers.push([audioTrack, handler]);
      }

      session.analyser = context.createAnalyser();
      session.analyser.fftSize = fftSize;
      session.analyser.smoothingTimeConstant = 0.25;
      session.analyser.minDecibels = -115;
      session.analyser.maxDecibels = -15;
      session.data = new Float32Array(session.analyser.frequencyBinCount);
      session.waveform = new Float32Array(fftSize);
      session.source = context.createMediaStreamSource(session.stream);
      session.source.connect(session.analyser);

      session.oscillator = context.createOscillator();
      session.oscillator.type = 'sine';
      session.oscillator.frequency.setValueAtTime(frequency, context.currentTime);
      session.gainNode = context.createGain();
      session.gainNode.gain.setValueAtTime(0, context.currentTime);
      session.oscillator.connect(session.gainNode);
      session.gainNode.connect(context.destination);
      session.oscillator.start();
      session.gainNode.gain.linearRampToValueAtTime(outputGain, context.currentTime + 0.06);
      session.info = {
        sampleRate: context.sampleRate,
        fftSize,
        carrierHz: frequency,
        trackSettings,
        deviceLabel: track.label || '默认麦克风',
      };
      session.started = true;
      return this.info;
    } catch (error) {
      const stale = generation !== this._generation;
      if (this._session === session) this._session = null;
      await this._dispose(session);
      throw stale ? aborted() : friendlyError(error);
    }
  }

  /** Reuses one array; consumers should copy only when retaining past frames. */
  readSpectrum() {
    const session = this._session;
    if (!this.active) return null;
    session.analyser.getFloatFrequencyData(session.data);
    return session.data;
  }

  /** Real microphone samples only; the returned waveform is reused each read. */
  readInput() {
    if (!this.active) return null;
    const session = this._session;
    session.analyser.getFloatTimeDomainData(session.waveform);
    let sum = 0, peak = 0;
    for (const value of session.waveform) {
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const rms = Math.sqrt(sum / session.waveform.length);
    const track = session.stream.getAudioTracks()[0];
    return {
      waveform: session.waveform, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
      peak, muted: Boolean(track.muted), deviceLabel: session.info.deviceLabel,
      trackSettings: { ...(track.getSettings?.() || {}) },
      sampleRate: session.context.sampleRate,
    };
  }

  setCarrier(hz) {
    const session = this._session;
    if (!this.active) throw new SoundWaveAudioError('NOT_ACTIVE', '请先启动真实检测。');
    const frequency = this._validateCarrier(hz, session.context.sampleRate);
    const now = session.context.currentTime;
    session.oscillator.frequency.cancelScheduledValues(now);
    session.oscillator.frequency.setValueAtTime(frequency, now);
    session.info.carrierHz = frequency;
    return frequency;
  }

  setGain(value) {
    const gain = clampGain(value);
    const session = this._session;
    if (!this.active) throw new SoundWaveAudioError('NOT_ACTIVE', '请先启动真实检测。');
    const now = session.context.currentTime;
    session.gainNode.gain.cancelScheduledValues(now);
    session.gainNode.gain.setTargetAtTime(gain, now, 0.025);
    return gain;
  }

  _unexpectedEnd(session, detail) {
    if (!this._isCurrent(session)) return;
    ++this._generation;
    this._session = null;
    void this._dispose(session);
    this._emit(this._onEnded, detail);
  }

  async stop() {
    ++this._generation;
    const session = this._session;
    this._session = null;
    await this._dispose(session);
  }

  _dispose(session) {
    if (!session) return Promise.resolve();
    if (session.closing) return session.cleanupPromise || Promise.resolve();
    session.closing = true;
    session.started = false;
    session.cancel?.();
    const context = session.context;
    context?.removeEventListener('statechange', session.stateHandler);
    for (const [track, handler] of session.trackHandlers) track.removeEventListener('ended', handler);
    session.trackHandlers.length = 0;
    // Silence immediately before closing the context; do not wait for promises.
    try {
      session.gainNode?.gain.cancelScheduledValues(context.currentTime);
      session.gainNode?.gain.setValueAtTime(0, context.currentTime);
    } catch { /* Some browsers reject parameter writes on a closed context. */ }
    try { session.oscillator?.stop(); } catch { /* It may already be stopped. */ }
    for (const node of [session.source, session.analyser, session.oscillator, session.gainNode]) {
      try { node?.disconnect(); } catch { /* Release the remaining graph anyway. */ }
    }
    stopTracks(session.stream);
    session.stream = null;
    session.info = null;
    try {
      session.cleanupPromise = context && context.state !== 'closed'
        ? Promise.resolve(context.close()).catch(() => {}) : Promise.resolve();
    } catch { session.cleanupPromise = Promise.resolve(); }
    return session.cleanupPromise;
  }
}
