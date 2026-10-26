export const noisyOptions = { sampleRate: 48000, fftSize: 8192, carrierHz: 16000 };
export function noisySpectrum({ humpHz = null, humpWidth = 55, humpDb = -72, reflectionHz = null, reflectionDb = -65, noiseDb = -130 } = {}) {
  const bins = new Float32Array(4096), binHz = 48000 / 8192;
  for (let i = 0; i < bins.length; i++) {
    const offset = i * binHz - 16000;
    let power = 10 ** (noiseDb / 10) + 10 ** (-50 / 10) * Math.exp(-.5 * (offset / (binHz * .8)) ** 2);
    if (humpHz !== null) power += 10 ** (humpDb / 10) * Math.exp(-.5 * ((offset - humpHz) / humpWidth) ** 2);
    if (reflectionHz !== null) power += 10 ** (reflectionDb / 10) * Math.exp(-.5 * ((offset - reflectionHz) / (binHz * 1.4)) ** 2);
    bins[i] = 10 * Math.log10(power);
  }
  return bins;
}
export function calibratedNoiseDetector(Detector) {
  const detector = new Detector(noisyOptions);
  for (let t = 0; t <= 2200; t += 40) detector.process(noisySpectrum(), t);
  return detector;
}
