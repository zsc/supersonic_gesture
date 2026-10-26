// Invert the reflected-tone relation fr = f0 * (c + v) / (c - v).
// Equivalent radial velocity assumes near-colocated Tx/Rx and radial motion.
// This is not a calibrated 3-D hand speed. c = 343 m/s is a room-temperature
// approximation; geometry, multiple reflectors and peak selection dominate error.
export function shiftToVelocity(shiftHz, carrierHz) {
  if (!Number.isFinite(shiftHz) || !Number.isFinite(carrierHz) || carrierHz <= 0 || Math.abs(shiftHz) >= carrierHz) return null;
  return 343 * shiftHz / (2 * carrierHz + shiftHz);
}

export function estimateVelocity(result) {
  const empty = { toward: null, away: null };
  if (!result || result.calibrating || !result.signalPresent) return empty;
  // Current validated spectral peaks are independent of the gesture debounce.
  // An unresolved/absent peak stays null even if the old label persists.
  const { toward = null, away = null } = result.velocityShifts ?? {};
  return {
    toward: toward > 0 ? shiftToVelocity(toward, result.carrierHz) : null,
    away: away < 0 ? shiftToVelocity(away, result.carrierHz) : null
  };
}

export function velocityText(velocity) {
  const parts = [velocity.toward, velocity.away].filter(Number.isFinite);
  return parts.length ? parts.map(value => `${value > 0 ? '+' : ''}${value.toFixed(2)}`).join(' / ') : '—';
}
