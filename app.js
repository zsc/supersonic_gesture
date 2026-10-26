import { DopplerDetector } from './doppler.js?v=noise-3';
import { SoundWaveAudio } from './audio-engine.js';
import { LiveMonitor } from './live-monitor.js?v=compact-3';
import { FrequencySurvey } from './frequency-survey.js';
import { estimateVelocity, velocityText } from './velocity.js?v=continuous-2';
import { SignalHistory, drawGestureHistory } from './signal-history.js?v=continuous-2';
import { MelFilterBank, hzToMel, melToHz, melColor, historyAdvance, MEL_HISTORY_COLUMNS } from './mel.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const ui = Object.fromEntries([
  'audio-toggle', 'simulation-toggle', 'session-description', 'mode-badge',
  'notice', 'spectrum', 'plot-label', 'carrier-chart', 'shift-value',
  'confidence-value', 'pilot-value', 'signal-dot', 'signal-status', 'sample-meta',
  'gesture-stage', 'hand-orb', 'gesture-direction', 'gesture-hint', 'gesture-symbol',
  'zoom-value', 'away-meter', 'toward-meter', 'sim-controls', 'real-instructions',
  'auto-demo', 'frequency', 'gain', 'sensitivity', 'frequency-output',
  'gain-output', 'sensitivity-output', 'recalibrate', 'announcement'
].map(id => [id, $(id)]));
const gestureButtons = [...document.querySelectorAll('[data-gesture]')];
const canvas = ui.spectrum;
const ctx = canvas.getContext('2d');
const waterfall = document.createElement('canvas');
waterfall.width = MEL_HISTORY_COLUMNS;
waterfall.height = 128;
const waterCtx = waterfall.getContext('2d', { willReadFrequently: true });
const waterImage = waterCtx.createImageData(waterfall.width, waterfall.height);
const history = new SignalHistory();
const survey = new FrequencySurvey();
let displayGain = 0;
const emptyData = new Float32Array(4096).fill(-130);
const simulationData = new Float32Array(4096);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const monitor = new LiveMonitor();

let mode = 'simulation';
let runToken = 0;
let detector = null;
let sampleRate = 48000;
let carrierHz = Number(ui.frequency.value);
let view = 'waterfall';
let melRange = 'ultrasonic';
let melBank;
let simStartedAt = performance.now();
let manualGesture = null;
let manualStartedAt = 0;
let currentResult = null;
let lastData = emptyData;
let zoom = 1;
let lastFrame = 0;
let lastUi = 0;
let lastWater = null;
let lastAnnouncement = '';
let frameId;
let plotWidth = 0;
let plotHeight = 0;
let pixelRatio = 1;

const audio = new SoundWaveAudio({
  onEnded(detail) {
    if (mode === 'real' || mode === 'starting') {
      stopSession(detail.message);
    }
  }
});

function notice(message = '', kind = 'info') {
  ui.notice.hidden = !message;
  ui.notice.textContent = message;
  ui.notice.dataset.kind = kind;
}

function announce(message) {
  if (message === lastAnnouncement) return;
  lastAnnouncement = message;
  ui.announcement.textContent = message;
}

function clearWaterfall() {
  waterCtx.fillStyle = '#000';
  waterCtx.fillRect(0, 0, waterfall.width, waterfall.height);
  lastWater = null;
  history.clear();
  melBank = new MelFilterBank({ sampleRate, fftSize: 8192,
    minHz: melRange === 'ultrasonic' ? carrierHz - 700 : 0,
    maxHz: melRange === 'ultrasonic' ? carrierHz + 700 : sampleRate / 2,
    bands: waterfall.height });
}

function makeDetector() {
  monitor.reset();
  if (mode === 'real') survey.begin(carrierHz, Number(ui.gain.value));
  detector = new DopplerDetector({
    sampleRate, fftSize: 8192, carrierHz,
    sensitivity: Number(ui.sensitivity.value)
  });
  currentResult = null;
  simStartedAt = performance.now();
  manualGesture = null;
  clearWaterfall();
  updateMode();
}

