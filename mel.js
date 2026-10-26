// HTK Mel scale and triangular power filters. Normalize each filter by its
// weight sum so changing the display range does not change a flat noise floor.
export const hzToMel = hz => 2595 * Math.log10(1 + hz / 700);
export const melToHz = mel => 700 * (10 ** (mel / 2595) - 1);

export class MelFilterBank {
  constructor({ sampleRate, fftSize, minHz, maxHz, bands = 128 }) {
    if (!(sampleRate > 0 && fftSize > 0 && Number.isInteger(bands) && bands > 0 && minHz >= 0 && maxHz > minHz && maxHz <= sampleRate / 2)) {
      throw new RangeError('Invalid Mel filter bank configuration');
    }
    this.minHz = minHz;
    this.maxHz = maxHz;
    this.minMel = hzToMel(minHz);
    this.maxMel = hzToMel(maxHz);
    this.output = new Float32Array(bands);
    this.powers = new Float64Array(fftSize / 2);
    this.centers = new Float64Array(bands);
    const step = (this.maxMel - this.minMel) / (bands + 1);
    const binHz = sampleRate / fftSize;
    this.filters = Array.from({ length: bands }, (_, band) => {
      const left = this.minMel + band * step;
      const center = left + step;
      const right = center + step;
      this.centers[band] = melToHz(center);
      const weights = [];
      let total = 0;
      for (let bin = Math.ceil(melToHz(left) / binHz); bin <= Math.min(this.powers.length - 1, Math.floor(melToHz(right) / binHz)); bin++) {
        const mel = hzToMel(bin * binHz);
        const weight = Math.max(0, Math.min((mel - left) / step, (right - mel) / step));
        if (weight > 0) { weights.push([bin, weight]); total += weight; }
      }
      // Narrow filters below FFT resolution use the closest measured bin.
      if (!total) return [[Math.min(this.powers.length - 1, Math.round(this.centers[band] / binHz)), 1]];
      return weights.map(([bin, weight]) => [bin, weight / total]);
    });
  }

  process(spectrumDb) {
    if (spectrumDb.length !== this.powers.length) throw new RangeError('Unexpected FFT size');
    for (let i = 0; i < this.powers.length; i++) this.powers[i] = Number.isFinite(spectrumDb[i]) ? 10 ** (spectrumDb[i] / 10) : 0;
    this.filters.forEach((weights, band) => {
      let power = 0;
      for (const [bin, weight] of weights) power += this.powers[bin] * weight;
      this.output[band] = 10 * Math.log10(Math.max(1e-15, power));
    });
    return this.output;
  }
}

export const MEL_HISTORY_COLUMNS = 200;
export const MEL_COLUMN_MS = 50;

// Returns elapsed display slots, preserving real time through dropped frames.
export function historyAdvance(previous, now) {
  if (previous === null) return { columns: 1, time: now };
  const elapsed = Math.max(0, Math.floor((now - previous) / MEL_COLUMN_MS));
  return { columns: Math.min(MEL_HISTORY_COLUMNS, elapsed), time: previous + elapsed * MEL_COLUMN_MS };
}

// Fixed dB-to-intensity mapping: no auto normalization or gamma enhancement.
// Display gain changes only rendering, never the spectrum or detector input.
export function melColor(db, displayGain = 0) {
  const intensity = Math.max(0, Math.min(1, (db + displayGain + 140) / 60));
  const level = Math.round(255 * intensity);
  return [level, level, level];
}
