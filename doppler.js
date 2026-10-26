/**
 * A small, SoundWave-inspired detector for AnalyserNode.getFloatFrequencyData().
 * Positive frequency shifts mean motion toward the speaker/microphone pair.
 *
 * This is an educational browser adaptation, not the paper's original algorithm:
 * it uses a stationary background estimate and sideband energy rather than the
 * paper's two-pass bandwidth scan. Confidence is a heuristic, not a probability.
 * Reference: Gupta et al., CHI 2012, DOI: 10.1145/2207676.2208331.
 */
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const powerAt = (data, index) => {
  const db = data[index];
  return Number.isFinite(db) ? Math.pow(10, clamp(db, -150, 20) / 10) : 0;
};

export class DopplerDetector {
  constructor({ sampleRate, fftSize, carrierHz = 20000, sensitivity = 1 }) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 ||
        !Number.isInteger(fftSize) || fftSize < 2048 ||
        (fftSize & (fftSize - 1)) !== 0) {
      throw new RangeError('A positive sample rate and a power-of-two FFT size ≥ 2048 are required.');
    }
    if (!Number.isFinite(carrierHz) || carrierHz < 1000 || carrierHz + 750 >= sampleRate / 2) {
      throw new RangeError('The carrier must leave at least 750 Hz below the Nyquist frequency.');
    }
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.carrierHz = carrierHz;
    this.binHz = sampleRate / fftSize;
    this.centerBin = Math.round(carrierHz / this.binHz);
    this.guardHz = Math.max(35, this.binHz * 3);
    this.lowerBin = Math.ceil((carrierHz - 700) / this.binHz);
    this.upperBin = Math.floor((carrierHz + 700) / this.binHz);
    this.lowerHz = this.lowerBin * this.binHz;
    this.upperHz = this.upperBin * this.binHz;
    this.baseline = new Float64Array(fftSize / 2);
    this.excess = new Float64Array(fftSize / 2);
    this.setSensitivity(sensitivity);
    this.resetCalibration();
  }

  setSensitivity(value) {
    this.sensitivity = clamp(Number.isFinite(Number(value)) ? Number(value) : 1, 0.5, 2);
  }

  resetCalibration() {
    this.baseline.fill(0);
    this.excess.fill(0);
    this.startedAt = null;
    this.lastTimestamp = null;
    this.calibrationWeight = 0;
    this.baselineReady = false;
    this.smoothToward = 0;
    this.smoothAway = 0;
    this.towardShift = 0;
    this.awayShift = 0;
    this.velocityTowardShift = null;
    this.velocityAwayShift = null;
    this.direction = 'still';
    this.candidate = 'still';
    this.candidateSince = 0;
  }

  /**
   * Process a complete FFT array (fftSize / 2 dB bins) at a monotonic timestamp.
   * Energies/activity/confidence are normalized to 0..1, not physical units.
   * shiftHz is the dominant excess peak centroid; it is zero for still/mixed.
   * The UI may show an equivalent radial velocity, explicitly uncalibrated.
   * Returns {calibrating, calibrationProgress, baselineReady, direction,
   * shiftHz, confidence, towardEnergy, awayEnergy, activity, carrierDb,
   * signalPresent, lowerHz, upperHz, noiseDb, carrierSNR, guardHz, binHz}.
   */
  process(dbData, timestampMs) {
    if (!dbData || dbData.length < this.fftSize / 2) {
      throw new RangeError('FFT data must contain fftSize / 2 frequency bins.');
    }
    if (!Number.isFinite(timestampMs)) throw new TypeError('A finite timestamp in milliseconds is required.');
    const now = Math.max(timestampMs, this.lastTimestamp ?? timestampMs);
    const dt = this.lastTimestamp === null ? 16.67 : clamp(now - this.lastTimestamp, 0, 150);
    this.lastTimestamp = now;
    if (this.startedAt === null) this.startedAt = now;
    const elapsed = now - this.startedAt;

    // A clear pilot at the expected frequency is required. A broad noise burst
    // has no such isolated peak and must not be labeled as a hand gesture.
    let carrierPower = 0;
    for (let i = this.centerBin - 2; i <= this.centerBin + 2; i++) {
      carrierPower = Math.max(carrierPower, powerAt(dbData, i));
    }
    const floorSamples = [];
    for (let i = this.lowerBin; i <= this.upperBin; i++) {
      if (Math.abs(i * this.binHz - this.carrierHz) > 120) floorSamples.push(powerAt(dbData, i));
    }
    floorSamples.sort((a, b) => a - b);
    const floorPower = Math.max(1e-15, floorSamples[Math.floor(floorSamples.length / 2)] || 0);
    const carrierDb = 10 * Math.log10(Math.max(1e-15, carrierPower));
    const noiseDb = 10 * Math.log10(floorPower);
    const carrierSNR = carrierDb - noiseDb;
    const signalPresent = carrierDb > -95 && carrierSNR >= 12;

    // Let the analyser settle for 200 ms, then learn ~1.8 s of stationary audio.
    // Time weighting prevents higher frame rates from changing the estimate.
    if (!this.baselineReady) {
      if (elapsed >= 200 && dt > 0) {
        this.calibrationWeight += dt;
        const weight = dt / this.calibrationWeight;
        for (let i = this.lowerBin; i <= this.upperBin; i++) {
          this.baseline[i] += weight * (powerAt(dbData, i) - this.baseline[i]);
        }
      }
      this.baselineReady = elapsed >= 2000 && this.calibrationWeight >= 1000;
      return this.result({ carrierDb, noiseDb, carrierSNR, signalPresent, elapsed });
    }

    if (!signalPresent) {
      this.smoothToward = this.smoothAway = 0;
      this.velocityTowardShift = this.velocityAwayShift = null;
      this.direction = this.candidate = 'still';
      this.candidateSince = now;
      return this.result({ carrierDb, noiseDb, carrierSNR, signalPresent, elapsed });
    }

    let toward = { energy: 0, noise: 0, peak: 0, peakBin: 0 };
    let away = { energy: 0, noise: 0, peak: 0, peakBin: 0 };
    const binNoiseFactor = 4 / Math.sqrt(this.sensitivity);
    for (let i = this.lowerBin; i <= this.upperBin; i++) {
      const shift = i * this.binHz - this.carrierHz;
      this.excess[i] = 0;
      if (Math.abs(shift) < this.guardHz) continue;
      const side = shift > 0 ? toward : away;
      const background = Math.max(this.baseline[i], floorPower * 0.2);
      side.noise += background;
      const power = powerAt(dbData, i);
      // Require a per-bin rise over the stationary baseline as well as a
      // minimum relative level. This excludes isolated numerical/noise specks.
      const excess = power > background * binNoiseFactor ?
        Math.max(0, power - background * 1.8) : 0;
      if (excess < carrierPower * 0.000002 / this.sensitivity) continue;
      this.excess[i] = excess;
      side.energy += excess;
      if (excess > side.peak) { side.peak = excess; side.peakBin = i; }
    }

    const measure = side => {
      const threshold = Math.max(
        carrierPower * 0.0007,
        side.noise * 0.20,
        2e-11
      ) / this.sensitivity;
      let cluster = 0;
      let weightedShift = 0;
      let clusterBackground = 0;
      if (side.peak > 0) {
        for (let i = Math.max(this.lowerBin, side.peakBin - 2);
             i <= Math.min(this.upperBin, side.peakBin + 2); i++) {
          const offset = i * this.binHz - this.carrierHz;
          if (Math.abs(offset) < this.guardHz || Math.sign(offset) !== Math.sign(side.peakBin * this.binHz - this.carrierHz)) continue;
          clusterBackground += Math.max(this.baseline[i], floorPower * .2);
          cluster += this.excess[i];
          weightedShift += this.excess[i] * (i * this.binHz - this.carrierHz);
        }
      }
      // Localized shifted peaks are more credible than broadband transients.
      const localized = cluster >= side.energy * 0.075;
      return {
        ratio: localized ? side.energy / threshold : 0,
        shift: cluster > 0 ? weightedShift / cluster : 0,
        // Velocity is a spectral measurement, not a debounced gesture label.
        // Use the same local peak-quality rule on each side. Requiring enough
        // concentrated excess rejects broad bursts without the classifier's
        // whole-side energy threshold or its 140 ms persistence gate.
        velocityValid: cluster > side.energy * .15 && cluster > Math.max(
          clusterBackground * 3, carrierPower * .00002, 2e-13
        ) / this.sensitivity
      };
    };
    toward = measure(toward);
    away = measure(away);
    const velocityAlpha = 1 - Math.exp(-dt / 45);
    const updateVelocity = (previous, measurement) => !measurement.velocityValid ? null :
      previous === null || dt >= 150 ? measurement.shift : previous + velocityAlpha * (measurement.shift - previous);
    // A lost side is cleared immediately. Reacquisition starts at the new
    // measurement instead of mixing in the previous half-cycle's last speed.
    this.velocityTowardShift = updateVelocity(this.velocityTowardShift, toward);
    this.velocityAwayShift = updateVelocity(this.velocityAwayShift, away);
    const alpha = 1 - Math.exp(-dt / 70);
    this.smoothToward += alpha * (toward.ratio - this.smoothToward);
    this.smoothAway += alpha * (away.ratio - this.smoothAway);
    if (toward.shift) this.towardShift += alpha * (toward.shift - this.towardShift);
    if (away.shift) this.awayShift += alpha * (away.shift - this.awayShift);

    // Schmitt-style release threshold and a time-based persistence gate reduce
    // flicker. Both strong sides means mixed motion, not a known two-hand pose.
    const threshold = this.direction === 'still' ? 1 : 0.65;
    const high = Math.max(this.smoothToward, this.smoothAway);
    const low = Math.min(this.smoothToward, this.smoothAway);
    let candidate = 'still';
    if (high >= threshold) {
      candidate = low >= threshold && low / high > 0.28 ? 'mixed' :
        this.smoothToward > this.smoothAway ? 'toward' : 'away';
    }
    if (candidate !== this.candidate) {
      this.candidate = candidate;
      this.candidateSince = now;
    }
    if (now - this.candidateSince >= (candidate === 'still' ? 170 : 140)) {
      this.direction = candidate;
    }

    // Slowly follow a changing room only while genuinely inactive. Active
    // reflections are never learned away. Explicit recalibration remains best
    // after changing volume, frequency, or the speaker/microphone arrangement.
    if (candidate === 'still' && this.direction === 'still') {
      const adaptation = 1 - Math.exp(-dt / 20000);
      for (let i = this.lowerBin; i <= this.upperBin; i++) {
        this.baseline[i] += adaptation * (powerAt(dbData, i) - this.baseline[i]);
      }
    }
    return this.result({ carrierDb, noiseDb, carrierSNR, signalPresent, elapsed });
  }

  result({ carrierDb, noiseDb, carrierSNR, signalPresent, elapsed }) {
    const towardEnergy = 1 - Math.exp(-this.smoothToward / 3);
    const awayEnergy = 1 - Math.exp(-this.smoothAway / 3);
    const active = this.baselineReady && signalPresent && this.direction !== 'still';
    let confidence = 0;
    if (active) {
      const quality = clamp((carrierSNR - 10) / 20);
      const strongest = Math.max(towardEnergy, awayEnergy);
      const weakest = Math.min(towardEnergy, awayEnergy);
      confidence = this.direction === 'mixed' ? weakest * quality :
        strongest * (1 - weakest / Math.max(0.001, strongest) * 0.5) * quality;
    }
    return {
      calibrating: !this.baselineReady,
      calibrationProgress: clamp(elapsed / 2000),
      baselineReady: this.baselineReady,
      direction: this.direction,
      shiftHz: active && this.direction === 'toward' ? this.towardShift :
        active && this.direction === 'away' ? this.awayShift : 0,
      carrierHz: this.carrierHz,
      velocityShifts: {
        toward: this.baselineReady && signalPresent ? this.velocityTowardShift : null,
        away: this.baselineReady && signalPresent ? this.velocityAwayShift : null
      },
      towardShiftHz: active && ['toward', 'mixed'].includes(this.direction) ? this.towardShift : null,
      awayShiftHz: active && ['away', 'mixed'].includes(this.direction) ? this.awayShift : null,
      confidence: clamp(confidence),
      towardEnergy: clamp(towardEnergy),
      awayEnergy: clamp(awayEnergy),
      activity: clamp(Math.max(towardEnergy, awayEnergy)),
      carrierDb, signalPresent,
      lowerHz: this.lowerHz,
      upperHz: this.upperHz,
      noiseDb, carrierSNR,
      guardHz: this.guardHz,
      binHz: this.binHz
    };
  }
}