function updateMode() {
  document.body.dataset.mode = mode;
  monitor.setMode(mode);
  monitor.output(mode === 'real' && audio.active, carrierHz, Number(ui.gain.value) / 100);
  const isReal = mode === 'real';
  const starting = mode === 'starting';
  const sim = mode === 'simulation';
  const buttonText = isReal ? '停止检测' : starting ? '取消连接' : '开启真实检测';
  ui['audio-toggle'].innerHTML = `<svg><use href="#${isReal || starting ? 'i-stop' : 'i-mic'}"/></svg><span>${buttonText}</span>${isReal || starting ? '' : '<svg class="button-arrow"><use href="#i-arrow"/></svg>'}`;
  ui['audio-toggle'].dataset.live = String(isReal || starting);
  ui['simulation-toggle'].setAttribute('aria-pressed', String(sim));
  const labels = { simulation: '模拟模式', real: '真实检测', starting: '等待授权', stopped: '已停止' };
  ui['mode-badge'].innerHTML = `<span></span>${labels[mode]}`;
  ui['mode-badge'].dataset.mode = isReal ? 'real' : sim ? 'simulation' : 'stopped';
  ui['session-description'].textContent = sim
    ? '正在展示合成信号，无需麦克风。试试右侧的手势按钮。'
    : starting ? '请在浏览器提示中允许麦克风。也可以随时取消连接。'
    : isReal ? '扬声器正在发出高频单音。保持静止完成校准，再移动手掌。'
    : '发声与麦克风已停止。可以重新开始，或切换到模拟体验。';
  ui['plot-label'].textContent = sim ? 'SIMULATED SIGNAL' : isReal ? 'LIVE MICROPHONE' : 'NO INPUT';
  ui['sim-controls'].hidden = !sim;
  ui['real-instructions'].hidden = sim;
  ui.frequency.disabled = starting;
  ui.gain.disabled = starting;
  ui.recalibrate.disabled = !(sim || isReal);
  ui['carrier-chart'].textContent = `${(carrierHz / 1000).toFixed(2)} kHz`;
  ui['sample-meta'].textContent = `${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz · FFT 8192`;
  if (!(sim || isReal)) showInactive(starting);
}

function showInactive(starting = false) {
  ui['shift-value'].textContent = '—';
  $('velocity-value').textContent = '—';
  ui['confidence-value'].textContent = '—';
  ui['pilot-value'].textContent = '—';
  ui['gesture-direction'].textContent = starting ? '等待授权' : '检测已停止';
  ui['gesture-hint'].textContent = starting ? '请查看浏览器麦克风提示' : '点击开始，继续实验';
  ui['gesture-symbol'].textContent = starting ? '…' : 'Ⅱ';
  ui['signal-dot'].dataset.state = 'off';
  ui['signal-status'].textContent = starting ? '正在连接麦克风…' : '麦克风已释放 · 发声已停止';
  ui['gesture-stage'].dataset.direction = 'still';
  ui['toward-meter'].style.width = '0%';
  ui['away-meter'].style.width = '0%';
  gestureButtons.forEach(button => button.classList.remove('active'));
}

async function startReal() {
  const token = ++runToken;
  mode = 'starting';
  detector = null;
  currentResult = null;
  lastData = emptyData;
  clearWaterfall();
  notice();
  updateMode();
  announce('正在请求麦克风权限。');
  try {
    // start() resumes AudioContext and requests the microphone synchronously,
    // before awaiting permission, preserving the initiating click activation.
    const info = await audio.start({
      carrierHz: Number(ui.frequency.value), gain: Number(ui.gain.value) / 100,
      fftSize: 8192
    });
    if (token !== runToken) return;
    sampleRate = info.sampleRate;
    carrierHz = info.carrierHz;
    mode = 'real';
    makeDetector();
    const unreported = ['echoCancellation', 'noiseSuppression', 'autoGainControl']
      .filter(key => info.trackSettings[key] === undefined);
    if (unreported.length) {
      notice(`已请求关闭语音处理，但浏览器未报告 ${unreported.join(' / ')} 的实际状态；不能确认这些处理已关闭。`);
    }
    announce('真实检测已开启。请保持静止约两秒，完成环境校准。');
  } catch (error) {
    if (token !== runToken || error.code === 'ABORTED') return;
    void audio.stop();
    mode = 'stopped';
    detector = null;
    updateMode();
    notice(error.message || '无法启动音频，请检查浏览器权限。', 'error');
    announce('音频连接失败，可以查看提示或使用模拟模式。');
  }
}

