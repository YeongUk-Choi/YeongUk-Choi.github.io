/* The kinematic model, in the browser.

   This is a port of xrd_model.py, line for line where that was possible. It
   exists so the program can run on a static web page with no Python behind it.
   Everything that is data — form factors, the ABO3 basis, the substrate
   library — is loaded from xrd_data.json, the same file the Python reads, so
   only the arithmetic lives in two places. test_core_parity.py checks that the
   two give the same numbers to within 1e-9.

   Complex values are plain {re, im} pairs: a Complex class allocates on every
   operation, and the inner loop here runs tens of millions of times. */
"use strict";

const XRDCore = (() => {
  let DATA = null;

  function useData(data) { DATA = data; }

  // ---- small complex helpers -------------------------------------------
  const cMul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];
  const cExpI = (phase) => [Math.cos(phase), Math.sin(phase)];

  // ---- reflections ------------------------------------------------------
  function parseHkl(hkl) {
    if (Array.isArray(hkl)) {
      if (hkl.length !== 3 || hkl.some((v) => !Number.isInteger(v))) {
        throw new Error("hkl must contain three integer indices");
      }
      var values = hkl.slice();
    } else {
      const cleaned = String(hkl).trim().replace(/^[([]|[)\]]$/g, "");
      let parts;
      if (/^\d{3}$/.test(cleaned)) parts = cleaned.split("");
      else parts = cleaned.split(/[,\s]+/).filter(Boolean);
      if (parts.length !== 3) throw new Error("hkl must contain three Miller indices");
      values = parts.map((part) => {
        if (!/^-?\d+$/.test(part)) throw new Error("hkl must contain three integer indices");
        return Number(part);
      });
    }
    if (values.every((v) => v === 0)) throw new Error("hkl indices must not all be zero");
    const limit = DATA.max_miller_index;
    if (values.some((v) => Math.abs(v) > limit)) {
      throw new Error(`hkl indices must be within ±${limit}`);
    }
    return values;
  }

  function dSpacing(a, hkl, c, system) {
    const [h, k, l] = parseHkl(hkl);
    let inverseSquared;
    if (!system || system === "cubic") {
      inverseSquared = (h * h + k * k + l * l) / (a * a);
    } else if (system === "tetragonal") {
      const cc = c || a;
      inverseSquared = (h * h + k * k) / (a * a) + (l * l) / (cc * cc);
    } else if (system === "hexagonal") {
      const cc = c || a;
      inverseSquared = (4 * (h * h + h * k + k * k)) / (3 * a * a) + (l * l) / (cc * cc);
    } else {
      throw new Error(`Unsupported crystal system: ${system}`);
    }
    if (!(inverseSquared > 0)) throw new Error("This reflection has no finite d-spacing");
    return 1 / Math.sqrt(inverseSquared);
  }

  function braggAngle(a, hkl, wavelength = 1.5406, c = null, system = "cubic") {
    const sineTheta = wavelength / (2 * dSpacing(a, hkl, c, system));
    if (sineTheta > 1) throw new Error("This reflection is inaccessible at the chosen wavelength");
    return (2 * Math.asin(sineTheta) * 180) / Math.PI;
  }

  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  function projectedRepeat(a, hkl, c = null, system = "cubic") {
    const [h, k, l] = hkl;
    const common = gcd(gcd(Math.abs(h), Math.abs(k)), Math.abs(l));
    return dSpacing(a, hkl, c, system) * common;
  }

  function reflectionAbsent(hkl, centering) {
    const [h, k, l] = hkl;
    const parity = (v) => ((v % 2) + 2) % 2;
    if (centering === "F") return !(parity(h) === parity(k) && parity(k) === parity(l));
    if (centering === "diamond") {
      if (parity(h) === 1 && parity(k) === 1 && parity(l) === 1) return false;
      if (parity(h) === 0 && parity(k) === 0 && parity(l) === 0) return (h + k + l) % 4 !== 0;
      return true;
    }
    if (centering === "I") return (h + k + l) % 2 !== 0;
    return false;
  }

  // ---- scattering -------------------------------------------------------
  function atomicScatteringFactor(element, sinThetaOverLambda) {
    const c = DATA.form_factors[element];
    if (!c) throw new Error(`Unsupported element: ${element}`);
    const s2 = sinThetaOverLambda * sinThetaOverLambda;
    return (c[0] * Math.exp(-c[1] * s2) + c[2] * Math.exp(-c[3] * s2)
          + c[4] * Math.exp(-c[5] * s2) + c[6] * Math.exp(-c[7] * s2) + c[8]);
  }

  function basisAmplitude(q, s, a, hkl, aElement, bElement, oxygenFactor) {
    const [h, k, l] = hkl;
    const halfPhase = (q * a) / (2 * Math.sqrt(h * h + k * k + l * l));
    const fa = atomicScatteringFactor(aElement, s);
    const fb = atomicScatteringFactor(bElement, s);
    const [br, bi] = cExpI(halfPhase * (h + k + l));
    const [o1r, o1i] = cExpI(halfPhase * (h + k));
    const [o2r, o2i] = cExpI(halfPhase * (h + l));
    const [o3r, o3i] = cExpI(halfPhase * (k + l));
    return [fa + fb * br + oxygenFactor * (o1r + o2r + o3r),
            fb * bi + oxygenFactor * (o1i + o2i + o3i)];
  }

  function substrateAmplitude(q, s, params, hkl, oxygenFactor) {
    const entry = DATA.substrates[params.substrate_material];
    if (entry.basis === "perovskite") {
      return basisAmplitude(q, s, params.substrate_lattice_a, hkl,
                            entry.sites[0], entry.sites[1], oxygenFactor);
    }
    if (reflectionAbsent(hkl, entry.centering || "P")) return [0, 0];
    const electrons = entry.electrons === undefined ? 100 : entry.electrons;
    return [electrons * Math.exp(-2 * s * s), 0];
  }

  const sinc = (value) => (Math.abs(value) < 1e-8
    ? 1 - (value * value) / 6
    : Math.sin(value) / value);

  function geometricSum(phase, count) {
    if (count === 0) return [0, 0];
    // Math.remainder equivalent: nearest-integer reduction, like Python's math.remainder
    const twoPi = 2 * Math.PI;
    const reduced = phase - twoPi * Math.round(phase / twoPi);
    const half = 0.5 * reduced;
    const ratio = Math.abs(half) < 1e-12 ? count : (count * sinc(count * half)) / sinc(half);
    const [cr, ci] = cExpI((count - 1) * half);
    return [ratio * cr, ratio * ci];
  }

  // ---- film with a vertical lattice ramp --------------------------------
  function filmProfile(params, hkl, maxQ) {
    const count = params.film_planes;
    const gradient = params.film_lattice_gradient_a;
    if (!gradient || count < 2) return [];
    const projection = projectedRepeat(1, hkl);
    const localStep = Math.abs((gradient * projection) / (count - 1));
    const maxCells = count <= 64
      ? 1
      : Math.max(1, Math.trunc(Math.sqrt(0.08 / Math.max(maxQ * localStep, 1e-30))));
    const pieces = [];
    let height = 0;
    let start = 0;
    while (start < count) {
      const cells = Math.min(maxCells, count - start);
      const midpoint = start + (cells - 1) / 2;
      const localA = params.film_lattice_a + gradient * (midpoint / (count - 1) - 0.5);
      const period = projection * localA;
      pieces.push([height, period, localA, cells]);
      height += cells * period;
      start += cells;
    }
    return pieces;
  }

  function filmBasisCoefficients(hkl, aFactor, bFactor, oxygenFactor) {
    const [h, k, l] = hkl;
    const coefficients = new Array(h + k + l + 1).fill(0);
    coefficients[0] += aFactor;
    coefficients[h + k + l] += bFactor;
    for (const exponent of [h + k, h + l, k + l]) coefficients[exponent] += oxygenFactor;
    return coefficients;
  }

  function filmBasisFromPhase(pr, pi, coefficients) {
    let vr = coefficients[coefficients.length - 1];
    let vi = 0;
    for (let i = coefficients.length - 2; i >= 0; i--) {
      const [nr, ni] = cMul(vr, vi, pr, pi);
      vr = nr + coefficients[i];
      vi = ni;
    }
    return [vr, vi];
  }

  function gradientFilmAmplitude(q, s, params, hkl, profile, oxygenFactor) {
    const sites = DATA.film_sites[params.film_material];
    const coefficients = filmBasisCoefficients(hkl,
      atomicScatteringFactor(sites[0], s), atomicScatteringFactor(sites[1], s), oxygenFactor);
    const [h, k, l] = hkl;
    const halfFactor = q / (2 * Math.sqrt(h * h + k * k + l * l));
    let ar = 0, ai = 0;
    if (profile.length === params.film_planes) {
      const firstA = profile[0][2];
      const deltaA = params.film_lattice_gradient_a / (params.film_planes - 1);
      let [hpr, hpi] = cExpI(halfFactor * firstA);
      const [hsr, hsi] = cExpI(halfFactor * deltaA);
      const projected = projectedRepeat(1, hkl);
      let [cpr, cpi] = cExpI(q * projected * firstA);
      const [csr, csi] = cExpI(q * projected * deltaA);
      let [opr, opi] = [1, 0];
      for (let i = 0; i < params.film_planes; i++) {
        const [br, bi] = filmBasisFromPhase(hpr, hpi, coefficients);
        const [tr, ti] = cMul(opr, opi, br, bi);
        ar += tr; ai += ti;
        [opr, opi] = cMul(opr, opi, cpr, cpi);
        [cpr, cpi] = cMul(cpr, cpi, csr, csi);
        [hpr, hpi] = cMul(hpr, hpi, hsr, hsi);
      }
      return [ar, ai];
    }
    for (const [origin, period, localA, count] of profile) {
      const [epr, epi] = cExpI(halfFactor * localA);
      const [br, bi] = filmBasisFromPhase(epr, epi, coefficients);
      const [or_, oi] = cExpI(q * origin);
      const [gr, gi] = geometricSum(q * period, count);
      const [m1r, m1i] = cMul(br, bi, or_, oi);
      const [m2r, m2i] = cMul(m1r, m1i, gr, gi);
      ar += m2r; ai += m2i;
    }
    return [ar, ai];
  }

  function unbroadenedIntensity(twoTheta, params, hkl, filmPeriod, substratePeriod, profile) {
    const theta = (((twoTheta - params.angle_offset_deg) * 0.5) * Math.PI) / 180;
    const s = Math.sin(theta) / params.wavelength;
    const q = 4 * Math.PI * s;
    let ar = 0, ai = 0;
    const oxygenFactor = atomicScatteringFactor("O", s);
    if (params.film_planes) {
      if (profile.length) {
        const [gr, gi] = gradientFilmAmplitude(q, s, params, hkl, profile, oxygenFactor);
        ar += gr; ai += gi;
      } else {
        const sites = DATA.film_sites[params.film_material];
        const [fr, fi] = basisAmplitude(q, s, params.film_lattice_a, hkl,
                                        sites[0], sites[1], oxygenFactor);
        const [sr, si] = geometricSum(q * filmPeriod, params.film_planes);
        const [mr, mi] = cMul(fr, fi, sr, si);
        ar += mr; ai += mi;
      }
    }
    if (params.substrate_planes) {
      const [fr, fi] = substrateAmplitude(q, s, params, hkl, oxygenFactor);
      const [pr, pi] = cExpI(-q * substratePeriod);
      const [gr, gi] = geometricSum(-q * substratePeriod, params.substrate_planes);
      const [m1r, m1i] = cMul(fr, fi, pr, pi);
      const [m2r, m2i] = cMul(m1r, m1i, gr, gi);
      ar += m2r; ai += m2i;
    }
    return ar * ar + ai * ai;
  }

  function substrateLattice(params) {
    const entry = DATA.substrates[params.substrate_material];
    const system = entry.system;
    const a = params.substrate_lattice_a;
    const c = params.substrate_lattice_c || (system === "cubic" ? a : (entry.c === undefined ? a : entry.c));
    return [a, system === "cubic" ? null : c, system];
  }

  const DEFAULTS = {
    hkl: "110", film_material: "SrRuO3", substrate_material: "SrTiO3",
    wavelength: 1.5406, film_lattice_a: 3.93, substrate_lattice_a: 3.905,
    substrate_lattice_c: 0, film_planes: 50, substrate_planes: 350,
    angle_offset_deg: 0, fwhm_deg: 0.06, background: 1e-6,
    film_lattice_gradient_a: 0,
  };

  function simulate(angles, rawParams) {
    const params = Object.assign({}, DEFAULTS, rawParams);
    const x = angles;
    if (x[0] - params.angle_offset_deg <= 0 || x[x.length - 1] - params.angle_offset_deg >= 180) {
      throw new Error("Angle offset moves the scan outside the physical 0–180° range");
    }
    const hkl = parseHkl(params.hkl);
    const filmPeriod = projectedRepeat(params.film_lattice_a, hkl);
    const [subA, subC, subSystem] = substrateLattice(params);
    const substratePeriod = projectedRepeat(subA, hkl, subC, subSystem);
    const sigma = params.fwhm_deg / (2 * Math.sqrt(2 * Math.log(2)));
    const endAngle = Math.min(180 - 1e-9 + params.angle_offset_deg, x[x.length - 1] + 4.5 * sigma);
    const maxQ = (4 * Math.PI * Math.sin((((endAngle - params.angle_offset_deg) * 0.5) * Math.PI) / 180))
                 / params.wavelength;
    const profile = filmProfile(params, hkl, maxQ);
    let raw;
    if (sigma === 0) {
      raw = x.map((angle) => unbroadenedIntensity(angle, params, hkl, filmPeriod, substratePeriod, profile));
    } else {
      const halfWidth = 4.5 * sigma;
      const start = Math.max(1e-9 + params.angle_offset_deg, x[0] - halfWidth);
      const end = Math.min(180 - 1e-9 + params.angle_offset_deg, x[x.length - 1] + halfWidth);
      const coherentThickness = Math.max(params.film_planes * filmPeriod,
                                         params.substrate_planes * substratePeriod);
      const cosTheta = Math.cos((Math.max(0, start - params.angle_offset_deg) * 0.5 * Math.PI) / 180);
      const fringeStep = ((params.wavelength / (coherentThickness * cosTheta)) * 180) / Math.PI / 6;
      const targetStep = Math.min(sigma / 3, fringeStep);
      if (!(targetStep > 0) || !Number.isFinite(targetStep)) {
        throw new Error("Unable to construct an instrumental broadening grid");
      }
      const steps = Math.max(1, Math.ceil((end - start) / targetStep));
      if (steps > 120000) {
        const advice = fringeStep <= sigma / 3
          ? "Narrow the scan or reduce the film/substrate coherence planes."
          : "Narrow the scan, increase FWHM, or reduce the film/substrate coherence planes.";
        throw new Error(`Gaussian broadening needs ${steps.toLocaleString("en")} integration steps (limit: 120,000). ${advice}`);
      }
      const step = (end - start) / steps;
      const grid = new Float64Array(steps + 1);
      const samples = new Float64Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        grid[i] = start + i * step;
        samples[i] = unbroadenedIntensity(grid[i], params, hkl, filmPeriod, substratePeriod, profile);
      }
      raw = new Array(x.length);
      for (let n = 0; n < x.length; n++) {
        const angle = x[n];
        // The window is the same set of samples Python's bisect selects:
        // every grid point inside [angle - halfWidth, angle + halfWidth].
        // Rounding the index arithmetic instead would include or drop one
        // edge sample, which is a part in a million on a fast-varying scan.
        const low = angle - halfWidth, high = angle + halfWidth;
        let left = Math.ceil((low - start) / step);
        if (left < 0) left = 0;
        if (left > steps + 1) left = steps + 1;
        while (left > 0 && grid[left - 1] >= low) left--;
        while (left <= steps && grid[left] < low) left++;
        let right = Math.floor((high - start) / step);
        if (right > steps) right = steps;
        if (right < -1) right = -1;
        while (right < steps && grid[right + 1] <= high) right++;
        while (right >= 0 && grid[right] > high) right--;
        let numerator = 0, denominator = 0;
        for (let i = left; i <= right; i++) {
          const distance = (grid[i] - angle) / sigma;
          let weight = Math.exp(-0.5 * distance * distance);
          if (i === 0 || i === steps) weight *= 0.5;
          numerator += samples[i] * weight;
          denominator += weight;
        }
        raw[n] = denominator ? numerator / denominator : 0;
      }
    }
    let peak = -Infinity;
    for (const value of raw) if (value > peak) peak = value;
    if (!Number.isFinite(peak) || peak <= 0) {
      throw new Error("The selected scan contains no finite diffraction intensity");
    }
    const floor = params.background;
    return raw.map((value) => {
      const scaled = value / peak;
      const withFloor = scaled * (1 - floor) + floor;
      return withFloor > 0 ? withFloor : Number.MIN_VALUE;
    });
  }

  return {useData, parseHkl, dSpacing, braggAngle, projectedRepeat, reflectionAbsent,
          atomicScatteringFactor, simulate, substrateLattice, DEFAULTS,
          get data() { return DATA; }};
})();

if (typeof module !== "undefined" && module.exports) module.exports = XRDCore;
