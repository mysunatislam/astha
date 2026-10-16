// Range-sensor interface used by the paired Pi/ESP32 telemetry bridge.
// A fresh measurement is preferred, and an
// image-based guess is always labelled as an estimate, never as a measurement.
const AsthaSensors = (() => {
  const MAX_AGE = 1000;                // a reading older than this says nothing about now
  const MIN_METRES = 0.02, MAX_METRES = 8;
  const readings = new Map();          // channel -> { metres, at, source }

  // Reject invalid input and remove the previous reading rather than retaining its number.
  function report(channel, metres, source = 'unknown', now = Date.now()) {
    if (typeof channel !== 'string' || !/^[a-z_]{1,24}$/.test(channel)) return false;
    if (!Number.isFinite(metres) || metres < MIN_METRES || metres > MAX_METRES || !Number.isFinite(now)) { readings.delete(channel); return false; }
    readings.set(channel, { metres, at: now, source: String(source).slice(0, 40) });
    return true;
  }
  function measured(channel = 'front', now = Date.now()) {
    const reading = readings.get(channel);
    return reading && now >= reading.at && now - reading.at <= MAX_AGE ? { metres: reading.metres, source: reading.source, measured: true, at: reading.at } : null;
  }
  // Combine a measurement with the vision pipeline's own guess for the same direction.
  function fuse(estimateMetres, channel = 'front', now = Date.now()) {
    const reading = measured(channel, now);
    if (reading) return reading;
    return Number.isFinite(estimateMetres) && estimateMetres > 0 ? { metres: estimateMetres, source: 'image', measured: false } : null;
  }
  return { report, measured, fuse, clear: channel => channel ? readings.delete(channel) : readings.clear(), get connected() { return readings.size > 0; } };
})();