function stopSession(message = '') {
  ++runToken;
  void audio.stop();
  mode = 'stopped';
  detector = null;
  currentResult = null;
  lastData = emptyData;
  clearWaterfall();
  updateMode();
  notice(message);
  announce('发声与麦克风已停止。');
}

function startSimulation() {
  ++runToken;
  void audio.stop();
  mode = 'simulation';
  sampleRate = 48000;
  carrierHz = Number(ui.frequency.value);
  lastData = emptyData;
  notice();
  makeDetector();
  announce('已进入模拟模式。所有图表均来自合成信号，不使用麦克风。');
}

function recalibrate() {
  if (!detector) return;
  makeDetector();
  announce(mode === 'real' ? '正在重新校准，请保持手和设备静止约两秒。' : '正在重新建立模拟基线。');
}

// Generate FFT-shaped synthetic spectra, then pass them through the exact same
// detector as microphone data. This path never instantiates an AudioContext.
function simulationSpectrum(now) {
  simulationData.fill(-125);
  const binHz = sampleRate / 8192;
  const center = carrierHz / binHz;
  const start = Math.max(0, Math.floor(center - 760 / binHz));
  const end = Math.min(simulationData.length - 1, Math.ceil(center + 760 / binHz));
  const age = now - simStartedAt;
  let gesture = 'still';
  let phase = 0;
  if (age > 2300 && detector?.baselineReady) {
    if (manualGesture && now - manualStartedAt < 2300) {
      gesture = manualGesture;
      phase = (now - manualStartedAt) / 2300;
    } else if (ui['auto-demo'].checked) {
      const cycle = ((age - 2300) / 1000) % 11;
      if (cycle >= .5 && cycle < 3) { gesture = 'toward'; phase = (cycle - .5) / 2.5; }
      else if (cycle >= 4 && cycle < 6.5) { gesture = 'away'; phase = (cycle - 4) / 2.5; }
      else if (cycle >= 8 && cycle < 9.5) { gesture = 'mixed'; phase = (cycle - 8) / 1.5; }
    }
  }
  const envelope = gesture === 'still' ? 0 : Math.min(1, phase * 8, (1 - phase) * 8);
  const shift = 85 + 85 * Math.sin(phase * Math.PI);
  const amplitude = 10 ** (-36 / 10) * (Number(ui.gain.value) / 8) ** 2;
  for (let i = start; i <= end; i++) {
    const noise = 10 ** ((-103 + 1.8 * Math.sin(i * 1.79) + .7 * Math.sin(now / 180 + i)) / 10);
    let power = noise + amplitude * Math.exp(-.5 * ((i - center) / .82) ** 2);
    const sideAmplitude = amplitude * .0028 * envelope;
    if (gesture === 'toward' || gesture === 'mixed') {
      power += sideAmplitude * Math.exp(-.5 * ((i - center - shift / binHz) / 2.8) ** 2);
    }
    if (gesture === 'away' || gesture === 'mixed') {
      power += sideAmplitude * Math.exp(-.5 * ((i - center + shift / binHz) / 2.8) ** 2);
    }
    simulationData[i] = 10 * Math.log10(power);
  }
  return simulationData;
}

