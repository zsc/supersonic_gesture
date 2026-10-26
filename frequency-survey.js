const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Retain settled measurements from separate trials, including repeated carrier
// frequencies. This is the combined speaker/room/microphone response, not SPL.
export class FrequencySurvey {
  constructor() { this.trials = []; this.current = null; }
  begin(frequency, gain) {
    this.current = { frequency, gain, samples: [] };
    this.trials.push(this.current);
    if (this.trials.length > 12) this.trials.shift();
  }
  observe(result, now) {
    if (!this.current || result.calibrating || !Number.isFinite(result.carrierDb) || !Number.isFinite(result.noiseDb)) return;
    if (this.current.samples.length >= 600) return;
    this.current.samples.push({ time: now, carrier: result.carrierDb, noise: result.noiseDb, snr: result.carrierSNR, detected: result.signalPresent });
  }
  summaries() {
    return this.trials.filter(trial => trial.samples.length).map(trial => {
      const samples = trial.samples;
      const powers = samples.map(sample => sample.carrier).sort((a, b) => a - b);
      return {
        frequency: trial.frequency, gain: trial.gain, count: samples.length,
        seconds: (samples.at(-1).time - samples[0].time) / 1000,
        carrier: median(powers), noise: median(samples.map(sample => sample.noise)),
        snr: median(samples.map(sample => sample.snr)),
        spread: powers[Math.floor((powers.length - 1) * .75)] - powers[Math.floor((powers.length - 1) * .25)],
        detected: samples.filter(sample => sample.detected).length / samples.length
      };
    });
  }
}
