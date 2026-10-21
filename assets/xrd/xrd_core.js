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
  function filmProfile(params, hkl, maxQ, filmCount = null) {
    const count = filmCount === null ? params.film_planes : filmCount;
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

  function gradientFilmAmplitude(q, s, params, hkl, profile, oxygenFactor, filmCount = null) {
    const count = filmCount === null ? params.film_planes : filmCount;
    const sites = DATA.film_sites[params.film_material];
    const coefficients = filmBasisCoefficients(hkl,
      atomicScatteringFactor(sites[0], s), atomicScatteringFactor(sites[1], s), oxygenFactor);
    const [h, k, l] = hkl;
    const halfFactor = q / (2 * Math.sqrt(h * h + k * k + l * l));
    let ar = 0, ai = 0;
    if (profile.length === count) {
      const firstA = profile[0][2];
      const deltaA = params.film_lattice_gradient_a / (count - 1);
      let [hpr, hpi] = cExpI(halfFactor * firstA);
      const [hsr, hsi] = cExpI(halfFactor * deltaA);
      const projected = projectedRepeat(1, hkl);
      let [cpr, cpi] = cExpI(q * projected * firstA);
      const [csr, csi] = cExpI(q * projected * deltaA);
      let [opr, opi] = [1, 0];
      for (let i = 0; i < count; i++) {
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

  function thicknessDistribution(count, sigma) {
    // Gaussian width in repeat units; integer sampling/truncation changes moments.
    if (sigma < 0.02 || count === 0) return [[count, 1]];
    const radius = Math.max(1, Math.ceil(4 * sigma));
    const weighted = [];
    let total = 0;
    for (let n = Math.max(0, count - radius); n <= count + radius; n++) {
      const weight = Math.exp(-0.5 * ((n - count) / sigma) ** 2);
      weighted.push([n, weight]); total += weight;
    }
    return weighted.filter((item) => item[1] > 0).map(([n, weight]) => [n, weight / total]);
  }

  function taperSegments(count, width) {
    // Exact finite Fourier expansion of the two sine-squared amplitude ramps.
    if (count === 0) return [];
    if (width <= 0.5) return [[0, count, [[0, 1, 0]]]];
    const edge = Math.min(count, Math.max(0, Math.ceil(width - 0.5)));
    const breaks = [...new Set([0, edge, count - edge, count])].sort((a, b) => a - b);
    const frequency = Math.PI / width;
    const result = [];
    for (let i = 0; i < breaks.length - 1; i++) {
      const start = breaks[i], end = breaks[i + 1];
      let coefficients = new Map([[0, [1, 0]]]);
      const ramps = [];
      if (start < edge) {
        const [cr, ci] = cExpI(0.5 * frequency);
        ramps.push([[0, 0.5, 0], [1, -0.25 * cr, -0.25 * ci], [-1, -0.25 * cr, 0.25 * ci]]);
      }
      if (start >= count - edge) {
        const [cr, ci] = cExpI(frequency * (count - 0.5));
        ramps.push([[0, 0.5, 0], [1, -0.25 * cr, 0.25 * ci], [-1, -0.25 * cr, -0.25 * ci]]);
      }
      for (const ramp of ramps) {
        const product = new Map();
        for (const [first, [cr, ci]] of coefficients) {
          for (const [second, fr, fi] of ramp) {
            const [pr, pi] = cMul(cr, ci, fr, fi);
            const previous = product.get(first + second) || [0, 0];
            product.set(first + second, [previous[0] + pr, previous[1] + pi]);
          }
        }
        coefficients = product;
      }
      result.push([start, end, [...coefficients].sort((a, b) => a[0] - b[0])
        .map(([index, [cr, ci]]) => [index * frequency, cr, ci])]);
    }
    return result;
  }

  function taperedProfile(count, period, latticeA, profile, width) {
    const source = profile.length ? profile : width > 2 * count && count <= 256
      ? Array.from({length: count}, (_, n) => [n * period, period, latticeA, 1]) : [[0, period, latticeA, count]];
    const ramps = taperSegments(count, width);
    const result = [];
    let cellStart = 0;
    for (const [origin, localPeriod, localA, cells] of source) {
      for (const [lower, upper, coefficients] of ramps) {
        const start = Math.max(cellStart, lower), end = Math.min(cellStart + cells, upper);
        if (start >= end) continue;
        let shifted;
        if (end - start === 1) {
          const left = width ? Math.min(1, (start + 0.5) / width) : 1;
          const right = width ? Math.min(1, (count - start - 0.5) / width) : 1;
          const weight = Math.sin(Math.PI * left / 2) ** 2 * Math.sin(Math.PI * right / 2) ** 2;
          shifted = [[0, weight, 0]];
        } else {
          shifted = coefficients.map(([frequency, cr, ci]) => {
            const [pr, pi] = cExpI(frequency * start);
            const [fr, fi] = cMul(cr, ci, pr, pi);
            return [frequency, fr, fi];
          });
        }
        result.push([origin + (start - cellStart) * localPeriod, localPeriod,
                     localA, end - start, shifted]);
      }
      cellStart += cells;
    }
    return result;
  }

  function prepareDomains(params, hkl, maxQ, filmPeriod) {
    const domains = [];
    let cost = 0;
    for (const [count, weight] of thicknessDistribution(params.film_planes, params.film_thickness_sigma)) {
      const profile = filmProfile(params, hkl, maxQ, count);
      const tapered = params.film_interface_width && count
        ? taperedProfile(count, filmPeriod, params.film_lattice_a, profile, params.film_interface_width) : [];
      cost += tapered.length ? tapered.reduce((sum, piece) => sum + piece[4].length, 0) : Math.max(1, profile.length);
      domains.push([count, weight, profile, tapered]);
    }
    if (cost > 20000) throw new Error("Film domain/taper calculation is too large; reduce thickness spread, lattice gradient, or film repeats");
    return domains;
  }

  function lpFactor(twoTheta, mode) {
    // Ideal polarization only. Optional footprint assumes fixed beam width fully
    // contained on the sample. No Lorentz or spectral doublet factor is applied.
    if (mode === "none") return 1;
    const angle = twoTheta * Math.PI / 180;
    const baseMode = mode.replace(/_footprint$/, "");
    const polarization = baseMode === "synchrotron_vertical" ? 1
      : baseMode === "synchrotron_horizontal" ? Math.cos(angle) ** 2 : (1 + Math.cos(angle) ** 2) / 2;
    return mode.endsWith("_footprint") ? polarization / Math.sin(angle / 2) : polarization;
  }

  function checkDomainWork(domains, samples) {
    const cost = domains.reduce((sum, [, , profile, tapered]) => sum + (tapered.length
      ? tapered.reduce((subtotal, piece) => subtotal + piece[4].length, 0) : Math.max(1, profile.length)), 0);
    if (cost * samples > 100000000) throw new Error("Film domain/taper integration is too large; narrow the scan or reduce thickness spread, lattice gradient, or coherence repeats");
  }

  function domainIntensity(twoTheta, params, hkl, filmPeriod, substratePeriod, domains) {
    const theta = (twoTheta - params.angle_offset_deg) * 0.5 * Math.PI / 180;
    const s = Math.sin(theta) / params.wavelength, q = 4 * Math.PI * s;
    const oxygenFactor = atomicScatteringFactor("O", s);
    let sr = 0, si = 0;
    if (params.substrate_planes) {
      const [fr, fi] = substrateAmplitude(q, s, params, hkl, oxygenFactor);
      const [pr, pi] = cExpI(-q * substratePeriod);
      const [gr, gi] = geometricSum(-q * substratePeriod, params.substrate_planes);
      const [tr, ti] = cMul(fr, fi, pr, pi);
      [sr, si] = cMul(tr, ti, gr, gi);
    }
    const [aElement, bElement] = DATA.film_sites[params.film_material];
    const filmBasis = basisAmplitude(q, s, params.film_lattice_a, hkl, aElement, bElement, oxygenFactor);
    let intensity = 0;
    for (const [count, weight, profile, tapered] of domains) {
      let ar = 0, ai = 0;
      if (tapered.length) {
        for (const [origin, period, localA, cells, factors] of tapered) {
          const [fr, fi] = profile.length
            ? basisAmplitude(q, s, localA, hkl, aElement, bElement, oxygenFactor) : filmBasis;
          let wr = 0, wi = 0;
          for (const [frequency, cr, ci] of factors) {
            const [gr, gi] = geometricSum(q * period + frequency, cells);
            const [tr, ti] = cMul(cr, ci, gr, gi);
            wr += tr; wi += ti;
          }
          const [pr, pi] = cExpI(q * origin);
          const [tr, ti] = cMul(fr, fi, pr, pi);
          const [vr, vi] = cMul(tr, ti, wr, wi);
          ar += vr; ai += vi;
        }
      } else if (profile.length) {
        [ar, ai] = gradientFilmAmplitude(q, s, params, hkl, profile, oxygenFactor, count);
      } else if (count) {
        const [gr, gi] = geometricSum(q * filmPeriod, count);
        [ar, ai] = cMul(filmBasis[0], filmBasis[1], gr, gi);
      }
      ar += sr; ai += si;
      intensity += weight * (ar * ar + ai * ai);
    }
    return intensity;
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
    resolution_halo_fraction: 0, resolution_halo_width: 3,
    film_lattice_gradient_a: 0,
    film_interface_width: 0, film_thickness_sigma: 0,
    lp_mode: "none", background_slope: 0,
  };

  function simulate(angles, rawParams) {
    const params = Object.assign({}, DEFAULTS, rawParams);
    for (const [name, lower, upper, message] of [
      ["film_interface_width", 0, 1000, "film_interface_width must be within 0 to 1,000 repeats"],
      ["film_thickness_sigma", 0, 20, "film_thickness_sigma must be within 0 to 20 repeats"],
      ["background_slope", -1, 1, "background_slope must be within -1 to 1 per degree"],
      ["resolution_halo_fraction", 0, 0.2, "resolution_halo_fraction must be within 0 to 0.2"],
      ["resolution_halo_width", 1, 20, "resolution_halo_width must be within 1 to 20"]
    ]) {
      if (!Number.isFinite(params[name]) || params[name] < lower || params[name] > upper) throw new Error(message);
    }
    if (!["none", "synchrotron_vertical", "synchrotron_horizontal", "lab_unpolarized",
      "synchrotron_vertical_footprint", "synchrotron_horizontal_footprint", "lab_unpolarized_footprint"].includes(params.lp_mode)) {
      throw new Error("Unsupported lp_mode");
    }
    const x = angles;
    if (x[0] - params.angle_offset_deg <= 0 || x[x.length - 1] - params.angle_offset_deg >= 180) {
      throw new Error("Angle offset moves the scan outside the physical 0–180° range");
    }
    const hkl = parseHkl(params.hkl);
    const filmPeriod = projectedRepeat(params.film_lattice_a, hkl);
    const [subA, subC, subSystem] = substrateLattice(params);
    const substratePeriod = projectedRepeat(subA, hkl, subC, subSystem);
    const sigma = params.fwhm_deg / (2 * Math.sqrt(2 * Math.log(2)));
    const halo = params.resolution_halo_fraction > 0 && params.resolution_halo_width > 1;
    let halfWidth = 4.5 * sigma;
    if (halo) halfWidth *= params.resolution_halo_width;
    const endAngle = Math.min(180 - 1e-9 + params.angle_offset_deg, x[x.length - 1] + halfWidth);
    const maxQ = (4 * Math.PI * Math.sin((((endAngle - params.angle_offset_deg) * 0.5) * Math.PI) / 180))
                 / params.wavelength;
    const profile = filmProfile(params, hkl, maxQ);
    const extendedFilm = params.film_interface_width !== 0 || params.film_thickness_sigma !== 0;
    const domains = extendedFilm ? prepareDomains(params, hkl, maxQ, filmPeriod) : [];
    const intensity = (angle) => {
      const value = extendedFilm ? domainIntensity(angle, params, hkl, filmPeriod, substratePeriod, domains)
        : unbroadenedIntensity(angle, params, hkl, filmPeriod, substratePeriod, profile);
      return value * lpFactor(angle - params.angle_offset_deg, params.lp_mode);
    };
    let raw;
    if (sigma === 0) {
      checkDomainWork(domains, x.length);
      raw = x.map(intensity);
    } else {
      const start = Math.max(1e-9 + params.angle_offset_deg, x[0] - halfWidth);
      const end = Math.min(180 - 1e-9 + params.angle_offset_deg, x[x.length - 1] + halfWidth);
      const longestCount = domains.length ? Math.max(...domains.map((domain) => domain[0])) : params.film_planes;
      const coherentThickness = Math.max(longestCount * filmPeriod,
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
      checkDomainWork(domains, steps + 1);
      const grid = new Float64Array(steps + 1);
      const samples = new Float64Array(steps + 1);
      // Guard the expanded convolution before computing costly film domains.
      // An upper bound avoids a second traversal of every angle's grid window.
      if (halo && x.length * Math.min(steps + 1, Math.floor(2 * halfWidth / step) + 2) > 100000000) {
        throw new Error("Resolution halo convolution is too large; reduce halo width, FWHM, coherence repeats, or scan points");
      }
      for (let i = 0; i <= steps; i++) {
        grid[i] = start + i * step;
        samples[i] = intensity(grid[i]);
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
          if (halo) {
            // f is integrated area, so the broad Gaussian's height is f/m.
            const broadDistance = distance / params.resolution_halo_width;
            weight = (1 - params.resolution_halo_fraction) * weight
              + params.resolution_halo_fraction / params.resolution_halo_width
              * Math.exp(-0.5 * broadDistance * broadDistance);
          }
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
    if (params.background_slope !== 0 && floor !== 0) {
      const mixed = raw.map((value, index) => (1 - floor) * value / peak
        + floor * 10 ** (params.background_slope * (x[index] - 33)));
      let combinedPeak = -Infinity;
      for (const value of mixed) if (value > combinedPeak) combinedPeak = value;
      return mixed.map((value) => Math.max(1e-12, value / combinedPeak));
    }
    return raw.map((value) => {
      const scaled = value / peak;
      const withFloor = scaled * (1 - floor) + floor;
      return withFloor > 0 ? withFloor : Number.MIN_VALUE;
    });
  }

  return {useData, parseHkl, dSpacing, braggAngle, projectedRepeat, reflectionAbsent,
          atomicScatteringFactor, simulate, substrateLattice, DEFAULTS,
          thicknessDistribution, lpFactor,
          get data() { return DATA; }};
})();

if (typeof module !== "undefined" && module.exports) module.exports = XRDCore;
