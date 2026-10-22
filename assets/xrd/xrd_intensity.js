/* Explicit ingestion conversion. A log hint never selects the scale: signed
   linear data can look similar. Its numerical range is max-min, not max/min.
   Analysis modules still require linear, nonnegative intensities. */
"use strict";
const XRDIntensity = (() => {
  const MAX_POINTS = 1000000;
  function finite(value, label) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
    return value;
  }
  function convert(raw, settings = {}) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Intensity conversion needs a measurement object");
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Intensity settings must be an object");
    const unexpected = Object.keys(settings).filter(key => !["intensity_scale", "intensity_decades", "negative_policy"].includes(key)).sort();
    if (unexpected.length) throw new Error(`Unknown intensity setting: ${unexpected.join(", ")}`);
    const scale = settings.intensity_scale === undefined ? "linear" : settings.intensity_scale;
    const policy = settings.negative_policy === undefined ? "reject" : settings.negative_policy;
    if (!["linear", "log10", "log10_normalized"].includes(scale)) throw new Error("intensity_scale must be linear, log10 or log10_normalized");
    if (!["reject", "clip", "shift"].includes(policy)) throw new Error("negative_policy must be reject, clip or shift");
    const decades = finite(settings.intensity_decades === undefined ? 8 : settings.intensity_decades, "intensity_decades");
    if (!(decades >= 1 && decades <= 20)) throw new Error("intensity_decades must be within 1 to 20");
    const angles = raw.angles, values = raw.intensities;
    if (!Array.isArray(angles) || !Array.isArray(values) || angles.length !== values.length || angles.length < 2 || angles.length > MAX_POINTS) throw new Error("Intensity conversion needs matching arrays of 2–1,000,000 points");
    let previous = -Infinity;
    for (const value of angles) {
      const angle = finite(value, "angle");
      if (!(angle > 0 && angle < 180 && angle > previous)) throw new Error("Measurement angles must increase within 0–180 degrees");
      previous = angle;
    }
    let minimum = Infinity, maximum = -Infinity, negativeCount = 0;
    for (const value of values) {
      finite(value, "intensity");
      minimum = Math.min(minimum, value); maximum = Math.max(maximum, value);
      if (value < 0) negativeCount++;
    }
    const filename = raw.filename === undefined ? "measurement.dat" : raw.filename;
    if (typeof filename !== "string") throw new Error("Measurement filename must be a string");
    const hint = Boolean(negativeCount && Math.abs(maximum - 1) <= 1e-3 && maximum - minimum < 100);
    let shift = 0, converted;
    if (scale === "linear") {
      if (negativeCount && policy === "reject") throw new Error("Linear intensity contains negative values; explicitly choose clip or shift");
      if (negativeCount && policy === "shift") {
        shift = -minimum; converted = values.map(value => value + shift);
      } else if (negativeCount && policy === "clip") converted = values.map(value => value < 0 ? 0 : value);
      else converted = values.slice();
      if (converted.some(value => !Number.isFinite(value))) throw new Error("Intensity conversion overflowed; transformed values must be finite");
    } else {
      const factor = scale === "log10_normalized" ? decades : 1;
      converted = values.map(value => {
        const result = 10 ** (factor * value);
        if (!Number.isFinite(result) || result <= 0) throw new Error("Log intensity conversion overflowed or underflowed; every result must be finite and positive");
        return result;
      });
    }
    if (!converted.some(value => value > 0)) throw new Error("Measurement has no positive intensity values after conversion");
    return {angles: angles.slice(), intensities: converted, filename,
      intensity_transform: {intensity_scale: scale, intensity_decades: decades,
        negative_policy: policy, shift, negative_count: negativeCount, log_hint: hint}};
  }
  return {convert, MAX_POINTS};
})();
if (typeof module !== "undefined" && module.exports) module.exports = XRDIntensity;
