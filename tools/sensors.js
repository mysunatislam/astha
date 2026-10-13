// Range-sensor interface. No sensor hardware exists yet and nothing calls report() today.
// It fixes how a measured distance will enter ASTHA, so that an ultrasonic module can be
// added later without touching the vision code: a fresh measurement is preferred, and an
// image-based guess is always labelled as an estimate, never as a measurement.
const AsthaSensors = (() => {
  const MAX_AGE = 1000;                // a reading older than this says nothing about now
  const MIN_METRES = 0.02, MAX_METRES = 8;
  const readings = new Map();          // channel -> { metres, at, source }

  // Called by a future transport (BLE, serial bridge). Rejects values a sensor cannot produce.
  function report(channel, metres, source = 'unknown', now = Date.now()) {
    if (typeof channel !== 'string' || !/^[a-z_]{1,24}$/.test(channel) || !Number.isFinite(metres) ||
        metres < MIN_METRES || metres > MAX_METRES) return false;
    readings.set(channel, { metres, at: now, source: String(source).slice(0, 40) });
    return true;
  }
  function measured(channel = 'front', now = Date.now()) {
    const reading = readings.get(channel);
    return reading && now - reading.at <= MAX_AGE ? { metres: reading.metres, source: reading.source, measured: true } : null;
  }
  // Combine a measurement with the vision pipeline's own guess for the same direction.
  function fuse(estimateMetres, channel = 'front', now = Date.now()) {
    const reading = measured(channel, now);
    if (reading) return reading;
    return Number.isFinite(estimateMetres) && estimateMetres > 0 ? { metres: estimateMetres, source: 'image', measured: false } : null;
  }
  return { report, measured, fuse, clear: () => readings.clear(), get connected() { return readings.size > 0; } };
})();
