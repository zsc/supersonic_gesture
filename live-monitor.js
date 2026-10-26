const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const directions = { toward: '靠近 ↗', away: '远离 ↙', mixed: '双向变化 ↔' };

// Diagnose capture separately from ultrasonic reception: audible sound alone
// does not prove that the speaker → reflection → microphone path is working.
export function describeSignal(mode, result, input) {
  if (mode === 'starting') return ['pending', '等待麦克风授权', '请查看浏览器的权限提示；允许后开始采集。'];
  if (mode === 'stopped') return ['idle', '检测已停止', '麦克风和发声已关闭，点击「开启真实检测」重新开始。'];
  if (mode === 'real' && input?.muted) return ['warning', '麦克风暂时没有提供音频', '设备已连接，但输入被系统或浏览器静音。请检查输入设备。'];
  if (!result) return ['pending', '等待第一帧数据', '正在连接分析通道…'];
  if (mode === 'real' && !input) return ['warning', '未收到麦克风数据', '音频通道可能已中断，请停止后重新开启。'];
  if (result.calibrating) return ['pending', '正在校准背景', '请保持静止约 2 秒，校准完成后再移动手掌。'];
  if (mode === 'simulation') return ['simulation', '模拟分析正在运行', '当前反馈来自合成信号。点击「开启真实检测」才能验证设备和真实手势。'];
  if (input.rmsDb < -85) return ['warning', '输入电平很低', '检查麦克风是否被静音、输入设备是否正确；输入电平可帮助确认声音输入。'];
  if (!result.signalPresent) return ['warning', '有声音输入，但未检测到有效载频', '确认声音从扬声器播放；尝试将发射频率降至 18–19 kHz，然后重新校准。'];
  if (input.peak >= .99) return ['warning', '输入接近削波', '请降低系统麦克风输入增益或扬声器音量，然后重新校准。'];
  if (result.noiseRejected && result.direction === 'still') return ['warning', '非孤立谱峰已拒绝', '发现较宽或低突出度的频谱变化，已从检测中剔除；原始 Mel 仍保留这些信号。'];
  if (result.direction !== 'still') return ['ok', `检测到${directions[result.direction] || '运动'}`, '麦克风、载频与方向分析均有反馈；观察频移和最近识别记录。'];
  return ['ok', '采集正常 · 载频已检测', '尚无明确运动。请在扬声器与麦克风附近将手掌推近、拉远。'];
}

export class LiveMonitor {
  constructor() {
    this.ui = Object.fromEntries(['source', 'verdict', 'status', 'help', 'input', 'level', 'device', 'processing', 'output', 'output-detail',
      'carrier', 'carrier-detail', 'calibration', 'progress', 'rate', 'frames', 'age',
      'interference', 'history'].map(id => [id, document.getElementById(`monitor-${id}`)]));
    this.mode = 'simulation';
    this.reset();
    // A separate clock exposes stalled analysis instead of leaving a green
    // status and old readings on screen when no new samples arrive.
    this.timer = setInterval(() => this.checkFreshness(), 500);
  }

  text(id, value) {
    if (this.ui[id].textContent !== value) this.ui[id].textContent = value;
  }

  reset() {
    this.frames = 0;
    this.lastSample = null;
    this.windowStart = null;
    this.windowFrames = 0;
    this.rate = 0;
    this.previousDirection = 'still';
    this.events = [];
    this.ui.history.replaceChildren();
    const item = document.createElement('li');
    item.textContent = '等待校准后移动手掌';
    this.ui.history.append(item);
  }

  setMode(mode) {
    if (this.mode !== mode) this.reset();
    this.mode = mode;
    this.text('source', mode === 'simulation' ? '模拟 · 未发声' : mode === 'real' ? '真实采集' : '未采集');
    this.render(null, null, performance.now());
  }

