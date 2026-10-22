"use strict";

window.XRDLocal = (() => {
  const scriptUrl = new URL(document.currentScript.src || document.baseURI);
  const jobs = new Map();
  const jobPattern = /^[A-Za-z0-9_-]{1,64}$/;
  const maxBodyBytes = 12 * 1024 * 1024;
  let dataPromise;

  async function data() {
    if (!dataPromise) {
      dataPromise = (async () => {
        const loaded = await readJson(new URL("xrd_data.json", scriptUrl));
        XRDCore.useData(loaded);
        XRDFit.useCore(XRDCore);
        return loaded;
      })();
    }
    return dataPromise;
  }

  async function readJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`요청이 실패했습니다. (HTTP ${response.status})`);
    return response.json();
  }

  function numeric(value, label, strict = false) {
    if (value === null || value === undefined || typeof value === "string" && !value.trim()
        || strict && !["number", "string"].includes(typeof value)) {
      throw new Error(`${label} must be a finite number`);
    }
    const result = Number(value);
    if (!Number.isFinite(result)) throw new Error(`${label} must be a finite number`);
    return result;
  }

  function parameters(values, catalogue) {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error("Request needs a parameters object");
    }
    const unexpected = Object.keys(values).filter((key) => !(key in XRDCore.DEFAULTS)).sort();
    if (unexpected.length) throw new Error(`Unknown model parameter: ${unexpected.join(", ")}`);
    let params = Object.assign({}, XRDCore.DEFAULTS, values);
    for (const key of ["wavelength", "film_lattice_a", "film_lattice_c", "substrate_lattice_a",
                       "substrate_lattice_c", "angle_offset_deg", "fwhm_deg", "background",
                       "film_lattice_gradient_a", "film_interface_width",
                       "film_thickness_sigma", "background_slope",
                       "resolution_halo_fraction", "resolution_halo_width", "film_intensity_scale"]) {
      params[key] = numeric(params[key], key, (key.startsWith("resolution_halo_") || ["film_intensity_scale", "film_lattice_c"].includes(key)));
    }
    for (const key of ["film_planes", "substrate_planes"]) {
      const count = numeric(params[key], key);
      const maximum = key === "substrate_planes" ? 30000 : 20000;
      if (!Number.isInteger(count) || count < 0 || count > maximum) {
        throw new Error(`${key} must be an integer from 0 to ${maximum.toLocaleString("en")}`);
      }
      params[key] = count;
    }
    XRDCore.parseHkl(params.hkl);
    params = XRDCore.normalizeParams(params);
    if (!(params.substrate_material in catalogue.substrates)) {
      throw new Error(`Supported substrates: ${Object.keys(catalogue.substrates).join(", ")}`);
    }
    for (const key of ["wavelength", "film_lattice_a", "substrate_lattice_a"]) {
      if (params[key] <= 0) throw new Error(`${key} must be a finite positive number`);
    }
    if (!params.film_planes && !params.substrate_planes) {
      throw new Error("At least one of film_planes and substrate_planes must be positive");
    }
    if (params.substrate_lattice_c < 0) {
      throw new Error("substrate_lattice_c must be zero (use a) or positive");
    }
    if (params.fwhm_deg < 0) throw new Error("fwhm_deg must be nonnegative");
    if (params.resolution_halo_fraction < 0 || params.resolution_halo_fraction > 0.2) {
      throw new Error("resolution_halo_fraction must be within 0 to 0.2");
    }
    if (params.resolution_halo_width < 1 || params.resolution_halo_width > 20) {
      throw new Error("resolution_halo_width must be within 1 to 20");
    }
    if (params.background < 0 || params.background >= 1) {
      throw new Error("background must be between 0 (inclusive) and 1 (exclusive)");
    }
    if (Math.abs(params.film_lattice_gradient_a) > 0.2) {
      throw new Error("film_lattice_gradient_a must be within -0.2 to 0.2 Å");
    }
    const gradientMean = XRDCore.filmActiveLatticeKey(params) === "film_lattice_c"
      ? XRDCore.filmLattice(params)[1] : params.film_lattice_a;
    if (gradientMean - Math.abs(params.film_lattice_gradient_a) / 2 <= 0) {
      throw new Error("The film lattice gradient gives a nonpositive local lattice parameter");
    }
    if (params.film_lattice_gradient_a && params.film_planes < 2) {
      throw new Error("A film lattice gradient needs at least two film repeats");
    }
    for (const [key, maximum] of [["film_interface_width", 1000], ["film_thickness_sigma", 20]]) {
      if (params[key] < 0 || params[key] > maximum) throw new Error(`${key} must be in [0, ${maximum}]`);
    }
    if (Math.abs(params.background_slope) > 1) throw new Error("background_slope must be in [-1, 1]");
    if (!["none", "synchrotron_vertical", "synchrotron_horizontal", "lab_unpolarized",
          "synchrotron_vertical_footprint", "synchrotron_horizontal_footprint", "lab_unpolarized_footprint"].includes(params.lp_mode)) {
      throw new Error("Unknown lp_mode");
    }
    return params;
  }

  function scanAngles(scan) {
    if (!scan || typeof scan !== "object" || Array.isArray(scan)) {
      throw new Error("Request needs a scan object");
    }
    const xmin = numeric(scan.xmin, "2θ start");
    const xmax = numeric(scan.xmax, "2θ end");
    const step = numeric(scan.step, "2θ step");
    if (!(xmin > 0 && xmin < xmax && xmax < 180)) {
      throw new Error("2θ start/end must increase within 0°–180°");
    }
    if (step < 0.001 || step > 1) throw new Error("2θ step must be between 0.001° and 1°");
    const count = Math.floor((xmax - xmin) / step + 1e-9) + 1;
    const angles = Array.from({length: count}, (_, index) => xmin + index * step);
    if (xmax - angles.at(-1) > Math.max(1e-9, step * 1e-7)) angles.push(xmax);
    if (angles.length < 3 || angles.length > 20001) {
      throw new Error("Scan must have 3–20,001 calculation points");
    }
    return angles;
  }

  function simulate(request, catalogue) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Expected a JSON object");
    }
    if (!request.parameters || !request.scan) {
      throw new Error("Request needs parameters and scan objects");
    }
    const params = parameters(request.parameters, catalogue);
    const angles = scanAngles(request.scan);
    const intensities = XRDCore.simulate(angles, params);
    let filmPeak = null, substratePeak = null;
    try {
      filmPeak = XRDCore.filmBraggAngle(params) + params.angle_offset_deg;
      if (params.film_basis === "rutile" && XRDCore.rutileReflectionAbsent(XRDCore.parseHkl(params.hkl))) filmPeak = null;
    } catch (error) {}
    try {
      const [substrateA, substrateC, system] = XRDCore.substrateLattice(params);
      substratePeak = XRDCore.braggAngle(substrateA, params.hkl, params.wavelength,
                                         substrateC, system) + params.angle_offset_deg;
      if (params.substrate_material === "TiO2" && XRDCore.rutileReflectionAbsent(XRDCore.parseHkl(params.hkl))) substratePeak = null;
    } catch (error) {}
    return {angles, intensities, film_peak: filmPeak, substrate_peak: substratePeak};
  }

  function decodeBytes(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", {fatal: true}).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", {fatal: true}).decode(bytes);
    for (const encoding of ["utf-8", "euc-kr"]) {
      try { return new TextDecoder(encoding, {fatal: true}).decode(bytes); }
      catch (error) {}
    }
    return Array.from(bytes, (value) => String.fromCharCode(value)).join("");
  }

  function parseNumber(value) {
    if (/^[+-]?(?:nan|inf|infinity)$/i.test(value)) {
      return /^[-]/.test(value) ? -Infinity : Infinity;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return NaN;
    return Number(value);
  }

  function parseMeasurement(bytes, filename) {
    const lines = decodeBytes(bytes).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    const angles = [], intensities = [];
    lines.forEach((line, index) => {
      const stripped = line.trim();
      if (!stripped || ["#", "%", "//", ";"].some((prefix) => stripped.startsWith(prefix))) return;
      const columns = stripped.split(/[,\s]+/);
      if (columns.length < 2) {
        if (angles.length) throw new Error(`Line ${index + 1}: expected angle and intensity columns`);
        return;
      }
      const angle = parseNumber(columns[0]);
      const intensity = parseNumber(columns[1]);
      if (Number.isNaN(angle) || Number.isNaN(intensity)) {
        if (angles.length) throw new Error(`Line ${index + 1}: invalid angle or intensity`);
        return;
      }
      if (!Number.isFinite(angle) || angle <= 0 || angle >= 180) {
        throw new Error(`Line ${index + 1}: 2-theta must be finite and between 0 and 180`);
      }
      if (!Number.isFinite(intensity) || intensity < 0) {
        throw new Error(`Line ${index + 1}: intensity must be finite and nonnegative`);
      }
      if (angles.length && angle <= angles.at(-1)) {
        throw new Error(`Line ${index + 1}: 2-theta values must increase strictly`);
      }
      angles.push(angle);
      intensities.push(intensity);
    });
    if (angles.length < 2) throw new Error("At least two two-column numeric XRD points are required");
    if (!intensities.some((intensity) => intensity > 0)) {
      throw new Error("Measurement has no positive intensity values");
    }
    return {angles, intensities, filename};
  }

  function fitRequest(request, catalogue) {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("Expected a JSON object");
    }
    const params = parameters(request.parameters, catalogue);
    const measurement = request.measurement;
    const fit = request.fit;
    if (!measurement || typeof measurement !== "object" || !fit || typeof fit !== "object") {
      throw new Error("Request needs measurement and fit objects");
    }
    const angles = measurement.angles, intensities = measurement.intensities;
    if (!Array.isArray(angles) || !Array.isArray(intensities) || angles.length !== intensities.length
        || angles.length < 3 || angles.length > 200000) {
      throw new Error("Measurement needs 3–200,000 matching angle/intensity values");
    }
    let previous = -Infinity, positive = false;
    const parsedAngles = [], parsedIntensities = [];
    angles.forEach((angle, index) => {
      const x = numeric(angle, `measurement angle ${index + 1}`);
      const y = numeric(intensities[index], `measurement intensity ${index + 1}`);
      if (x <= 0 || x >= 180 || x <= previous) {
        throw new Error("Measurement angles must increase strictly within 0–180°");
      }
      if (y < 0) throw new Error("Measurement intensities must be nonnegative");
      positive = positive || y > 0;
      parsedAngles.push(x);
      parsedIntensities.push(y);
      previous = x;
    });
    if (!positive) throw new Error("Measurement needs at least one positive intensity");
    if (!Array.isArray(fit.range) || fit.range.length !== 2) {
      throw new Error("fit.range needs [2θ start, 2θ end]");
    }
    const low = numeric(fit.range[0], "fit start"), high = numeric(fit.range[1], "fit end");
    if (!(low > 0 && low < high && high < 180)) {
      throw new Error("Fit range must increase within 0–180°");
    }
    const allowed = new Set(["film_lattice_a", "film_lattice_c", "film_planes", "angle_offset_deg", "fwhm_deg",
                             "substrate_planes", "background", "film_lattice_gradient_a",
                             "film_interface_width", "film_thickness_sigma", "background_slope",
                             "resolution_halo_fraction", "resolution_halo_width", "film_intensity_scale"]);
    if (!fit.bounds || typeof fit.bounds !== "object" || Array.isArray(fit.bounds)) {
      throw new Error("fit.bounds must be an object");
    }
    const unknown = Object.keys(fit.bounds).filter((key) => !allowed.has(key)).sort();
    if (unknown.length) throw new Error(`Unknown fit parameter: ${unknown.join(", ")}`);
    if (!Object.keys(fit.bounds).length) throw new Error("Select at least one parameter to fit");
    const bounds = {};
    for (const [key, interval] of Object.entries(fit.bounds)) {
      if (!Array.isArray(interval) || interval.length !== 2) {
        throw new Error(`${key} bounds need [minimum, maximum]`);
      }
      const minimum = numeric(interval[0], `${key} minimum`, (key.startsWith("resolution_halo_") || ["film_intensity_scale", "film_lattice_c"].includes(key)));
      const maximum = numeric(interval[1], `${key} maximum`, (key.startsWith("resolution_halo_") || ["film_intensity_scale", "film_lattice_c"].includes(key)));
      if (minimum >= maximum) throw new Error(`${key} minimum must be less than maximum`);
      if (["film_lattice_a", "film_lattice_c"].includes(key) && minimum <= 0) throw new Error(`${key} minimum must be positive`);
      if (key === "film_lattice_c" && params.film_system !== "tetragonal") throw new Error("film_lattice_c can only be fitted for tetragonal films");
      if (key === "film_planes" || key === "substrate_planes") {
        const limit = key === "film_planes" ? 20000 : 30000;
        if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || minimum < 0 || maximum > limit) {
          throw new Error(`${key} bounds must be integers from 0 to ${limit.toLocaleString("en")}`);
        }
      }
      if (key === "film_intensity_scale" && !(minimum >= 0 && maximum <= 100)) throw new Error("film_intensity_scale bounds must be in [0,100]");
      if (key === "fwhm_deg" && minimum < 0) throw new Error("fwhm_deg minimum must be nonnegative");
      if (key === "resolution_halo_fraction" && !(minimum >= 0 && maximum <= 0.2)) {
        throw new Error("resolution_halo_fraction bounds must be in [0,0.2]");
      }
      if (key === "resolution_halo_width" && !(minimum >= 1 && maximum <= 20)) {
        throw new Error("resolution_halo_width bounds must be in [1,20]");
      }
      if (key === "background" && !(minimum >= 0 && maximum < 1)) {
        throw new Error("background bounds must be in [0,1)");
      }
      if (key === "film_lattice_gradient_a" && !(minimum >= -0.2 && maximum <= 0.2)) {
        throw new Error("film_lattice_gradient_a bounds must be in [-0.2,0.2] Å");
      }
      if (key === "film_interface_width" || key === "film_thickness_sigma") {
        const limit = key === "film_interface_width" ? 1000 : 20;
        if (!(minimum >= 0 && maximum <= limit)) throw new Error(`${key} bounds must be in [0,${limit}]`);
      }
      if (key === "background_slope" && !(minimum >= -1 && maximum <= 1)) {
        throw new Error("background_slope bounds must be in [-1,1]");
      }
      bounds[key] = [minimum, maximum];
    }
    const budget = numeric(fit.max_evaluations === undefined ? 400 : fit.max_evaluations, "max_evaluations");
    if (!Number.isInteger(budget) || budget < 50 || budget > 6000) {
      throw new Error("max_evaluations must be an integer from 50 to 6,000");
    }
    let thicknessBoundsNm = null;
    if ("thickness_bounds_nm" in fit) {
      if (!Array.isArray(fit.thickness_bounds_nm) || fit.thickness_bounds_nm.length !== 2) {
        throw new Error("fit.thickness_bounds_nm needs [minimum, maximum]");
      }
      const minimum = numeric(fit.thickness_bounds_nm[0], "Thickness minimum");
      const maximum = numeric(fit.thickness_bounds_nm[1], "Thickness maximum");
      if (!(minimum >= 0 && minimum < maximum)) {
        throw new Error("Thickness minimum must be nonnegative and less than maximum");
      }
      if (!("film_planes" in bounds)) {
        throw new Error("Thickness bounds require film_planes search bounds");
      }
      thicknessBoundsNm = [minimum, maximum];
    }
    const referenceAngles = "scan" in fit ? scanAngles(fit.scan) : null;
    if (referenceAngles && (low < referenceAngles[0] || high > referenceAngles.at(-1))) {
      throw new Error("Fit range must lie within the calculation scan");
    }
    if (request.job != null && (typeof request.job !== "string" || !jobPattern.test(request.job))) {
      throw new Error("job must be 1–64 characters of letters, digits, dash or underscore");
    }
    return {parameters: params, measurement: {angles: parsedAngles, intensities: parsedIntensities},
            fit: {range: [low, high], bounds, max_evaluations: budget,
                  thickness_bounds_nm: thicknessBoundsNm}, referenceAngles, job: request.job};
  }

  function runFit(request) {
    if (request.job && jobs.size >= 8) throw new Error("Too many fits are already running");
    const worker = new Worker(new URL("xrd_worker.js", scriptUrl));
    const entry = {worker, evaluations: 0, best: null, started: performance.now(), cancel: false};
    if (request.job) jobs.set(request.job, entry);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (request.job && jobs.get(request.job) === entry) jobs.delete(request.job);
        if (error) reject(error); else resolve(value);
      };
      entry.cancelFit = () => finish({cancelled: true});
      worker.onmessage = ({data: message}) => {
        if (message.type === "progress") {
          entry.evaluations = message.evaluations;
          entry.best = Number.isFinite(message.best) ? message.best : null;
        } else if (message.type === "result") finish(message.result);
        else if (message.type === "error") finish(null, new Error(message.error));
      };
      worker.onerror = (event) => finish(null, new Error(event.message || "Fit worker failed"));
      worker.postMessage(request);
    });
  }

  async function getJson(url, options = {}) {
    const route = new URL(url, document.baseURI);
    const method = options.method || "GET";
    const catalogue = await data();
    if (method === "GET" && route.pathname === "/api/catalogue") {
      return {substrates: Object.entries(catalogue.substrates).map(([id, entry]) => ({
        id, label: entry.label, system: entry.system, a: entry.a, c: entry.c ?? entry.a,
        modelled: ["perovskite", "rutile"].includes(entry.basis), basis: entry.basis, suggest: entry.suggest || "001",
        centering: entry.centering || "P", note: entry.note || ""
      })), films: XRDCore.filmCatalogue().map(film => film.id), film_catalogue: XRDCore.filmCatalogue(), common_hkl: catalogue.common_hkl};
    }
    if (method === "GET" && route.pathname === "/api/sample") {
      const bytes = new Uint8Array(await (await fetch(new URL("sample_data.dat", scriptUrl))).arrayBuffer());
      return parseMeasurement(bytes, "sample_data.dat");
    }
    if (method === "GET" && route.pathname === "/api/fit/status") {
      const job = route.searchParams.get("job") || "";
      if (!jobPattern.test(job)) throw new Error("Invalid job id");
      const entry = jobs.get(job);
      return entry ? {running: true, evaluations: entry.evaluations, best: entry.best,
                      elapsed: Math.round((performance.now() - entry.started) / 100) / 10,
                      cancel: entry.cancel} : {running: false};
    }
    if (method !== "POST") throw new Error("Not found");
    if (route.pathname === "/api/parse") {
      const bytes = new Uint8Array(options.body);
      if (!bytes.length || bytes.length > maxBodyBytes) {
        throw new Error("File/request is empty or exceeds 12 MB");
      }
      const encodedName = options.headers && options.headers["X-Filename"] || "measurement.dat";
      const filename = decodeURIComponent(encodedName).split("/").at(-1);
      return parseMeasurement(bytes, filename);
    }
    let request;
    try { request = JSON.parse(options.body); }
    catch (error) { throw new Error("Invalid JSON request"); }
    if (route.pathname === "/api/fringes") return XRDFringes.estimate(request);
    if (route.pathname === "/api/peaks") return XRDPeaks.analyzePeaks(request);
    if (route.pathname === "/api/simulate") return simulate(request, catalogue);
    if (route.pathname === "/api/fit") return runFit(fitRequest(request, catalogue));
    if (route.pathname === "/api/fit/cancel") {
      const job = request && request.job;
      if (typeof job !== "string" || !jobPattern.test(job)) {
        throw new Error("job must be 1–64 characters of letters, digits, dash or underscore");
      }
      const entry = jobs.get(job);
      if (entry) { entry.cancel = true; entry.cancelFit(); }
      return {cancelled: Boolean(entry)};
    }
    throw new Error("Not found");
  }

  return {getJson};
})();