function renderReadings(result) {
  const calibrating = result.calibrating;
  const signal = result.signalPresent;
  const active = !calibrating && signal;
  const direction = active ? result.direction : 'still';
  const directions = {
    toward: ['正在靠近', '正频移 · 观察上侧带', '↗'],
    away: ['正在远离', '负频移 · 观察下侧带', '↙'],
    mixed: ['双向变化', '两侧均有变化', '↔'],
    still: ['未确认手势', '速度由有效侧带独立估计', '·']
  };
  let [label, hint, symbol] = directions[direction];
  if (calibrating) {
    label = '环境校准中';
    hint = `保持静止 · ${Math.min(99, Math.round(result.calibrationProgress * 100))}%`;
    symbol = '◌';
  } else if (!signal) {
    label = '等待载频';
    hint = '请检查扬声器与发射频率';
    symbol = '…';
  }
  ui['gesture-direction'].textContent = label;
  ui['gesture-hint'].textContent = hint;
  ui['gesture-symbol'].textContent = symbol;
  ui['gesture-stage'].dataset.direction = direction;
  const measuredShifts = [result.velocityShifts?.toward, result.velocityShifts?.away].filter(Number.isFinite);
  ui['shift-value'].textContent = !calibrating && signal && measuredShifts.length
    ? measuredShifts.map(shift => `${shift > 0 ? '+' : ''}${Math.round(shift)}`).join(' / ') : '—';
  ui['confidence-value'].textContent = active && direction !== 'still'
    ? `${Math.round(result.confidence * 100)}` : '—';
  $('velocity-value').textContent = velocityText(estimateVelocity(result));
  ui['pilot-value'].textContent = result.carrierDb > -130 ? Math.round(result.carrierDb) : '—';
  ui['toward-meter'].style.width = `${result.towardEnergy * 100}%`;
  ui['away-meter'].style.width = `${result.awayEnergy * 100}%`;
  ui['zoom-value'].textContent = `${Math.round(zoom * 100)}%`;
  gestureButtons.forEach(button => {
    button.classList.toggle('active', button.dataset.gesture === direction);
    button.disabled = calibrating;
  });
  ui['signal-dot'].dataset.state = calibrating ? 'pending' : signal ? 'ok' : 'pending';
  ui['signal-status'].textContent = calibrating
    ? `${mode === 'simulation' ? '建立模拟基线' : '请保持静止，校准环境'} · 约 2 秒`
    : signal ? `${mode === 'simulation' ? '模拟信号就绪' : '载频已检测'} · 分辨率 ${result.binHz.toFixed(1)} Hz`
    : '载频较弱 · 检查音量或尝试 18–19 kHz 后重新校准';
  if (active) announce(`${mode === 'simulation' ? '模拟' : '检测'}：${label}`);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const height = Math.max(1, rect.height);
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (width !== plotWidth || height !== plotHeight || ratio !== pixelRatio) {
    plotWidth = width;
    plotHeight = height;
    pixelRatio = ratio;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
}

function drawChart(data) {
  resizeCanvas();
  if (view === 'waterfall') { drawMelChart(); return; }
  const w = plotWidth, h = plotHeight;
  const left = 36, right = w - 9, top = 17, bottom = h - 29;
  const pw = right - left, ph = bottom - top;
  const x = shift => left + (shift + 700) / 1400 * pw;
  const y = db => top + (1 - clamp((db + 110) / 85)) * ph;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fcfcf8';
  ctx.fillRect(left, top, pw / 2, ph);
  ctx.fillStyle = '#f7faf5';
  ctx.fillRect(x(0), top, pw / 2, ph);
  ctx.lineWidth = 1;
  ctx.font = '8px SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#a9b1a1';
  for (const db of [-30, -50, -70, -90, -110]) {
    const yy = y(db);
    ctx.strokeStyle = '#eaf0e4';
    ctx.beginPath();ctx.moveTo(left, yy);ctx.lineTo(right, yy);ctx.stroke();
    if (view === 'spectrum') ctx.fillText(String(db), left - 8, yy + 3);
  }
  ctx.textAlign = 'center';
  for (const shift of [-600, -300, 0, 300, 600]) {
    const xx = x(shift);
    ctx.strokeStyle = '#eaf0e4';
    ctx.beginPath();ctx.moveTo(xx, top);ctx.lineTo(xx, bottom);ctx.stroke();
    ctx.fillStyle = shift === 0 ? '#5d7d55' : '#a6b09b';
    ctx.fillText(((carrierHz + shift) / 1000).toFixed(1), xx, bottom + 17);
  }
  ctx.textAlign = 'left';
  ctx.fillStyle = '#a4af97';
  ctx.fillText('dBFS', 1, 9);
  ctx.textAlign = 'right';
  ctx.fillText('kHz', right + 2, h - 1);
  const guard = detector?.guardHz || 35;
  ctx.fillStyle = '#d5dfcb55';
  ctx.fillRect(x(-guard), top, x(guard) - x(-guard), ph);
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = '#9caf88';
  ctx.beginPath();ctx.moveTo(x(0), top);ctx.lineTo(x(0), bottom);ctx.stroke();
  ctx.setLineDash([]);
  if (view === 'spectrum') {
    const binHz = sampleRate / 8192;
    const first = Math.ceil((carrierHz - 700) / binHz);
    const last = Math.floor((carrierHz + 700) / binHz);
    const points = [];
    for (let i = first; i <= last; i++) {
      points.push([x(i * binHz - carrierHz), y(Number.isFinite(data[i]) ? data[i] : -130)]);
    }
    ctx.save();
    ctx.beginPath();ctx.rect(left, top, pw, ph);ctx.clip();
    const fill = ctx.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, '#91b17877');fill.addColorStop(1, '#91b17808');
    ctx.fillStyle = fill;
    ctx.beginPath();ctx.moveTo(points[0][0], bottom);
    points.forEach(([xx, yy]) => ctx.lineTo(xx, yy));
    ctx.lineTo(points[points.length - 1][0], bottom);ctx.closePath();ctx.fill();
    ctx.beginPath();points.forEach(([xx, yy], i) => i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy));
    ctx.lineWidth = 1.65;ctx.strokeStyle = '#6c9563';ctx.stroke();
    ctx.restore();
    if (currentResult?.direction === 'toward' || currentResult?.direction === 'away') {
      const xx = x(currentResult.shiftHz);
      ctx.fillStyle = currentResult.direction === 'toward' ? '#458367' : '#bd885a';
      ctx.beginPath();ctx.moveTo(xx - 3, top + 1);ctx.lineTo(xx + 3, top + 1);ctx.lineTo(xx, top + 6);ctx.closePath();ctx.fill();
    }
  }
  ctx.fillStyle = '#68855a';
  ctx.font = '8px SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('f₀', x(0), top - 6);
}