  sample(result, now) {
    this.frames++;
    this.lastSample = now;
    if (this.windowStart === null) this.windowStart = now;
    this.windowFrames++;
    if (now - this.windowStart >= 1000) {
      this.rate = this.windowFrames * 1000 / (now - this.windowStart);
      this.windowStart = now;
      this.windowFrames = 0;
    }
    const direction = !result.calibrating && result.signalPresent ? result.direction : 'still';
    if (direction !== this.previousDirection && directions[direction]) {
      this.events.unshift({ direction, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), shift: result.shiftHz });
      this.events.length = Math.min(4, this.events.length);
      this.ui.history.replaceChildren(...this.events.map(event => {
        const item = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = event.time;
        const label = document.createElement('span');
        label.textContent = `${this.mode === 'simulation' ? '模拟 · ' : ''}${directions[event.direction]}`;
        const shift = document.createElement('b');
        shift.textContent = event.direction === 'mixed' ? '双侧' : `${event.shift >= 0 ? '+' : ''}${Math.round(event.shift)} Hz`;
        item.append(time, label, shift);
        return item;
      }));
    }
    this.previousDirection = direction;
  }

  verdict(state, title, help) {
    this.ui.verdict.dataset.state = state;
    this.text('status', title);
    this.text('help', help);
    this.ui.status.title = help;
  }

  output(active, hz, gain) {
    this.text('output', active ? `${(hz / 1000).toFixed(1)}k · ${Math.round(gain * 100)}%` : '未发声');
    this.text('output-detail', active ? `${(hz / 1000).toFixed(2)} kHz · 数字增益 ${Math.round(gain * 100)}%` : this.mode === 'simulation' ? '模拟模式不启用扬声器' : '高频音源已关闭');
  }

  render(result, input, now) {
    this.verdict(...describeSignal(this.mode, result, input));
    this.text('input', input ? input.muted ? '输入已静音' : `${Number.isFinite(input.rmsDb) ? input.rmsDb.toFixed(1) : '−∞'} dBFS` : this.mode === 'simulation' ? '未使用' : this.mode === 'starting' ? '等待授权' : this.mode === 'real' ? '等待数据' : '已关闭');
    this.ui.level.style.width = `${input && !input.muted ? clamp((input.rmsDb + 85) / 85 * 100, 0, 100) : 0}%`;
    this.text('device', input ? input.deviceLabel : this.mode === 'simulation' ? '模拟模式不采集声音' : '麦克风尚未提供输入');
    this.text('processing', input ? [['AEC', 'echoCancellation'], ['NS', 'noiseSuppression'], ['AGC', 'autoGainControl']]
      .map(([label, key]) => `${label}：${input.trackSettings?.[key] === false ? '关闭' : input.trackSettings?.[key] === true ? '开启' : '未报告'}`).join(' · ')
      : 'AEC / NS / AGC：未采集');
    this.text('carrier', result ? `${Math.round(result.carrierDb)} dBFS` : '—');
    this.text('carrier-detail', result ? `SNR ${result.carrierSNR.toFixed(0)} dB` : '等待频谱数据');
    const progress = result ? result.calibrating ? Math.min(99, Math.round(result.calibrationProgress * 100)) : 100 : 0;
    this.text('calibration', result ? progress === 100 ? '已完成' : `${progress}% · 保持静止` : '等待数据');
    this.ui.progress.value = progress;
    this.text('rate', this.lastSample !== null ? this.rate ? `${Math.round(this.rate)} 帧/秒` : '正在接收' : '等待数据');
    this.text('frames', `已分析 ${this.frames.toLocaleString('zh-CN')} 帧`);
    this.text('age', this.lastSample === null ? '尚未收到数据' : `最近更新 ${Math.max(0, Math.round(now - this.lastSample))} ms 前`);
    this.text('interference', result && !result.calibrating ? result.noiseRejected ? '已拒绝干扰' : '正常' : '等待数据');
  }

  checkFreshness() {
    if (!['real', 'simulation'].includes(this.mode)) return;
    if (document.hidden) {
      this.text('rate', '页面在后台');
      this.verdict('idle', '页面在后台 · 分析暂停', '返回页面后查看新的数据。真实检测需手动重新开启。');
      return;
    }
    if (this.lastSample === null) return;
    const age = performance.now() - this.lastSample;
    if (age > 1500) {
      this.text('rate', '更新中断');
      this.text('age', `最近更新 ${(age / 1000).toFixed(1)} 秒前`);
      this.verdict('warning', '暂未收到新的分析数据', '下方读数为上次结果。请停止后重新开启检测。');
      this.ui.level.style.width = '0%';
    }
  }

}
