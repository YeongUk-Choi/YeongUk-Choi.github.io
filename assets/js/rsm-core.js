/* RSM Studio: DOM-free, kinematic reciprocal-space model.
 * q has NO 2π: |q| = 1/d [Å^-1]; atomic phases still use exp(2π i h.r).
 * See docs/RSM_MODEL.md for sources and model limitations.
 * No powder Lorentz factor, anomalous scattering, absorption or dynamics.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./phase-core.js"), require("./rsm-factors.js"));
  else root.RsmCore = factory(root.PhaseCore, root.RsmFactors);
})(typeof self !== "undefined" ? self : this, function (P, factors) {
  "use strict";

  const D2R = Math.PI / 180, FWHM = 2 * Math.sqrt(2 * Math.log(2));
  const MAX_GRID_WORK = 2000000, MAX_ATOM_WORK = 20000000;
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const norm = a => Math.sqrt(dot(a, a));
  const scale = (a, s) => a.map(x => x * s);
  const add = (a, b) => a.map((x, i) => x + b[i]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const unit = a => scale(a, 1 / norm(a));
  const multiply = (m, v) => m.map(row => dot(row, v));
  const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const fail = (message, code) => { const e = new Error(message); e.code = code || "RSM_INPUT"; throw e; };
  const finite = (values, label) => {
    if (!values.every(Number.isFinite)) fail(`${label} exceeds the finite numerical range; check cell dimensions and simulation settings.`, "RSM_NUMERIC");
  };
  const number = (value, fallback, min, max, label) => {
    const n = value == null ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}.`);
    return n;
  };
  function cellGeometry(cell) {
    if (!cell || ![cell.a, cell.b, cell.c].every(x => Number.isFinite(x) && x > 0 && x <= 10000) ||
      ![cell.alpha, cell.beta, cell.gamma].every(x => Number.isFinite(x) && x > 0 && x < 180)) fail("Invalid cell lengths or angles.");
    const direct = P.cellVectors(cell), volume = P.volume(direct);
    if (!(volume / (cell.a * cell.b * cell.c) > 1e-8)) fail("Cell angles do not define a stable three-dimensional cell.");
    const reciprocal = P.reciprocalVectors(direct);
    finite([volume, ...direct.flat(), ...reciprocal.flat()], "Cell geometry");
    return { direct, reciprocal, volume };
  }
  function indices(v, name) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(x => Number.isInteger(x) && Math.abs(x) <= 99) || !v.some(x => x)) fail(`${name} requires three integers, not all zero.`);
    return v;
  }
  const combination = (vectors, index) => vectors.reduce((v, x, i) => add(v, scale(x, index[i])), [0, 0, 0]);

  /* Rows transform crystal Cartesian coordinates to the sample frame.
     Plane normals use reciprocal vectors; directions use direct vectors. */
  function frame(cell, out = [0, 0, 1], inDirection = [1, 0, 0]) {
    const geometry = cellGeometry(cell);
    const normal = unit(combination(geometry.reciprocal, indices(out, "Surface (h k l)")));
    const direction = combination(geometry.direct, indices(inDirection, "In-plane [u v w]"));
    const projected = add(direction, scale(normal, -dot(direction, normal)));
    if (norm(projected) / norm(direction) < 0.035) fail("In-plane direction is within 2° of the surface normal; choose a different [u v w].", "RSM_ORIENTATION");
    const x = unit(projected), y = unit(cross(normal, x));
    finite([...x, ...y, ...normal], "Orientation frame");
    return { ...geometry, matrix: [x, y, normal], normal };
  }

  /* Active rotations: tilt about sample y, then azimuth about sample z. */
  function rotate(v, tilt, azimuth) {
    const t = tilt * D2R, a = azimuth * D2R;
    const x = Math.cos(t) * v[0] + Math.sin(t) * v[2];
    const y = v[1], z = -Math.sin(t) * v[0] + Math.cos(t) * v[2];
    return [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y, z];
  }

  function variants(layer) {
    const list = layer.variants || [{ tilt: 0, azimuth: 0, weight: 1 }];
    if (!Array.isArray(list) || !list.length || list.length > 16) fail("Use 1–16 domain variants.");
    const result = list.map((v, i) => ({
      tilt: number(v.tilt, 0, -180, 180, "Variant tilt"),
      azimuth: number(v.azimuth, 0, -360, 360, "Variant azimuth"),
      weight: number(v.weight, 1, 0, 1000000, "Variant weight"),
      name: v.name || String(i + 1)
    }));
    const sum = result.reduce((s, v) => s + v.weight, 0);
    if (!sum) fail("At least one domain variant must have a positive weight.");
    return result.filter(v => v.weight > 0).map(v => ({ ...v, weight: v.weight / sum }));
  }
  function atomsOf(layer) {
    const atoms = layer.expandedAtoms || (layer.parsed && layer.parsed.expandedAtoms);
    if (!Array.isArray(atoms) || !atoms.length || atoms.length > 10000) fail("A validated CIF with 1–10000 expanded atomic sites is required.");
    for (const a of atoms) {
      if (!factors.supports(a.element)) fail(`No verified neutral-atom form factor for ${a.element}; this CIF cannot be simulated.`);
      if (![a.x, a.y, a.z].every(Number.isFinite)) fail("An atomic coordinate is invalid.");
      number(a.occupancy, 1, 0, 1, "Atomic occupancy");
      number(a.B ?? a.biso, 0, 0, 1000, "Isotropic B factor");
    }
    return atoms;
  }
  function structureFactor(atoms, h, k, l, qabs) {
    const s2 = (qabs / 2) ** 2;
    if (s2 >= 4) fail("Form factors are limited to s = |q|/2 < 2 Å⁻¹.");
    const cache = Object.create(null);
    let real = 0, imag = 0;
    for (const a of atoms) {
      const f = cache[a.element] === undefined ? (cache[a.element] = factors.evaluate(a.element, s2)) : cache[a.element];
      const amplitude = (a.occupancy == null ? 1 : a.occupancy) * f * Math.exp(-(a.B ?? a.biso ?? 0) * s2);
      const phase = 2 * Math.PI * (h * a.x + k * a.y + l * a.z);
      real += amplitude * Math.cos(phase); imag += amplitude * Math.sin(phase);
    }
    return real * real + imag * imag;
  }

  function reflections(layer, opts = {}) {
    if (!layer || layer.enabled === false) return { reflections: [], hidden: 0, nearZero: 0, maxF2: 0, warnings: [], enumerated: 0 };
    const cell = layer.cell || (layer.parsed && layer.parsed.cell);
    const f = frame(cell, layer.out, layer.in);
    const atoms = atomsOf(layer), domainList = variants(layer);
    const tilt = number(layer.tilt, 0, -180, 180, "Layer tilt"), azimuth = number(layer.azimuth, 0, -360, 360, "Layer azimuth");
    const maxIndex = number(opts.maxIndex, 6, 1, 12, "Maximum Miller index");
    if (!Number.isInteger(maxIndex)) fail("Maximum Miller index must be an integer.");
    const qmax = number(opts.qmax, 1.4, 0.0001, 3.999999999, "Maximum q");
    const threshold = number(opts.threshold, 0.004, 0, 1, "Display threshold");
    const raw = [], warnings = []; let maxF2 = 0, atomWork = 0;
    for (let h = -maxIndex; h <= maxIndex; h++) for (let k = -maxIndex; k <= maxIndex; k++) for (let l = -maxIndex; l <= maxIndex; l++) {
      if (!h && !k && !l) continue;
      const qc = combination(f.reciprocal, [h, k, l]), qabs = norm(qc);
      if (qabs > qmax + 1e-12) continue;
      atomWork += atoms.length;
      if (atomWork > MAX_ATOM_WORK) fail("Reflection calculation exceeds the safe work limit. Reduce maximum index or q range.", "RSM_WORK_LIMIT");
      const F2 = structureFactor(atoms, h, k, l, qabs);
      finite([qabs, F2], "Reflection intensity");
      maxF2 = Math.max(maxF2, F2);
      raw.push({ h, k, l, F2, qabs, q0: rotate(multiply(f.matrix, qc), tilt, azimuth) });
    }
    let hidden = 0, nearZero = 0;
    const result = [];
    const axes0 = identity().map(v => rotate(v, tilt, azimuth));
    for (const r of raw) {
      if (r.F2 <= Math.max(1e-24, maxF2 * 1e-14)) { nearZero++; continue; }
      if (r.F2 < maxF2 * threshold) { hidden++; continue; }
      const scatteringDensity = r.F2 / (f.volume * f.volume);
      finite([scatteringDensity], "Scattering density");
      for (let variant = 0; variant < domainList.length; variant++) {
        const v = domainList[variant];
        const q = rotate(r.q0, v.tilt, v.azimuth);
        result.push({ h: r.h, k: r.k, l: r.l, q, qx: q[0], qy: q[1], qz: q[2], qabs: r.qabs,
          d: 1 / r.qabs, F2: r.F2, cellVolume: f.volume, scatteringDensity,
          relative: r.F2 / maxF2, variant, variantName: v.name, weight: v.weight,
          layer: layer.id || "film", axes: axes0.map(a => rotate(a, v.tilt, v.azimuth)) });
      }
    }
    if (atoms.some(a => a.B == null && a.biso == null)) warnings.push("Some sites have no B_iso; B = 0 is assumed for those sites.");
    /* A dark boundary shell does not imply that the next shell is absent.
       |h|=|q.a|<=qmax*|a| also provides a conservative geometric index bound. */
    const indexBoundary = raw.some(r => Math.max(Math.abs(r.h), Math.abs(r.k), Math.abs(r.l)) === maxIndex) ||
      [cell.a, cell.b, cell.c].some(length => Math.floor(qmax * length + 1e-10) > maxIndex);
    if (indexBoundary) warnings.push("The Miller-index limit may truncate this q range, including reflections beyond extinct shells; increase it if needed.");
    return { reflections: result, hidden, nearZero, maxF2, warnings, enumerated: raw.length, atomWork, frame: f };
  }

  function accessible(qx, qz, lambda = 1.540593, twoThetaMax = 180) {
    number(lambda, 1.540593, 0.1, 10, "Wavelength");
    number(twoThetaMax, 180, 0.01, 180, "Maximum 2θ");
    if (![qx, qz].every(Number.isFinite)) fail("Invalid reciprocal-space point.");
    const r = Math.hypot(qx, qz), sinTheta = lambda * r / 2;
    if (qz < -1e-12 || sinTheta > 1 + 1e-12) return { accessible: false, reason: qz < 0 ? "below-surface" : "ewald", theta: null, twoTheta: null, omega: null, alphaI: null, alphaF: null };
    const theta = Math.asin(Math.min(1, sinTheta)) / D2R;
    const phi = r ? Math.atan2(qx, qz) / D2R : 0;
    const alphaI = theta + phi, alphaF = theta - phi;
    const ok = alphaI >= -1e-10 && alphaF >= -1e-10 && alphaI <= 180 + 1e-10 && alphaF <= 180 + 1e-10 && 2 * theta <= twoThetaMax + 1e-10;
    return { accessible: ok, theta, twoTheta: 2 * theta, omega: alphaI, alphaI, alphaF,
      reason: ok ? "" : (2 * theta > twoThetaMax + 1e-10 ? "detector" : "horizon") };
  }

  function addOuter(c, axis, sigma) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += sigma * sigma * axis[i] * axis[j];
  }
  /* Physical 3D covariance, in Å^-2; no map pixel contribution here.
     Lateral size and thickness follow the layer frame. Microstrain is radial;
     isotropic small-angle mosaic spread is transverse to each reflection. */
  function peakCovariance(r, layer, instrument = {}) {
    const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], axes = r.axes || identity();
    if ((layer.id || r.layer) === "substrate") {
      const width = number(layer.substrateFwhm, 0.001, 0.0000001, 1, "Substrate Gaussian FWHM");
      axes.forEach(a => addOuter(c, a, width / FWHM));
    } else {
      const thickness = number(layer.thicknessNm, 50, 0.1, 1000000, "Film thickness (nm)");
      const coherence = number(layer.coherenceNm, 100, 0.1, 1000000, "In-plane coherence length (nm)");
      addOuter(c, axes[0], 0.886 / (coherence * 10) / FWHM);
      addOuter(c, axes[1], 0.886 / (coherence * 10) / FWHM);
      addOuter(c, axes[2], 0.886 / (thickness * 10) / FWHM);
    }
    const mosaic = number(layer.mosaicDeg, 0.05, 0, 15, "Mosaic FWHM (degrees)") * D2R / FWHM;
    const strain = number(layer.microstrain, 0.0005, 0, 0.2, "Microstrain FWHM (fraction)") / FWHM;
    const radial = scale(r.q, 1 / r.qabs), sigmaM = r.qabs * mosaic;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i][j] += sigmaM * sigmaM * ((i === j ? 1 : 0) - radial[i] * radial[j]);
    addOuter(c, radial, r.qabs * strain);
    ["sigmaX", "sigmaY", "sigmaZ"].forEach((key, i) => {
      const s = number(instrument[key], 0.0005, 0, 0.5, `Instrument ${key}`);
      c[i][i] += s * s;
    });
    finite(c.flat(), "Physical peak covariance");
    return c;
  }

  function sliceProfile(r, covariance, plane, slice) {
    const u = 0, v = plane === "xy" ? 1 : 2, w = plane === "xy" ? 2 : 1;
    finite([...covariance.flat(), ...r.q, slice], "Slice covariance and coordinates");
    const cww = covariance[w][w], offset = slice - r.q[w];
    if (!(cww > 0)) fail("The physical slice covariance is singular.", "RSM_NUMERIC");
    const a = covariance[u][u] - covariance[u][w] ** 2 / cww;
    const b = covariance[u][v] - covariance[u][w] * covariance[v][w] / cww;
    const c = covariance[v][v] - covariance[v][w] ** 2 / cww;
    const determinant = a * c - b * b;
    finite([a, b, c, determinant], "Physical slice covariance");
    if (!(a > 0 && c > 0 && determinant > 0)) fail("The physical slice covariance is not positive definite.", "RSM_NUMERIC");
    const result = { x: r.q[u] + covariance[u][w] * offset / cww,
      y: r.q[v] + covariance[v][w] * offset / cww, a, b, c,
      distance: -offset, hiddenSigma: Math.sqrt(cww),
      density: Math.exp(-0.5 * offset * offset / cww) / Math.sqrt(2 * Math.PI * cww) };
    finite(Object.values(result), "Physical slice density");
    return result;
  }

  /* Point sampling of a Gaussian, even after pixel-aperture broadening, can
     change its discrete integral as its centre moves through a pixel. The
     Poisson-summation identity gives that integral from the Fourier transform
     exp(-2π² k.C.k). Divide by it so the raster conserves each peak's slice
     weight. Pixel variance guarantees C >= diag(dx²,dy²)/12, so terms beyond
     ±3 have magnitude below exp(-2π²*16/12); no large numerical quadrature.
     This corrects intensity sampling, not the advertised width approximation. */
  function discreteGaussianMass(a, b, c, dx, dy, mx, my) {
    let mass = 0;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const variance = a * i * i / (dx * dx) + 2 * b * i * j / (dx * dy) + c * j * j / (dy * dy);
      mass += Math.exp(-2 * Math.PI * Math.PI * variance) * Math.cos(2 * Math.PI * (i * mx + j * my));
    }
    return mass;
  }

  function simulate(state) {
    if (!state || !state.grid) fail("Simulation grid is required.");
    if (state.fringes) fail("The 2D map uses Gaussian size broadening. Use thicknessLine for the separately labelled unbroadened slab profile.", "RSM_UNSUPPORTED");
    const plane = state.plane || "xz";
    if (!["xz", "xy"].includes(plane)) fail("Supported reciprocal-space cuts are xz and xy.");
    const slice = number(state.slice, 0, -4, 4, "Slice offset");
    const width = number(state.grid.width, 600, 16, 600, "Grid width"), height = number(state.grid.height, 450, 16, 450, "Grid height");
    if (![width, height].every(Number.isInteger)) fail("Grid dimensions must be integers.");
    const grid = { ...state.grid, width, height };
    for (const key of ["xmin", "xmax", "ymin", "ymax"]) number(grid[key], NaN, -4, 4, key);
    if (!(grid.xmax > grid.xmin && grid.ymax > grid.ymin)) fail("Grid maximum must exceed its minimum.");
    const dx = (grid.xmax - grid.xmin) / width, dy = (grid.ymax - grid.ymin) / height;
    const lambda = number(state.lambda, 1.540593, 0.1, 10, "Wavelength");
    const twoThetaMax = number(state.twoThetaMax, 180, 0.01, 180, "Maximum 2θ");
    const useMask = plane === "xz" && state.mask !== false;
    if (useMask && Math.abs(slice) > 1e-12) fail("Coplanar accessibility applies only to the Qy = 0 cut. Set slice to 0 or turn the geometry mask off.");
    const arrays = { substrate: new Float32Array(width * height), film: new Float32Array(width * height), total: new Float32Array(width * height) };
    const warnings = [], table = [], jobs = [];
    const qmax = number(state.qmax, 1.4, 0.0001, 3.999999999, "Maximum q");
    // The slice is the third orthogonal coordinate in either plane. With the
    // coplanar mask, reflection centers beyond the detector limit are not shown.
    const viewMax = Math.hypot(Math.max(Math.abs(grid.xmin), Math.abs(grid.xmax)), Math.max(Math.abs(grid.ymin), Math.abs(grid.ymax)), slice);
    const reach = useMask ? Math.min(viewMax, 2 * Math.sin(twoThetaMax * D2R / 2) / lambda) : viewMax;
    if (reach > qmax + 1e-12) warnings.push(`View reaches |q| = ${reach.toFixed(3)} Å⁻¹ but enumeration stops at ${qmax} Å⁻¹; reflection centers beyond it are omitted. Increase maximum |q| in Calculation or narrow the view.`);
    const stats = { enumerated: 0, hidden: 0, nearZero: 0, planeExcluded: 0, outsideView: 0, inaccessible: 0, rendered: 0, underResolved: 0, work: 0 };
    for (const id of ["substrate", "film"]) {
      if (!state[id] || state[id].enabled === false) continue;
      const layer = { ...state[id], id }, info = reflections(layer, state);
      const layerScale = number(layer.scale, 1, 0, 1000000, `${id} intensity scale`);
      stats.enumerated += info.enumerated; stats.hidden += info.hidden; stats.nearZero += info.nearZero;
      warnings.push(...info.warnings.map(w => `${id}: ${w}`));
      for (const r of info.reflections) {
        const covariance = peakCovariance(r, layer, state.instrument), cut = sliceProfile(r, covariance, plane, slice);
        const angles = plane === "xz" && Math.abs(slice) < 1e-12 ? accessible(r.q[0], r.q[2], lambda, twoThetaMax) : null;
        const row = { ...r, covariance, cut, angles, projected: [cut.x, cut.y],
          inSlice: Math.abs(cut.distance) <= 5 * cut.hiddenSigma,
          attenuation: Math.exp(-0.5 * (cut.distance / cut.hiddenSigma) ** 2),
          accessible: angles ? angles.accessible : null, status: "rendered" };
        table.push(row);
        if (Math.abs(cut.distance) > 5 * cut.hiddenSigma) { stats.planeExcluded++; row.status = "outside-cut"; continue; }
        if (angles && !angles.accessible) stats.inaccessible++;
        if (!layerScale) { row.status = "zero-scale"; continue; }
        /* Gaussian approximation to averaging over the rectangular pixel aperture.
           Adds Δq²/12 and preserves integrated 2D intensity. This contribution is
           explicitly reported, and is never included in the physical covariance. */
        const a = cut.a + dx * dx / 12, b = cut.b, c = cut.c + dy * dy / 12;
        const det = a * c - b * b;
        finite([a, b, c, det], "Raster covariance");
        if (!(det > 0)) fail("The peak covariance is singular.");
        const sx = 6 * Math.sqrt(a), sy = 6 * Math.sqrt(c);
        const x0 = Math.max(0, Math.ceil((cut.x - sx - grid.xmin) / dx - 0.5));
        const x1 = Math.min(width - 1, Math.floor((cut.x + sx - grid.xmin) / dx - 0.5));
        const y0 = Math.max(0, Math.ceil((cut.y - sy - grid.ymin) / dy - 0.5));
        const y1 = Math.min(height - 1, Math.floor((cut.y + sy - grid.ymin) / dy - 0.5));
        if (x1 < x0 || y1 < y0) { stats.outsideView++; row.status = "outside-view"; continue; }
        if (Math.sqrt(cut.a) * FWHM < 2 * dx || Math.sqrt(cut.c) * FWHM < 2 * dy) stats.underResolved++;
        stats.work += (x1 - x0 + 1) * (y1 - y0 + 1);
        if (stats.work > MAX_GRID_WORK) fail("Map exceeds the 2-million-pixel work limit. Narrow the q range, reduce mosaic/strain broadening, or lower the grid resolution.", "RSM_WORK_LIMIT");
        const polarization = state.polarization === true && angles && angles.theta != null ? (1 + Math.cos(2 * angles.theta * D2R) ** 2) / 2 : 1;
        const discreteMass = discreteGaussianMass(a, b, c, dx, dy, (cut.x - grid.xmin) / dx - 0.5, (cut.y - grid.ymin) / dy - 0.5);
        finite([discreteMass], "Raster normalization");
        if (!(discreteMass > 0)) fail("Raster normalization must be positive; change the grid range or broadening.", "RSM_NUMERIC");
        const amplitude = layerScale * r.scatteringDensity * r.weight * cut.density * polarization / (2 * Math.PI * Math.sqrt(det) * discreteMass);
        finite([amplitude], "Raster amplitude");
        jobs.push({ id, cut, a, b, c, det, x0, x1, y0, y1,
          /* F/Vcell is invariant to choosing an equivalent supercell. Domain
             fractions are incoherent intensity weights, never amplitudes. */
          amplitude });
        stats.rendered++;
      }
    }
    for (const job of jobs) {
      const target = arrays[job.id], { cut, a, b, c, det, amplitude } = job;
      for (let iy = job.y0; iy <= job.y1; iy++) {
        const y = grid.ymin + (iy + 0.5) * dy - cut.y;
        for (let ix = job.x0; ix <= job.x1; ix++) {
          const x = grid.xmin + (ix + 0.5) * dx - cut.x;
          const exponent = (c * x * x - 2 * b * x * y + a * y * y) / det;
          if (!Number.isFinite(exponent)) fail("Raster exponent exceeds the finite numerical range; check grid and broadening.", "RSM_NUMERIC");
          if (exponent <= 36) target[iy * width + ix] += amplitude * Math.exp(-0.5 * exponent);
        }
      }
    }
    let max = 0;
    for (let iy = 0; iy < height; iy++) for (let ix = 0; ix < width; ix++) {
      const i = iy * width + ix;
      // Check before masking: a geometry mask must not conceal numeric failure.
      if (!Number.isFinite(arrays.substrate[i]) || !Number.isFinite(arrays.film[i])) fail("Raster intensity exceeds the Float32 numerical range; check cell dimensions and intensity scales.", "RSM_NUMERIC");
      if (useMask && !accessible(grid.xmin + (ix + 0.5) * dx, grid.ymin + (iy + 0.5) * dy, lambda, twoThetaMax).accessible) {
        arrays.substrate[i] = 0; arrays.film[i] = 0;
      }
      arrays.total[i] = arrays.substrate[i] + arrays.film[i];
      if (!Number.isFinite(arrays.total[i])) fail("Combined raster intensity exceeds the Float32 numerical range; reduce intensity scales.", "RSM_NUMERIC");
      max = Math.max(max, arrays.total[i]);
    }
    if (stats.underResolved) warnings.push(`${stats.underResolved} peaks are narrower than two map pixels. Pixel sampling broadening (variance Δq²/12) is included; zoom in before interpreting widths.`);
    if (!max) warnings.push("No intensity in this view. Check orientation, slice offset, q range, threshold and geometry mask.");
    if (plane === "xy") warnings.push("Qx–Qy is a reciprocal-space slice; the coplanar Qx–Qz accessibility mask does not apply.");
    return { ...arrays, width, height, grid, dx, dy, plane, slice, reflections: table, stats, warnings, max,
      sampling: "pixel-centres; Gaussian pixel-aperture approximation with discrete integral correction",
      intensity: "|F/Vcell|² times unit-integral 3D Gaussian profiles, arbitrary relative layer scales" };
  }

  /* Aligned cube-on-cube (001), isotropic biaxial plane stress only.
     Never mutates the reference cells. Direct cell edits deactivate this model in UI. */
  function elastic(substrate, filmReference, R, nu = 0.3) {
    const cubic = c => { cellGeometry(c); return [c.alpha, c.beta, c.gamma].every(a => Math.abs(a - 90) < 1e-7) && Math.max(Math.abs(c.a - c.b), Math.abs(c.a - c.c)) / c.a < 1e-6; };
    if (!cubic(substrate) || !cubic(filmReference)) fail("Elastic relaxation requires cubic reference cells and aligned (001)/[100] orientations; use direct editing otherwise.");
    R = number(R, 1, 0, 1, "Relaxation R");
    nu = number(nu, 0.3, 0, 0.499999999, "Poisson ratio ν");
    const a = substrate.a + R * (filmReference.a - substrate.a);
    const epsilonParallel = (a - filmReference.a) / filmReference.a;
    const epsilonNormal = -2 * nu / (1 - nu) * epsilonParallel;
    const cell = { ...filmReference, a, b: a, c: filmReference.c * (1 + epsilonNormal) };
    cellGeometry(cell);
    return { cell, epsilonParallel, epsilonNormal, misfit: (filmReference.a - substrate.a) / substrate.a, R, nu };
  }

  /* Continuous uniform slab, unbroadened analytical line through one reciprocal
     lattice point. This is not an atomically discrete Laue function. */
  function thicknessLine(deltaQNormal, thicknessNm) {
    const thickness = number(thicknessNm, 50, 0.1, 1000000, "Film thickness (nm)") * 10;
    if (!Number.isFinite(deltaQNormal)) fail("Invalid profile coordinate.");
    const x = Math.PI * thickness * deltaQNormal;
    return Math.abs(x) < 1e-8 ? 1 : (Math.sin(x) / x) ** 2;
  }

  return { frame, reflections, structureFactor, accessible, peakCovariance, sliceProfile, simulate, elastic,
    thicknessLine, rotate, cellGeometry, FWHM, convention: "q = 1/d, no 2π, Å^-1", limits: { maxIndex: 12, width: 600, height: 450, gridWork: MAX_GRID_WORK, atomWork: MAX_ATOM_WORK } };
});