function drawMelChart() {
  const w = plotWidth, h = plotHeight;
  const left = 43, right = w - 12, top = 17, bottom = h - 9;
  const pw = Math.max(1, right - left), ph = Math.max(1, bottom - top);
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000'; ctx.fillRect(left, top, pw, ph);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(waterfall, left, top, pw, ph);
  ctx.imageSmoothingEnabled = true;
  const y = hz => bottom - (hzToMel(hz) - melBank.minMel) / (melBank.maxMel - melBank.minMel) * ph;
  ctx.font = '9px SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const hz = melToHz(melBank.minMel + i / 4 * (melBank.maxMel - melBank.minMel));
    const yy = y(hz);
    ctx.strokeStyle = '#ffffff15'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = '#526759'; ctx.fillText((hz / 1000).toFixed(1), left - 6, yy + 3);
  }
  for (const seconds of [10, 5, 0]) {
    const xx = right - seconds / 10 * pw;
    ctx.strokeStyle = '#ffffff15'; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke();
    ctx.textAlign = seconds === 10 ? 'left' : seconds === 0 ? 'right' : 'center';

  }
  ctx.setLineDash([3, 4]); ctx.strokeStyle = '#ffffff40';
  ctx.beginPath(); ctx.moveTo(left, y(carrierHz)); ctx.lineTo(right, y(carrierHz)); ctx.stroke(); ctx.setLineDash([]);
  ctx.textAlign = 'right'; ctx.fillStyle = '#b9c0c5';
  ctx.fillText(`f₀ ${(carrierHz / 1000).toFixed(2)}`, right - 4, Math.max(top + 10, y(carrierHz) - 5));
  ctx.textAlign = 'left'; ctx.fillStyle = '#526759'; ctx.fillText('kHz · Mel', 0, 10);
}

