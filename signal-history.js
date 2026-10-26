import { MEL_HISTORY_COLUMNS } from './mel.js';
import { estimateVelocity, shiftToVelocity } from './velocity.js?v=continuous-2';

// Both plots share these slots. Missing observations stay blank, and mutable
// analyser/filter buffers are copied so later frames cannot rewrite history.
export class SignalHistory {
  constructor() { this.clear(); }
  clear() { this.samples = Array(MEL_HISTORY_COLUMNS).fill(null); }
  push(bands, result, columns) {
    if (columns <= 0) return;
    const count = Math.min(MEL_HISTORY_COLUMNS, columns);
    this.samples.splice(0, count);
    this.samples.push(...Array(count - 1).fill(null), {
      bands: Float32Array.from(bands),
      state: result.calibrating ? 'calibrating' : !result.signalPresent ? 'absent' : result.direction,
      confidence: result.confidence,
      velocity: estimateVelocity(result)
    });
  }
}

const stateSymbols = { toward: '↑', away: '↓', mixed: '↕', still: '·', absent: '×', calibrating: '◌' };

export function drawGestureHistory(canvas, samples, carrierHz = 16000) {
  const { width: w, height: h } = canvas.getBoundingClientRect();
  const ratio = Math.min(devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
    canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
  }
  const ctx = canvas.getContext('2d');
  const left = 43, right = w - 12, top = 17, bottom = h - 26;
  const curveBottom = bottom - 23;
  const pw = Math.max(1, right - left), ph = Math.max(1, curveBottom - top);
  // A fixed scale for each carrier covers the full +/-700 Hz detection band.
  const limit = Math.ceil(Math.max(Math.abs(shiftToVelocity(-700, carrierHz)), shiftToVelocity(700, carrierHz)));
  const y = velocity => top + (limit - velocity) / (2 * limit) * ph;
  const x = index => left + (index + .5) / samples.length * pw;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#000'; ctx.fillRect(left, top, pw, bottom - top);
  ctx.font = '9px SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'right';
  for (const v of [limit, limit / 2, 0, -limit / 2, -limit]) {
    const yy = y(v);
    ctx.strokeStyle = v === 0 ? '#ffffff70' : '#ffffff20';
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke();
    ctx.fillStyle = '#526759'; ctx.fillText(`${v > 0 ? '+' : ''}${v}`, left - 5, yy + 3);
  }
  // Invalid peaks, calibration and missing observations break the curve.
  // Mixed motion retains two branches; it is never averaged to zero.
  for (const branch of ['toward', 'away']) {
    ctx.strokeStyle = '#f3f5f6'; ctx.fillStyle = '#f3f5f6'; ctx.lineWidth = 1.4;
    ctx.beginPath();
    let previous = null;
    samples.forEach((sample, index) => {
      const value = sample?.velocity[branch];
      if (!Number.isFinite(value)) { previous = null; return; }
      const xx = x(index), yy = y(value);
      if (previous === null) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      ctx.fillRect(xx - 1, yy - 1, 2, 2);
      previous = value;
    });
    ctx.stroke();
  }
  // Direction strip retains the categorical history alongside the speed curve.
  const stripTop = curveBottom + 6;
  ctx.textAlign = 'right'; ctx.fillStyle = '#526759'; ctx.fillText('状态', left - 5, stripTop + 11);
  let runStart = 0;
  const drawRun = (start, end, state) => {
    if (!state) return;
    const xx = left + start / samples.length * pw, width = (end - start) / samples.length * pw;
    ctx.fillStyle = state === 'still' ? '#ffffff15' : '#ffffff35';
    ctx.fillRect(xx, stripTop, Math.max(.5, width - 1), 15);
    if (width >= 9) {
      ctx.fillStyle = '#e2e7e9'; ctx.textAlign = 'center';
      ctx.fillText(stateSymbols[state], xx + width / 2, stripTop + 11);
    }
  };
  for (let i = 1; i <= samples.length; i++) {
    if (i === samples.length || samples[i]?.state !== samples[runStart]?.state) {
      drawRun(runStart, i, samples[runStart]?.state); runStart = i;
    }
  }
  for (const seconds of [10, 5, 0]) {
    const xx = right - seconds / 10 * pw;
    ctx.strokeStyle = '#ffffff20'; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bottom); ctx.stroke();
    ctx.textAlign = seconds === 10 ? 'left' : seconds === 0 ? 'right' : 'center';
    ctx.fillStyle = '#526759'; ctx.fillText(seconds ? `−${seconds} s` : '现在', xx, bottom + 17);
  }
  ctx.textAlign = 'left'; ctx.fillStyle = '#526759'; ctx.fillText('m/s · 等效径向速度', 0, 10);
}
