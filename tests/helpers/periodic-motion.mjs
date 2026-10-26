// Known symmetric hand motion with deliberately unequal reflected amplitudes.
export function periodicMotion(Detector, estimateVelocity, { carrierHz = 16000, towardDb = -76, awayDb = -82, cycles = 6 } = {}) {
  const sampleRate = 48000, fftSize = 8192, binHz = sampleRate / fftSize;
  const detector = new Detector({ sampleRate, fftSize, carrierHz });
  const step = 40, period = 1120;
  const data = new Float32Array(fftSize / 2);
  const spectrum = (velocity = null) => {
    for (let i = 0; i < data.length; i++) {
      let power = 10 ** (-130 / 10) + 10 ** (-50 / 10) * Math.exp(-.5 * ((i * binHz - carrierHz) / (binHz * .8)) ** 2);
      if (velocity !== null) {
        const shift = 2 * carrierHz * velocity / (343 - velocity);
        power += 10 ** ((velocity > 0 ? towardDb : awayDb) / 10) * Math.exp(-.5 * ((i * binHz - carrierHz - shift) / (binHz * 1.3)) ** 2);
      }
      data[i] = 10 * Math.log10(power);
    }
    return data;
  };
  for (let t = 0; t <= 2200; t += step) detector.process(spectrum(), t);
  const rows = [];
  for (let t = step; t <= cycles * period; t += step) {
    const truth = 1.8 * Math.sin(2 * Math.PI * t / period);
    const result = detector.process(spectrum(truth), 2200 + t);
    rows.push({ truth, result, velocity: estimateVelocity(result) });
  }
  const summary = {};
  for (const [side, sign] of [['toward', 1], ['away', -1]]) {
    // Exclude the explicit carrier guard zone, whose speed is unobservable.
    const expected = rows.filter(row => row.truth * sign > .6);
    const valid = expected.filter(row => Number.isFinite(row.velocity[side]));
    summary[side] = {
      coverage: valid.length / expected.length,
      meanError: valid.length ? valid.reduce((sum, row) => sum + Math.abs(row.velocity[side] - row.truth), 0) / valid.length : null,
      peak: Math.max(0, ...valid.map(row => Math.abs(row.velocity[side])))
    };
  }
  return { summary, rows, detector, spectrum, lastTime: 2200 + cycles * period };
}