function paintWaterfall() {
  for (let col = 0; col < waterfall.width; col++) {
    const sample = history.samples[col];
    for (let row = 0; row < waterfall.height; row++) {
      const color = sample ? melColor(sample.bands[waterfall.height - 1 - row], displayGain) : [0, 0, 0];
      const index = (row * waterfall.width + col) * 4;
      waterImage.data[index] = color[0];
      waterImage.data[index + 1] = color[1];
      waterImage.data[index + 2] = color[2];
      waterImage.data[index + 3] = 255;
    }
  }
  waterCtx.putImageData(waterImage, 0, 0);

}

function pushWaterfall(data, now) {
  const advance = historyAdvance(lastWater, now);
  if (!advance.columns) return;
  lastWater = advance.time;
  const bands = melBank.process(data);
  history.push(bands, currentResult, advance.columns);
  paintWaterfall();
}

function updateChartView() {
  ['spectrum', 'waterfall'].forEach(item => {
    $(`view-${item}`).classList.toggle('selected', item === view);
    $(`view-${item}`).setAttribute('aria-pressed', String(item === view));
  });
  $('mel-options').hidden = view !== 'waterfall';
  $('signal-subfigure-label').textContent = view === 'waterfall' ? 'a · Mel 时频' : 'a · 当前 FFT 频谱（横轴为频率）';
  canvas.parentElement.dataset.view = view;
  canvas.setAttribute('aria-label', view === 'waterfall'
    ? 'Mel 时频图：纵轴为 Mel 频率刻度，横轴为最近十秒，新数据从右侧进入并向左滚动'
    : '载频附近正负 700 Hz 范围的 FFT 频谱图');
  $('plot-meta').hidden = view === 'waterfall';
}

function frame(now) {
  frameId = requestAnimationFrame(frame);
  if (now - lastFrame < 1000 / 30 || document.hidden) return;
  const dt = Math.min(.1, (now - lastFrame) / 1000);
  lastFrame = now;
  try {
    const data = mode === 'simulation' ? simulationSpectrum(now) : mode === 'real' ? audio.readSpectrum() : null;
    if (data && detector) {
      lastData = data;
      currentResult = detector.process(data, now);
      monitor.sample(currentResult, now);
      pushWaterfall(data, now);
      if (!currentResult.calibrating && currentResult.signalPresent) {
        const d = currentResult.direction === 'toward' ? 1 : currentResult.direction === 'away' ? -1 : 0;
        zoom = clamp(zoom + d * dt * .12 * currentResult.confidence, .65, 1.4);
      }
      ui['hand-orb'].style.transform = `scale(${reducedMotion ? 1 : zoom})`;
      if (now - lastUi > 100) {
        if (mode === 'real') {
          survey.observe(currentResult, now);
          $('frequency-survey-body').innerHTML = survey.summaries().map(row => `<tr><td>${(row.frequency / 1000).toFixed(1)} kHz / ${row.gain}%</td><td>${row.seconds.toFixed(1)} s (${row.count})</td><td>${row.carrier.toFixed(1)}</td><td>${row.noise.toFixed(1)}</td><td>${row.snr.toFixed(1)}</td><td>${row.spread.toFixed(1)} dB</td><td>${Math.round(row.detected * 100)}%</td></tr>`).join('');
        }
        renderReadings(currentResult);
        monitor.render(currentResult, mode === 'real' ? audio.readInput() : null, now);
        monitor.output(mode === 'real' && audio.active, carrierHz, Number(ui.gain.value) / 100);
        lastUi = now;
      }
    }
    drawChart(lastData);
    drawGestureHistory($('gesture-history-chart'), history.samples, carrierHz);
  } catch (error) {
    stopSession('当前音频分析出现问题，已停止发声与采集。请重新开始，或切换到模拟体验。');
    console.error('SoundWave processing stopped:', error);
  }
}

ui['audio-toggle'].addEventListener('click', () => {
  if (mode === 'real' || mode === 'starting') stopSession();
  else void startReal();
});
ui['simulation-toggle'].addEventListener('click', startSimulation);
ui.recalibrate.addEventListener('click', recalibrate);
$('reset-zoom').addEventListener('click', () => {
  zoom = 1;
  ui['hand-orb'].style.transform = 'scale(1)';
  ui['zoom-value'].textContent = '100%';
});

function triggerGesture(gesture) {
  if (mode !== 'simulation' || currentResult?.calibrating) return;
  ui['auto-demo'].checked = false;
  manualGesture = gesture;
  manualStartedAt = performance.now();
}
gestureButtons.forEach(button => button.addEventListener('click', () => triggerGesture(button.dataset.gesture)));
ui['auto-demo'].addEventListener('change', () => { manualGesture = null; });

ui.frequency.addEventListener('input', () => {
  ui['frequency-output'].innerHTML = `${Number(ui.frequency.value).toLocaleString('en-US')} <span>Hz</span>`;
});
ui.frequency.addEventListener('change', () => {
  try {
    const value = Number(ui.frequency.value);
    carrierHz = mode === 'real' ? audio.setCarrier(value) : value;
    if (detector) recalibrate();
    updateMode();
  } catch (error) {
    ui.frequency.value = carrierHz;
    ui.frequency.dispatchEvent(new Event('input'));
    notice(error.message, 'error');
  }
});
ui.gain.addEventListener('input', () => {
  ui['gain-output'].innerHTML = `${ui.gain.value} <span>%</span>`;
});
ui.gain.addEventListener('change', () => {
  try {
    if (mode === 'real') audio.setGain(Number(ui.gain.value) / 100);
    recalibrate();
  } catch (error) { notice(error.message, 'error'); }
});
ui.sensitivity.addEventListener('input', () => {
  ui['sensitivity-output'].innerHTML = `${Number(ui.sensitivity.value).toFixed(1)} <span>×</span>`;
  detector?.setSensitivity(Number(ui.sensitivity.value));
});

['spectrum', 'waterfall'].forEach(name => {
  $(`view-${name}`).addEventListener('click', () => { view = name; updateChartView(); });
});
$('mel-display-gain').addEventListener('input', event => {
  displayGain = Number(event.target.value);
  $('mel-gain-value').textContent = `${displayGain >= 0 ? '+' : ''}${displayGain} dB`;
  paintWaterfall();
});
$('mel-range').addEventListener('change', event => {
  melRange = event.target.value;
  clearWaterfall();
  announce('已切换 Mel 频段，重新积累十秒历史。');
});
document.addEventListener('keydown', event => {
  if (/^(INPUT|BUTTON|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.altKey || event.ctrlKey || event.metaKey) return;
  if (mode === 'simulation' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    triggerGesture(event.key === 'ArrowLeft' ? 'away' : 'toward');
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && (mode === 'real' || mode === 'starting')) {
    stopSession('页面已进入后台，发声与麦克风已自动停止。返回后请点击「开启真实检测」。');
  }
  if (!document.hidden && mode === 'simulation') clearWaterfall();
});
window.addEventListener('pagehide', () => {
  if (mode === 'real' || mode === 'starting') stopSession();
  cancelAnimationFrame(frameId);
});
window.addEventListener('pageshow', event => {
  if (event.persisted) {
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(frame);
  }
});

new ResizeObserver(resizeCanvas).observe(canvas);
makeDetector();
updateChartView();
frameId = requestAnimationFrame(frame);

$('open-diagnostics').addEventListener('click', () => $('diagnostics-dialog').showModal());
$('close-diagnostics').addEventListener('click', () => $('diagnostics-dialog').close());
