"use strict";

const $ = (id) => document.getElementById(id);
// Saved fit scores are only valid for the numerical model that produced them.
const modelRevision = "rutile-fringe-v1";
const materials = new Set(["SrRuO3", "SrTiO3", "BaTiO3", "LaAlO3", "LaMnO3", "LaNiO3", "SrVO3", "VO2", "TiO2"]);
/* Any hkl may be typed: "110", "1 1 0", "(1,1,0)", or "0 0 6" for a hexagonal
   substrate. Four-index hexagonal input (hkil) drops the redundant third index. */
const maxMillerIndex = 30;
function parseHkl(text) {
  const cleaned = String(text ?? "").trim().replace(/[()\[\]]/g, "");
  if (!cleaned) throw new Error("Enter a reflection (hkl). For example 110");
  let parts;
  if (/^-?\d(\s|,|-)/.test(cleaned) || /[\s,]/.test(cleaned)) {
    parts = cleaned.split(/[\s,]+/).filter(Boolean);
  } else if (/^\d+$/.test(cleaned) && (cleaned.length === 3 || cleaned.length === 4)) {
    parts = cleaned.split("");
  } else {
    parts = cleaned.split(/[\s,]+/).filter(Boolean);
  }
  if (parts.length === 4) parts = [parts[0], parts[1], parts[3]];   // (hkil) -> (hkl)
  if (parts.length !== 3) throw new Error("A reflection has three indices. For example 110, 0 0 6, 1 -1 2");
  const values = parts.map(part => {
    if (!/^-?\d+$/.test(part)) throw new Error("Reflection indices must be whole numbers. For example 110, 0 0 6");
    return Number(part);
  });
  if (values.every(value => value === 0)) throw new Error("The reflection indices cannot all be zero.");
  if (values.some(value => Math.abs(value) > maxMillerIndex)) throw new Error(`Reflection indices must be within ±${maxMillerIndex}.`);
  return values;
}
const hklText = (values) => values.every(v => v >= 0 && v < 10) ? values.join("") : values.join(" ");
const normaliseHkl = (text) => hklText(parseHkl(text));
const numericParameters = ["wavelength", "film_lattice_a", "film_lattice_c", "film_lattice_gradient_a", "film_interface_width", "film_thickness_sigma", "film_intensity_scale", "substrate_lattice_a", "substrate_lattice_c", "substrate_planes", "angle_offset_deg", "fwhm_deg", "resolution_halo_fraction", "resolution_halo_width", "background", "background_slope"];
const optionalModelDefaults = {film_intensity_scale:1,film_lattice_c:0,film_lattice_gradient_a:0, substrate_lattice_c:0, film_interface_width:0, film_thickness_sigma:0, background_slope:0, resolution_halo_fraction:0, resolution_halo_width:3};
const lpModes = new Set(["none", "synchrotron_vertical", "synchrotron_horizontal", "lab_unpolarized", "synchrotron_vertical_footprint", "synchrotron_horizontal_footprint", "lab_unpolarized_footprint"]);
const numericScan = ["xmin", "xmax", "step"];
const fitKeys = ["film_lattice_a", "film_lattice_c", "film_lattice_gradient_a", "film_planes", "film_interface_width", "film_thickness_sigma", "film_intensity_scale", "angle_offset_deg", "fwhm_deg", "resolution_halo_fraction", "resolution_halo_width", "substrate_planes", "background", "background_slope"];
const optionalFitKeys = new Set(["film_lattice_c", "film_lattice_gradient_a", "film_interface_width", "film_thickness_sigma", "film_intensity_scale", "background_slope", "resolution_halo_fraction", "resolution_halo_width"]);
const fitIntegerKeys = new Set(["film_planes", "substrate_planes"]);
const fitBudgetOptions = new Set([400, 800, 1200, 3000, 6000]);
const substrateFitMax = 30000;
const modelInputIds = new Set([...numericParameters, ...numericScan, "film_thickness_nm", "hkl", "film_material", "substrate_material", "film_system", "film_basis", "lp_mode"]);
/* Filled from /api/catalogue at start-up: the substrate list the server knows. */
const substrates = new Map();
const films = new Map([
  ["VO2", {id:"VO2", label:"VO₂ (rutile R)", system:"tetragonal", basis:"rutile", a:4.5546, c:2.8514}],
  ["TiO2", {id:"TiO2", label:"TiO₂ (rutile)", system:"tetragonal", basis:"rutile", a:4.5937, c:2.9587}]
]);
function filmMetadata(material) {
  return films.get(material) || {system:"cubic", basis:"perovskite"};
}
const state = {
  measurement: null,
  measurementSource: null,
  intensityRequest: 0,
  importRequest: 0,
  intensityPending: false,
  intensityAdjustScan: false,
  simulation: null,
  config: null,
  configSignature: "",
  view: [28, 38],
  logScale: true,
  plot: null,
  stats: null,
  hover: null,
  dragStart: null,
  dragEnd: null,
  requestId: 0,
  fitWatch: null,
  framePending: false,
  fitBusy: false,
  fitResult: null,
  residual: null,
  lastFilmPlanes: 60,
  filmFitMode: null,
  fringe: null,
  fringeRequest: 0,
  peakAnalysis: null,
  peakRequest: 0
};

function setStatus(message, error = false) {
  const node = $("status");
  node.textContent = message;
  node.classList.toggle("error", error);
}

function setFitProgress(message, kind = "") {
  const node = $("fitProgress");
  node.textContent = message;
  node.classList.toggle("error", kind === "error");
  node.classList.toggle("success", kind === "success");
  node.classList.toggle("warning", kind === "warning");
}

function setFitBusy(busy) {
  state.fitBusy = busy;
  $("runFit").classList.toggle("is-busy", busy);
  for (const node of document.querySelectorAll("#settingsForm input, #settingsForm select, #settingsForm button, .head-actions button, .data-card input, .data-card select, .data-card button")) node.disabled = busy;
  // the one control that has to stay alive while everything else is locked
  const cancel = $("cancelFit");
  if (cancel) { cancel.hidden = !busy; cancel.disabled = false; }
  if (!busy) { refreshFitControls(); refreshIntensityControls(); }
}

/* A fit runs for about a minute in one blocking request, so the page asks the
   server how far it has got instead of leaving a spinner with no number on it. */
function startFitWatch(job, maxEvaluations, rangeText) {
  const began = Date.now();
  const tick = async () => {
    const seconds = Math.round((Date.now() - began) / 1000);
    let detail = "";
    try {
      const status = await getJson(`/api/fit/status?job=${encodeURIComponent(job)}`);
      if (status && status.running) {
        const best = typeof status.best === "number" ? ` · best error so far ${status.best.toFixed(3)}` : "";
        detail = ` · ${status.evaluations.toLocaleString("en")}/${maxEvaluations.toLocaleString("en")} evaluations${best}`;
      }
    } catch (error) { /* the status call is a courtesy; never fail the fit over it */ }
    if (!state.fitWatch || state.fitWatch.job !== job) return;
    setFitProgress(`Fitting… ${rangeText}${detail} · ${seconds} s elapsed · press the button below to stop`);
  };
  tick();
  state.fitWatch = {job, timer: setInterval(tick, 1000)};
}

function stopFitWatch() {
  if (state.fitWatch) clearInterval(state.fitWatch.timer);
  state.fitWatch = null;
}

async function cancelFit() {
  const watch = state.fitWatch;
  if (!watch) return;
  const button = $("cancelFit");
  if (button) { button.disabled = true; button.textContent = "Stopping…"; }
  setFitProgress("Stopping the fit…", "warning");
  try {
    await getJson("/api/fit/cancel", {method: "POST", headers: {"Content-Type": "application/json"},
                                      body: JSON.stringify({job: watch.job})});
  } catch (error) { /* the fit will still be told to stop on its next trial */ }
}

function hideFitResult({clearResidual = false} = {}) {
  state.fitResult = null;
  $("fitResult").hidden = true;
  $("fitResult").classList.remove("is-stale");
  $("fitStale").hidden = true;
  if (clearResidual) {
    state.residual = null;
    $("residualCard").hidden = true;
  }
  renderFringeComparison();
}

function markFitResultStale() {
  if (!state.fitResult || state.fitResult.stale) return;
  state.fitResult.stale = true;
  $("fitResult").classList.add("is-stale");
  $("fitStale").hidden = false;
  $("fitResult").querySelector(".eyebrow").textContent = "PREVIOUS FIT";
  $("fit-result-title").textContent = "Previous fit · needs refitting";
  renderFringeComparison();
}

function markCurveStale() {
  if (state.simulation) $("curveStale").hidden = false;
}

function explainModelError(error) {
  const message = String(error?.message || error);
  if (/no finite diffraction intensity/i.test(message)) {
    return "The calculated intensity is zero here. Either lattice centering forbids the reflection you chose on this substrate (switch to an allowed one), or both the film and substrate repeat counts are zero.";
  }
  if (/Gaussian broadening needs .* integration steps|integration grid|120,000 integration steps/i.test(message)) {
    return "The integration grid exceeds 120,000 steps under these conditions. Reduce the 2θ calculation scan, substrate coherent repeats, or broad resolution component width multiplier m. Narrowing the fit range also requires adjusting the calculation scan.";
  }
  if (/Resolution (?:halo )?convolution is too large/i.test(message)) {
    return "The resolution convolution exceeds the work limit. Reduce FWHM, coherence repeats, scan points, or the wider component's width multiplier m.";
  }
  if (/Footprint broadening reaches zero incidence/i.test(message)) {
    return "The resolution window reaches 2θ=0°, where the footprint approximation cannot be used. Reduce FWHM or the width multiplier m, or turn off the footprint correction.";
  }
  if (/Film domain\/taper (calculation|integration) is too large/i.test(message)) {
    return "The thickness-domain/taper calculation exceeds the work limit. Narrow the calculation scan or reduce thickness spread, lattice gradient, or coherent repeat counts.";
  }
  return message;
}

function numericField(id) {
  const value = $(id).value.trim();
  if (!value) throw new Error(`Enter a value for ${labelFor(id)}.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${labelFor(id)} must be a finite number.`);
  return number;
}

function labelFor(id) {
  if (id === "film_lattice_gradient_a") return filmGradientLabel();
  return ({wavelength:"Wavelength",film_lattice_a:"Film mean lattice constant a",film_lattice_c:"Film mean lattice constant c",film_lattice_gradient_a:"Film out-of-plane lattice gradient Δa",film_interface_width:"Film boundary taper width w",film_thickness_sigma:"Film thickness spread σN",film_intensity_scale:"Film relative intensity scale",substrate_lattice_a:"Substrate lattice constant",substrate_lattice_c:"Substrate c axis",film_planes:"Thickness",film_thickness_nm:"Thickness",substrate_planes:"Substrate coherent repeats",angle_offset_deg:"2θ zero offset",fwhm_deg:"Instrumental Gaussian FWHM",resolution_halo_fraction:"Broad resolution component fraction f",resolution_halo_width:"Broad resolution component width multiplier m",background:"Relative background",background_slope:"Log background slope",lp_mode:"Polarization / illuminated length",xmin:"2θ start",xmax:"2θ end",step:"Calculation step"})[id] || id;
}

function gcd3(h, k, l) {
  const gcd = (x, y) => y ? gcd(y, x % y) : x;
  return gcd(gcd(Math.abs(h), Math.abs(k)), Math.abs(l)) || 1;
}
// Shared by desktop and static UI: no dependency on the browser-only kernel.
function latticeD(a, hkl, c = 0, system = "cubic") {
  let values;
  try { values = parseHkl(hkl); } catch (error) { return NaN; }
  const [h, k, l] = values, axisC = c || a;
  if (!(a > 0) || !(axisC > 0)) return NaN;
  const inverse = system === "hexagonal" ? 4 * (h*h + h*k + k*k) / (3*a*a) + l*l/(axisC*axisC)
    : system === "tetragonal" ? (h*h + k*k)/(a*a) + l*l/(axisC*axisC)
    : (h*h + k*k + l*l)/(a*a);
  return 1 / Math.sqrt(inverse);
}
function projectedRepeatNm(a, hkl, c = 0, system = "cubic") {
  try { return latticeD(a, hkl, c, system) * gcd3(...parseHkl(hkl)) / 10; }
  catch (error) { return NaN; }
}
function filmFormGeometry() {
  return {film_lattice_a:Number($("film_lattice_a").value), film_lattice_c:Number($("film_lattice_c").value),
    film_system:$("film_system").value, film_basis:$("film_basis").value, hkl:$("hkl").value};
}
function filmRepeatNm(p) { return projectedRepeatNm(p.film_lattice_a, p.hkl, p.film_lattice_c, p.film_system); }
function filmAxisMode(p = filmFormGeometry()) {
  if (p.film_system !== "tetragonal") return "cubic";
  try { const [h,k,l] = parseHkl(p.hkl); return !h && !k ? "00l" : !l ? "hk0" : "mixed"; }
  catch (error) { return "mixed"; }
}
function filmActiveMean(p) { return filmAxisMode(p) === "00l" ? p.film_lattice_c || p.film_lattice_a : p.film_lattice_a; }
function filmGradientLabel(p = filmFormGeometry()) {
  return filmAxisMode(p) === "00l" ? "Film out-of-plane lattice gradient Δc" : "Film out-of-plane lattice gradient Δa";
}
function rutileReflectionAbsent(values) {
  const [h,k,l] = values;
  return (h === 0 && (k+l)%2 !== 0) || (k === 0 && (h+l)%2 !== 0);
}

function thicknessToPlanes(thicknessNm, a, hkl, c = 0, system = "cubic") {
  if (!Number.isFinite(thicknessNm) || thicknessNm < 0) throw new Error("Thickness must be 0 nm or more.");
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(projectedRepeatNm(a, hkl, c, system))) throw new Error("Converting a thickness needs a valid lattice constant and reflection.");
  const planes = Math.round(thicknessNm / projectedRepeatNm(a, hkl, c, system));
  if (planes > 20000) throw new Error("That thickness is beyond the model limit of 20,000 repeats.");
  return planes;
}

function updateThicknessConversion() {
  const {film_lattice_a:a, film_lattice_c:c, film_system:system, hkl} = filmFormGeometry(), thickness = Number($("film_thickness_nm").value);
  const node = $("filmThicknessQuantization"), boundNote = $("fitThicknessBoundNote");
  if (!(a > 0) || !Number.isFinite(projectedRepeatNm(a, hkl, c, system)) || !Number.isFinite(thickness) || thickness < 0) {
    node.textContent = "Enter the lattice constant, reflection and thickness.";
    boundNote.textContent = "Enter a lattice constant and reflection to see the repeat count.";
    return;
  }
  const repeat = projectedRepeatNm(a, hkl, c, system), planes = Math.round(thickness / repeat);
  state.lastFilmPlanes = planes;
  node.textContent = `model value ${trimNumber(planes * repeat, 4)} nm · N = ${planes.toLocaleString("en")} repeats`;
  const low = Number($("fit_low_film_planes").value), high = Number($("fit_high_film_planes").value);
  if (Number.isFinite(low) && Number.isFinite(high) && low < high) {
    const nLow = Math.ceil(low / repeat - 1e-7), nHigh = Math.floor(high / repeat + 1e-7);
    boundNote.textContent = `At the current lattice and hkl, N = ${nLow.toLocaleString("en")}–${nHigh.toLocaleString("en")} · the nm bounds are kept during the fit`;
  } else boundNote.textContent = "Enter thickness bounds to see the repeat-count range.";
}

function syncThicknessForLatticeChange() {
  const {film_lattice_a:a, film_lattice_c:c, film_system:system, hkl} = filmFormGeometry();
  if (a > 0 && Number.isFinite(projectedRepeatNm(a, hkl, c, system))) $("film_thickness_nm").value = trimNumber(state.lastFilmPlanes * projectedRepeatNm(a, hkl, c, system), 8);
  updateThicknessConversion();
}

function snapThicknessToModel() {
  const {film_lattice_a:a, film_lattice_c:c, film_system:system, hkl} = filmFormGeometry(), thickness = Number($("film_thickness_nm").value);
  if (a > 0 && Number.isFinite(projectedRepeatNm(a, hkl, c, system)) && Number.isFinite(thickness) && thickness >= 0) {
    const planes = thicknessToPlanes(thickness, a, hkl, c, system);
    state.lastFilmPlanes = planes;
    $("film_thickness_nm").value = trimNumber(planes * projectedRepeatNm(a, hkl, c, system), 8);
  }
  updateThicknessConversion();
}

function readForm() {
  const parameters = {hkl: $("hkl").value, film_material: $("film_material").value,
                      substrate_material: $("substrate_material").value, film_system:$("film_system").value, film_basis:$("film_basis").value, lp_mode: $("lp_mode").value};
  const scan = {};
  for (const key of numericParameters) parameters[key] = numericField(key);
  parameters.film_planes = thicknessToPlanes(numericField("film_thickness_nm"), parameters.film_lattice_a, parameters.hkl, parameters.film_lattice_c, parameters.film_system);
  for (const key of numericScan) scan[key] = numericField(key);
  return validateConfig({parameters, scan});
}

function validateConfig(input) {
  if (!input || typeof input !== "object" || !input.parameters || !input.scan) throw new Error("That settings file is not in the expected form.");
  const source = input.parameters, scanSource = input.scan;
  const parameters = {hkl: String(source.hkl), film_material: String(source.film_material),
                      substrate_material: String(source.substrate_material ?? "SrTiO3"), lp_mode: String(source.lp_mode ?? "none")};
  parameters.film_system = source.film_system ?? filmMetadata(parameters.film_material).system;
  parameters.film_basis = source.film_basis ?? filmMetadata(parameters.film_material).basis;
  if (!["cubic", "tetragonal"].includes(parameters.film_system)) throw new Error("Choose a cubic or tetragonal film system. M1 is not supported.");
  if (!["perovskite", "rutile", "lattice"].includes(parameters.film_basis)) throw new Error("Choose a film structure-factor model from the list.");
  if (parameters.film_basis !== "lattice" && parameters.film_basis !== filmMetadata(parameters.film_material).basis) throw new Error("The selected material and structure-factor model are incompatible.");
  const scan = {};
  parameters.hkl = normaliseHkl(parameters.hkl);
  if (!materials.has(parameters.film_material)) throw new Error("That film material is not supported.");
  if (substrates.size && !substrates.has(parameters.substrate_material)) throw new Error("That substrate is not supported.");
  if (!lpModes.has(parameters.lp_mode)) throw new Error("Choose a polarization / illuminated-length assumption from the list.");
  for (const key of numericParameters) {
    const blankable = Object.prototype.hasOwnProperty.call(optionalModelDefaults, key);
    const value = blankable && (source[key] === undefined || source[key] === "") ? optionalModelDefaults[key] : source[key];
    if (value === "" || value === null || value === undefined) throw new Error(`${labelFor(key)} is missing.`);
    if (key.startsWith("resolution_halo_") && (!["number", "string"].includes(typeof value) || typeof value === "string" && !value.trim())) throw new Error(`${labelFor(key)} must be a finite number.`);
    parameters[key] = Number(value);
    if (!Number.isFinite(parameters[key])) throw new Error(`${labelFor(key)} must be a finite number.`);
  }
  if (source.film_planes === "" || source.film_planes === null || source.film_planes === undefined) throw new Error("The repeat count N converted from the thickness is missing.");
  parameters.film_planes = Number(source.film_planes);
  for (const key of numericScan) {
    if (scanSource[key] === "" || scanSource[key] === null || scanSource[key] === undefined) throw new Error(`${labelFor(key)} is missing.`);
    scan[key] = Number(scanSource[key]);
    if (!Number.isFinite(scan[key])) throw new Error(`${labelFor(key)} must be a finite number.`);
  }
  if (parameters.film_lattice_c < 0) throw new Error("Film c must be zero (same as a) or positive.");
  if (parameters.substrate_lattice_c < 0) throw new Error("The substrate c axis must be 0 (same as a) or more.");
  for (const key of ["wavelength", "film_lattice_a", "substrate_lattice_a"]) {
    if (parameters[key] <= 0) throw new Error(`${labelFor(key)} must be greater than zero.`);
  }
  if (Math.abs(parameters.film_lattice_gradient_a) > 0.2) throw new Error("Film out-of-plane lattice gradient must be within −0.20 to +0.20 Å.");
  if (filmActiveMean(parameters) - Math.abs(parameters.film_lattice_gradient_a) / 2 <= 0) throw new Error("Adjust the mean film lattice and gradient so both interface and surface spacings stay positive.");
  for (const key of ["film_planes", "substrate_planes"]) {
    const maximum = key === "substrate_planes" ? substrateFitMax : 20000;
    if (!Number.isInteger(parameters[key]) || parameters[key] < 0 || parameters[key] > maximum) throw new Error(`${labelFor(key)} must be a whole number from 0 to ${maximum.toLocaleString("en")}.`);
  }
  if (parameters.film_lattice_gradient_a !== 0 && parameters.film_planes < 2) throw new Error("A film out-of-plane lattice gradient requires at least two film repeats N.");
  if (parameters.film_planes === 0 && parameters.substrate_planes === 0) throw new Error("The film or the substrate must have at least one repeat.");
  if (parameters.film_intensity_scale < 0 || parameters.film_intensity_scale > 100) throw new Error("Film relative intensity scale must be between 0 and 100.");
  if (parameters.fwhm_deg < 0) throw new Error("The instrumental width must be 0 or more.");
  if (parameters.resolution_halo_fraction < 0 || parameters.resolution_halo_fraction > 0.2) throw new Error("Broad resolution component fraction f must be between 0 and 0.2.");
  if (parameters.resolution_halo_width < 1 || parameters.resolution_halo_width > 20) throw new Error("Broad resolution component width multiplier m must be between 1 and 20.");
  if (parameters.background < 0 || parameters.background >= 1) throw new Error("The relative background must be at least 0 and below 1.");
  if (parameters.film_interface_width < 0 || parameters.film_interface_width > 1000) throw new Error("Film boundary taper width w must be between 0 and 1,000 repeats.");
  if (parameters.film_thickness_sigma < 0 || parameters.film_thickness_sigma > 20) throw new Error("Film thickness spread σN must be between 0 and 20 repeats.");
  if (Math.abs(parameters.background_slope) > 1) throw new Error("Log background slope must be between −1 and +1 log₁₀/°.");
  if (!(0 < scan.xmin && scan.xmin < scan.xmax && scan.xmax < 180)) throw new Error("2θ start and end must increase, between 0° and 180°.");
  if (scan.step < 0.001 || scan.step > 1) throw new Error("The calculation step must be between 0.001° and 1°.");
  let count = Math.floor((scan.xmax - scan.xmin) / scan.step + 1e-9) + 1;
  const last = scan.xmin + (count - 1) * scan.step;
  if (scan.xmax - last > Math.max(1e-9, scan.step * 1e-7)) count++;
  if (count < 3 || count > 20001) throw new Error("The scan needs 3–20,001 calculation points. Adjust the range or the step.");
  if (scan.xmin - parameters.angle_offset_deg <= 0 || scan.xmax - parameters.angle_offset_deg >= 180) throw new Error("The zero offset moves the calculated angles outside the physical 0–180° range.");
  return {parameters, scan};
}

function applyConfig(config) {
  config = validateConfig(config);
  if (Number($("wavelength").value) !== config.parameters.wavelength || Number($("angle_offset_deg").value) !== config.parameters.angle_offset_deg) { invalidateFringes(); invalidatePeaks(); }
  if ($("hkl").value !== config.parameters.hkl) invalidatePeaks();
  markCurveStale();
  $("hkl").value = config.parameters.hkl;
  $("film_material").value = config.parameters.film_material;
  $("lp_mode").value = config.parameters.lp_mode;
  $("film_system").value = config.parameters.film_system;
  $("film_basis").value = config.parameters.film_basis;
  if (config.parameters.substrate_material && substrates.has(config.parameters.substrate_material)) {
    $("substrate_material").value = config.parameters.substrate_material;
  }
  for (const key of numericParameters) $(key).value = String(config.parameters[key]);
  state.lastFilmPlanes = config.parameters.film_planes;
  $("film_thickness_nm").value = trimNumber(config.parameters.film_planes * filmRepeatNm(config.parameters), 8);
  for (const key of numericScan) $(key).value = String(config.scan[key]);
  refreshFilmControls();
  refreshSubstrateNote();
  updateThicknessConversion();
}

/* ---------- substrate library ---------- */

const systemNames = {cubic: "cubic", tetragonal: "tetragonal", hexagonal: "hexagonal"};

async function loadCatalogue() {
  let data;
  try { data = await getJson("/api/catalogue"); }
  catch (error) { return; }                       // keep the typed-in values working
  const filmSelect = $("film_material"), wantedFilm = filmSelect.value;
  if (data.film_catalogue?.length) {
    filmSelect.innerHTML = "";
    for (const entry of data.film_catalogue) {
      films.set(entry.id, entry); materials.add(entry.id);
      const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.label; filmSelect.append(option);
    }
    filmSelect.value = materials.has(wantedFilm) ? wantedFilm : "SrRuO3";
  }
  const select = $("substrate_material");
  const wanted = select.value || "SrTiO3";
  select.innerHTML = "";
  for (const item of data.substrates || []) {
    substrates.set(item.id, item);
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    select.append(option);
  }
  select.value = substrates.has(wanted) ? wanted : "SrTiO3";
  refreshFilmControls();
  refreshSubstrateNote();
}

function refreshHklQuick() {
  const quick = $("hklQuick"); quick.innerHTML = "";
  const rutile = $("film_basis").value === "rutile" || substrates.get($("substrate_material").value)?.basis === "rutile";
  for (const label of rutile ? ["002", "004", "110", "220"] : ["001", "002", "003", "004", "110", "111", "220", "006"]) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.addEventListener("click", () => { $("hkl").value = label; $("hkl").dispatchEvent(new Event("input", {bubbles:true})); });
    quick.append(button);
  }
}

function refreshFilmControls({resetFit = false} = {}) {
  const p = filmFormGeometry(), mode = filmAxisMode(p), tet = p.film_system === "tetragonal";
  $("filmCField").hidden = !tet;
  document.querySelector('[data-fit-key="film_lattice_c"]').hidden = !tet;
  if (resetFit || state.filmFitMode !== mode) {
    $("fit_enable_film_lattice_a").checked = mode !== "00l";
    $("fit_enable_film_lattice_c").checked = mode === "00l";
  }
  state.filmFitMode = mode;
  $("filmGradientName").textContent = filmGradientLabel(p);
  $("fitGradientName").textContent = filmGradientLabel(p);
  $("filmGradientNote").textContent = mode === "00l"
    ? "Δc = surface c − interface c. For 00l, only c sets the normal spacing; a cannot be determined. Thickness uses the mean c."
    : mode === "mixed" ? "Δa = surface a − interface a. For mixed reflections, a and c vary proportionally to describe the normal-spacing gradient. One reflection cannot determine a and c independently, so c is fixed by default."
    : "Δa = surface a − interface a. The normal spacing is assumed to vary linearly. Thickness uses the mean lattice and hkl.";
  let note = p.film_basis === "rutile"
    ? "This uses a rutile atomic structure factor. Lattice and oxygen coordinates are reference presets, not refinements of your sample. VO₂ assumes the R phase; M1 is not supported. A single-reflection fit cannot distinguish M1 from R."
    : p.film_basis === "lattice" ? "This uses an effective-scatterer lattice model. Relative intensities do not fully represent the atomic structure."
    : "This uses an ABO₃ atomic structure factor. Check the input lattice and reflection assignment.";
  try { if (p.film_basis === "rutile" && rutileReflectionAbsent(parseHkl(p.hkl))) note = "This reflection is systematically absent in rutile. The exact Bragg reflection vanishes, but nearby scattering from a finite film can remain. " + note; } catch (error) {}
  $("filmNote").textContent = note;
  refreshFitControls(); refreshHklQuick();
}

function onFilmChange() {
  const entry = filmMetadata($("film_material").value);
  $("film_system").value = entry.system; $("film_basis").value = entry.basis;
  if (["VO2", "TiO2"].includes($("film_material").value)) $("film_lattice_a").value = String(entry.a);
  $("film_lattice_c").value = entry.system === "tetragonal" ? String(entry.c || entry.a) : "0";
  if (entry.basis === "rutile") $("hkl").value = "002";
  for (const axis of ["a", "c"]) {
    const value = Number($("film_lattice_" + axis).value) || Number($("film_lattice_a").value);
    $("fit_low_film_lattice_" + axis).value = trimNumber(value * .94, 5);
    $("fit_high_film_lattice_" + axis).value = trimNumber(value * 1.06, 5);
  }
  refreshFilmControls({resetFit:true}); refreshSubstrateNote(); syncThicknessForLatticeChange();
}

/* Changing the substrate fills in that crystal's numbers; every one of them
   stays editable, because a real wafer is not always the nominal value. */
function onSubstrateChange() {
  const entry = substrates.get($("substrate_material").value);
  if (!entry) return;
  $("substrate_lattice_a").value = String(entry.a);
  $("substrate_lattice_c").value = entry.system === "cubic" ? "0" : String(entry.c);
  if (entry.suggest) $("hkl").value = entry.suggest;
  markCurveStale();
  refreshSubstrateNote();
  refreshFilmControls();
  syncThicknessForLatticeChange();
}

/* Mirrors reflection_absent() in xrd_model.py: lattice centering decides whether
   the substrate reflection exists at all. Warning before a fit beats a blank chart. */
function reflectionAbsent(values, centering) {
  const [h, k, l] = values.map(v => ((v % 2) + 2) % 2);
  if (centering === "F") return !(h === k && k === l);
  if (centering === "diamond") {
    if (h === 1 && k === 1 && l === 1) return false;
    if (h === 0 && k === 0 && l === 0) return (values[0] + values[1] + values[2]) % 4 !== 0;
    return true;
  }
  if (centering === "I") return (values[0] + values[1] + values[2]) % 2 !== 0;
  return false;
}

/* The plot marker shows which crystal the green line belongs to. */
function substrateShortLabel() {
  const entry = substrates.get($("substrate_material")?.value);
  if (!entry) return "Substrate";
  const inside = /\(([^)]+)\)\s*$/.exec(entry.label);
  return inside ? inside[1] : entry.label.split(" ")[0];
}

function refreshSubstrateNote() {
  const entry = substrates.get($("substrate_material").value);
  const note = $("substrateNote");
  const cField = $("substrateCField");
  if (!entry) { note.textContent = ""; if (cField) cField.hidden = true; return; }
  if (cField) cField.hidden = entry.system === "cubic";
  const parts = [`<b>${entry.label}</b> · ${systemNames[entry.system] || entry.system}`];
  if (entry.note && entry.basis !== "rutile") parts.push(entry.note);
  parts.push(entry.basis === "rutile" ? "Calculated with a rutile atomic structure factor. Reference lattice and oxygen coordinates are not refinements of your sample." : entry.modelled
    ? "Calculated with the full ABO₃ structure factor — peak position and relative intensity are both modelled."
    : "Lattice-only approximation — the peak position and fringe spacing are right, but the substrate peak height is approximate (the coherent repeat count absorbs it).");
  if (entry.system === "hexagonal") parts.push("Enter hexagonal indices as three numbers (h k l). Sapphire (0006) is 006.");
  let warning = "";
  try {
    if (reflectionAbsent(parseHkl($("hkl").value), entry.centering || "P") || entry.basis === "rutile" && rutileReflectionAbsent(parseHkl($("hkl").value))) {
      warning = `<b class="sw-absent">This reflection is systematically absent in ${entry.label}.</b> Its Bragg marker is omitted — choose an allowed reflection (for example ${entry.suggest}).`;
    }
  } catch (error) { /* an unfinished hkl is reported elsewhere */ }
  note.innerHTML = (warning ? warning + "<br>" : "") + parts.join(" · ");
}

/* ---------- measured-fringe thickness diagnostic ---------- */
function captureFringeInputs() {
  return {roi:[$("fringe_min").value, $("fringe_max").value], manual_peaks:$("fringe_manual_peaks").value, manual_orders:$("fringe_manual_orders").value};
}
function applyFringeInputs(saved) {
  invalidateFringes({clearInputs:true});
  if (!saved || typeof saved !== "object") return;
  if (Array.isArray(saved.roi) && saved.roi.length === 2) {
    for (const [index, id] of ["fringe_min", "fringe_max"].entries()) {
      const value = saved.roi[index];
      if (typeof value === "string" || typeof value === "number") $(id).value = String(value);
    }
  }
  if (typeof saved.manual_peaks === "string") $("fringe_manual_peaks").value = saved.manual_peaks;
  if (typeof saved.manual_orders === "string") $("fringe_manual_orders").value = saved.manual_orders;
}
function invalidateFringes({clearInputs = false} = {}) {
  state.fringe = null;
  state.fringeRequest++;
  if (clearInputs) for (const id of ["fringe_min", "fringe_max", "fringe_manual_peaks", "fringe_manual_orders"]) $(id).value = "";
  $("estimateFringes").disabled = false;
  $("fringeStatus").textContent = "Not estimated. Select a measured region with visible repeating fringes.";
  $("fringeStatus").classList.remove("error");
  $("fringeResult").hidden = true;
  $("fringeWarning").hidden = true;
}
function useVisibleFringeRange() {
  if (!state.measurement) { $("fringeStatus").textContent = "Open a measurement first."; return; }
  const low = Math.max(state.view[0], state.measurement.angles[0]);
  const high = Math.min(state.view[1], state.measurement.angles.at(-1));
  $("fringe_min").value = trimNumber(low, 6); $("fringe_max").value = trimNumber(high, 6);
  invalidateFringes();
}
function renderFringeComparison() {
  if (!state.fringe || state.fringe.status !== "ok") return;
  const t = state.fringe.thickness_nm;
  let model = null, fitted = false;
  try {
    if (state.fitResult && !state.fitResult.stale && Number.isFinite(state.fitResult.thickness_nm)) {
      model = state.fitResult.thickness_nm; fitted = true;
    } else {
      const config = readForm(); model = config.parameters.film_planes * filmRepeatNm(config.parameters);
    }
  } catch (error) { /* incomplete model inputs do not erase measured fringes */ }
  $("fringeModelLabel").textContent = fitted ? "Thickness from fit result" : "Current model thickness (converted)";
  $("fringeModelThickness").textContent = Number.isFinite(model) ? `${trimNumber(model, 3)} nm` : "—";
  const difference = Number.isFinite(model) ? Math.abs(model / t - 1) : null;
  $("fringeDifference").textContent = difference === null ? "—" : `${trimNumber(difference * 100, 2)}%`;
  $("fringeWarning").hidden = difference === null || difference <= 0.05;
  if (difference > 0.05) $("fringeWarning").textContent = "The two thicknesses differ by more than 5%. Check fringe selection, order assignments and the fitting model. This difference is not a statistical confidence interval.";
}
async function estimateFringes() {
  let body;
  try {
    if (!state.measurement) throw new Error("Open a measurement first.");
    const low = fitNumber("fringe_min", "Fringe range start"), high = fitNumber("fringe_max", "Fringe range end");
    if (!(low > 0 && low < high && high < 180)) throw new Error("The fringe range must increase within 0–180°.");
    if (low < state.measurement.angles[0] || high > state.measurement.angles.at(-1)) throw new Error("Keep the fringe range within the measured angular range.");
    const wavelength = numericField("wavelength"), offset = numericField("angle_offset_deg");
    if (!(wavelength > 0) || low - offset <= 0 || high - offset >= 180) throw new Error("Check the wavelength and zero offset for the fringe estimate.");
    body = {measurement:state.measurement, wavelength, angle_offset_deg:offset, roi:[low, high]};
    const manual = $("fringe_manual_peaks").value.trim();
    if (manual) {
      const peaks = manual.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (peaks.length < 4 || peaks.some((value, index) => !Number.isFinite(value) || value < low || value > high || index > 0 && value <= peaks[index-1])) throw new Error("Enter at least four increasing maximum angles within the selected fringe range.");
      body.manual_peaks = peaks;
    }
    const manualOrders = $("fringe_manual_orders").value.trim();
    if (manualOrders) {
      const orders = manualOrders.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (!body.manual_peaks || orders.length !== body.manual_peaks.length || orders.some((value, index) => !Number.isSafeInteger(value) || Math.abs(value) > 10000 || index > 0 && value <= orders[index-1])) throw new Error("Enter one increasing integer order between −10,000 and 10,000 per maximum. Orders may be skipped.");
      body.manual_orders = orders;
    }
  } catch (error) { $("fringeStatus").textContent = error.message; $("fringeStatus").classList.add("error"); return; }
  invalidateFringes();
  const request = state.fringeRequest;
  $("estimateFringes").disabled = true;
  $("fringeStatus").textContent = "Estimating q spacing from measured fringes…";
  try {
    const result = await getJson("/api/fringes", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body)});
    if (request !== state.fringeRequest) return;
    const hasEvidence = Number.isFinite(result?.q_slope) && result.q_slope > 0 && Number.isFinite(result.relative_scatter)
      && Array.isArray(result.peak_angles) && result.peak_angles.length >= 4 && result.peak_angles.every(Number.isFinite)
      && Array.isArray(result.orders) && result.orders.length === result.peak_angles.length && result.orders.every(Number.isSafeInteger)
      && Number.isFinite(result.angular_residual_rms_deg) && result.angular_residual_rms_deg >= 0
      && [result.predicted_peak_angles,result.angular_residuals_deg].every(values=>Array.isArray(values) && values.length===result.peak_angles.length && values.every(Number.isFinite));
    const valid = result?.status === "ok" && Number.isFinite(result.thickness_nm) && result.thickness_nm > 0 && hasEvidence;
    if (hasEvidence && (valid || result.status === "irregular")) {
      $("fringeAngleResidual").textContent = `${trimNumber(result.angular_residual_rms_deg, 6)}°`;
      $("fringeQuality").textContent = `${result.peak_angles.length} maxima · q spacing per order ${result.q_slope.toPrecision(5)} Å⁻¹ · relative interval scatter ${trimNumber(result.relative_scatter * 100, 2)}%`;
      const detail=$("fringePeaks"), table=document.createElement("table");detail.replaceChildren();table.className="peak-table";
      const header=document.createElement("tr");
      for(const label of ["Order","Observed 2θ (°)","Regressed 2θ (°)","Angular residual (°)"]){const th=document.createElement("th");th.textContent=label;header.append(th);}table.append(header);
      for(const [i,value] of result.peak_angles.entries()) {
        const row=document.createElement("tr");
        for(const text of [`n=${result.orders[i]}`,value.toFixed(6),result.predicted_peak_angles[i].toFixed(6),result.angular_residuals_deg[i].toFixed(6)]){const td=document.createElement("td");td.textContent=text;row.append(td);}table.append(row);
      }detail.append(table);
      $("fringeResult").hidden = false;
    }
    if (!valid) {
      $("fringeThickness").textContent = "Not estimated";
      $("fringeModelThickness").textContent = "—";
      $("fringeDifference").textContent = "—";
      $("fringeStatus").textContent = result?.status === "irregular" ? "Not estimated: interval quality checks failed. Review the regression residuals for the assigned orders, range and maxima." : "Not estimated: too few reliable fringes. Select a region with repeating fringes or enter maxima and orders manually.";
      return;
    }
    state.fringe = result;
    $("fringeStatus").textContent = "Thickness follows the selected maxima and assigned orders. Regular spacing or small residuals alone do not establish those assignments.";
    $("fringeThickness").textContent = `${trimNumber(result.thickness_nm, 3)} nm`;
    renderFringeComparison();
  } catch (error) {
    if (request === state.fringeRequest) { $("fringeStatus").textContent = "Could not evaluate the fringes. Check the measured data, wavelength, angle offset and selected range."; $("fringeStatus").classList.add("error"); }
  } finally { if (request === state.fringeRequest) $("estimateFringes").disabled = false; }
}

/* ---------- descriptive peak decomposition; independent of physical fit ---------- */
function capturePeakInputs() {
  return {roi:[$("peak_min").value, $("peak_max").value], peak_count:Number($("peak_count").value),reference_center:$("peak_reference_center").value,reference_d:$("peak_reference_d").value};
}
function applyPeakInputs(saved) {
  invalidatePeaks({clearInputs:true});
  if (!saved || typeof saved !== "object") return;
  if (Array.isArray(saved.roi) && saved.roi.length === 2) for (const [i, id] of ["peak_min", "peak_max"].entries()) {
    if (["string", "number"].includes(typeof saved.roi[i])) $(id).value = String(saved.roi[i]);
  }
  if ([1,2].includes(Number(saved.peak_count))) $("peak_count").value = String(saved.peak_count);
  for (const [key,id] of [["reference_center","peak_reference_center"],["reference_d","peak_reference_d"]]) if (["string","number"].includes(typeof saved[key])) $(id).value=String(saved[key]);
}
function invalidatePeaks({clearInputs=false}={}) {
  state.peakAnalysis = null; state.peakRequest++;
  if (clearInputs) { $("peak_min").value = ""; $("peak_max").value = ""; $("peak_count").value = "2"; $("peak_reference_center").value=""; $("peak_reference_d").value=""; }
  $("fitPeaks").disabled = false;
  $("peakResult").hidden = true;
  $("peakStatus").classList.remove("error");
  $("peakStatus").textContent = "Not analyzed. Select a measured range containing the peaks.";
}
function useVisiblePeakRange() {
  if (!state.measurement) { $("peakStatus").textContent = "Open a measurement first."; return; }
  const low = Math.max(state.view[0], state.measurement.angles[0]), high = Math.min(state.view[1], state.measurement.angles.at(-1));
  if (!(low < high)) return;
  $("peak_min").value = trimNumber(low, 6); $("peak_max").value = trimNumber(high, 6); invalidatePeaks();
}
function drawPeakAnalysis(result, linearResult) {
  const svg = $("peakPlot"), ns = "http://www.w3.org/2000/svg", width = 720, height = 220;
  svg.replaceChildren(); svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const left = 42, top = 12, right = width-12, bottom = height-32;
  const x0=result.angles[0], x1=result.angles.at(-1), maximum=Math.max(...result.measured, ...result.predicted, ...linearResult.predicted);
  const xp=x=>left+(x-x0)/(x1-x0)*(right-left), yp=y=>bottom-(Math.log10(Math.max(y/maximum,1e-4))+4)/4*(bottom-top);
  const add=(name,attrs,text)=>{const n=document.createElementNS(ns,name);for(const [key,value] of Object.entries(attrs))n.setAttribute(key,String(value));if(text!==undefined)n.textContent=text;svg.append(n);return n;};
  for(let decade=0;decade<=4;decade++) {
    const y=top+decade*(bottom-top)/4;
    add("line",{x1:left,y1:y,x2:right,y2:y,stroke:"#e4ebf2"});
    add("text",{x:left-6,y:y+4,"text-anchor":"end",class:"peak-axis"},decade===0?"1":`10⁻${decade}`);
  }
  for(let i=0;i<=4;i++) { const x=x0+(x1-x0)*i/4;add("text",{x:xp(x),y:bottom+18,"text-anchor":"middle",class:"peak-axis"},x.toFixed(2)); }
  add("text",{x:(left+right)/2,y:height-2,"text-anchor":"middle",class:"peak-axis"},"2θ (°)");
  for(const [values,color] of [[result.measured,"#8b99aa"],[result.predicted,"#2563b8"],[linearResult.predicted,"#c87a22"]]) {
    const path=values.map((v,i)=>`${i?"L":"M"}${xp(result.angles[i]).toFixed(2)},${yp(v).toFixed(2)}`).join(" ");
    add("path",{d:path,fill:"none",stroke:color,"stroke-width":1.5});
  }
}
async function analyzePeaks() {
  let body;
  try {
    if (!state.measurement) throw new Error("Open a measurement first.");
    const lo=fitNumber("peak_min", "Peak-analysis range start"), hi=fitNumber("peak_max", "Peak-analysis range end");
    if (!(state.measurement.angles[0]<=lo && lo<hi && hi<=state.measurement.angles.at(-1))) throw new Error("Enter an increasing peak-analysis range within the measured scan.");
    const wavelength=numericField("wavelength"), angle_offset_deg=numericField("angle_offset_deg");
    if (!(wavelength>0) || lo-angle_offset_deg<=0 || hi-angle_offset_deg>=180) throw new Error("Check the wavelength and zero offset for peak analysis.");
    body={measurement:state.measurement,wavelength,angle_offset_deg,roi:[lo,hi],hkl:normaliseHkl($("hkl").value),peak_count:Number($("peak_count").value),max_evaluations:2000};
    if ($("peak_reference_center").value.trim() || $("peak_reference_d").value.trim()) {
      const center_deg=fitNumber("peak_reference_center","Reference peak center"), d_angstrom=fitNumber("peak_reference_d","Reference d");
      if (!(center_deg-angle_offset_deg>0 && center_deg-angle_offset_deg<180 && d_angstrom>0)) throw new Error("Check both the reference peak angle and positive reference d-spacing.");
      body.reference={center_deg,d_angstrom};
    }
  } catch(error) { $("peakStatus").textContent=error.message;$("peakStatus").classList.add("error");return; }
  invalidatePeaks();const request=state.peakRequest;$("fitPeaks").disabled=true;
  $("peakStatus").textContent="Decomposing the peak shape in the selected range…";
  try {
    const results=[];
    for(const loss of ["soft_log","linear"]) {
      const result=await getJson("/api/peaks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,loss})});
      if(request!==state.peakRequest)return;
      if(!result || !Array.isArray(result.components) || result.components.length!==body.peak_count || !result.components.every(c=>[c.center_deg,c.fwhm_deg,c.area,c.area_fraction,c.roi_area_fraction,c.eta,c.d_angstrom].every(Number.isFinite)) || !Array.isArray(result.angles) || result.angles.length<3 || !Array.isArray(result.measured) || !Array.isArray(result.predicted) || result.measured.length!==result.angles.length || result.predicted.length!==result.angles.length || ![...result.angles,...result.measured,...result.predicted,result.soft_log_rmse,result.log_rmse,result.fit_rmse,result.evaluations].every(Number.isFinite)) throw new Error("Invalid peak analysis response");
      results.push(result);
      if(loss==="soft_log")$("peakStatus").textContent="Analyzing the same range with linear loss to compare methods…";
    }
    const [soft,linear]=results;state.peakAnalysis={soft_log:soft,linear};
    const tbody=$("peakComponents"), comparison=$("peakComparison");tbody.replaceChildren();comparison.replaceChildren();
    $("peakReferenceDHeader").hidden=!body.reference;$("peakReferenceCHeader").hidden=!body.reference;
    const appendRow=(target,values)=>{const row=document.createElement("tr");for(const value of values){const cell=document.createElement("td");cell.textContent=String(value);row.append(cell);}target.append(row);};
    const methodDifferences=[];
    for(let i=0;i<body.peak_count;i++) {
      const a=soft.components[i],b=linear.components[i],difference=Math.abs(a.center_deg-b.center_deg);methodDifferences.push(difference);
      const weak=Math.min(a.area_fraction,b.area_fraction)<.15;
      appendRow(comparison,[i+1,a.center_deg.toFixed(5),b.center_deg.toFixed(5),difference.toFixed(5),Number.isFinite(a.c_00l_angstrom)?a.c_00l_angstrom.toFixed(5):"—",Number.isFinite(b.c_00l_angstrom)?b.c_00l_angstrom.toFixed(5):"—",`${trimNumber(a.area_fraction*100,2)}%`,`${trimNumber(b.area_fraction*100,2)}%`,weak?"Weakly determined component (assumed profile)":"Profile component"]);
    }
    for(const [method,result] of [["soft-log",soft],["linear",linear]])for(const [i,c] of result.components.entries()) {
      const values=[method,i+1,c.center_deg.toFixed(5),c.d_angstrom.toFixed(5),Number.isFinite(c.c_00l_angstrom)?c.c_00l_angstrom.toFixed(5):"—",c.fwhm_deg.toFixed(5),c.area.toPrecision(5),`${trimNumber(c.area_fraction*100,2)}%`,`${trimNumber(c.roi_area_fraction*100,2)}%`,trimNumber(c.eta,3)];
      if(body.reference)values.push(Number.isFinite(c.d_reference_angstrom)?c.d_reference_angstrom.toFixed(5):"—",Number.isFinite(c.c_00l_reference_angstrom)?c.c_00l_reference_angstrom.toFixed(5):"—");
      appendRow(tbody,values);
    }
    $("peakMetrics").textContent=`soft-log objective RMSE ${soft.fit_rmse.toFixed(4)} · linear objective RMSE ${linear.fit_rmse.toFixed(4)} · ${soft.evaluations.toLocaleString("en")} + ${linear.evaluations.toLocaleString("en")} evaluations (different error definitions)`;
    const warning=[];
    if(methodDifferences.some(value=>value>.02))warning.push("The methods differ in peak center by more than 0.02°. Peak position is sensitive to the chosen objective.");
    if(results.some(result=>result.boundary_hits?.length))warning.push("Some values reached search boundaries. Check sensitivity to the range and starting values.");
    if(results.some(result=>result.multistart?.materially_different))warning.push("Other decompositions have similar errors. This assignment is not unique.");
    if(results.some(result=>result.components.some(c=>c.area_fraction<.15)))warning.push("The small component is a weakly determined profile feature. Consider fringe overlap and alternative decompositions.");
    if(results.some(result=>result.components.some(c=>c.roi_area<.8*c.area)))warning.push("More than 20% of a component area is extrapolated outside the selected range. Compare full and ROI area fractions.");
    $("peakWarnings").textContent=warning.join(" ");$("peakWarnings").hidden=!warning.length;
    $("peakStatus").textContent="This is a peak-shape decomposition. It does not establish spatial arrangement, layers or phase assignments.";
    $("peakResult").hidden=false;drawPeakAnalysis(soft,linear);
  } catch(error) {
    if(request===state.peakRequest){$("peakStatus").textContent="Could not complete peak analysis. Check the measured data, selected range, wavelength and zero offset.";$("peakStatus").classList.add("error");}
  } finally {if(request===state.peakRequest)$("fitPeaks").disabled=false;}
}

function captureFitSettings() {
  const variables = {};
  for (const key of fitKeys) variables[key] = {
    enabled: $("fit_enable_" + key).checked,
    low: $("fit_low_" + key).value,
    high: $("fit_high_" + key).value
  };
  return {range: [$("fit_min").value, $("fit_max").value], variables, thickness_unit:"nm", max_evaluations: Number($("fit_evaluations").value)};
}

function applyFitSettings(settings) {
  // A legacy session must not inherit newly enabled fit variables from this tab.
  for (const key of optionalFitKeys) $("fit_enable_" + key).checked = false;
  if (!settings?.variables?.film_lattice_c) $("fit_enable_film_lattice_c").checked = filmAxisMode() === "00l";
  if (!settings || typeof settings !== "object") {
    refreshFitControls();
    return false;
  }
  let migratedThicknessBounds = false;
  if (fitBudgetOptions.has(Number(settings.max_evaluations))) $("fit_evaluations").value = String(settings.max_evaluations);
  if (Array.isArray(settings.range) && settings.range.length === 2) {
    for (const [id, value] of [["fit_min", settings.range[0]], ["fit_max", settings.range[1]]]) {
      if (value !== null && value !== undefined) $(id).value = String(value);
    }
  }
  if (settings.variables && typeof settings.variables === "object") {
    for (const key of fitKeys) {
      const item = settings.variables[key];
      if (!item || typeof item !== "object") {
        continue;
      }
      if (typeof item.enabled === "boolean") $("fit_enable_" + key).checked = item.enabled;
      const oldCountBounds = key === "film_planes" && settings.thickness_unit !== "nm";
      if (oldCountBounds) migratedThicknessBounds = true;
      const repeat = oldCountBounds ? filmRepeatNm(filmFormGeometry()) : 1;
      if (item.low !== null && item.low !== undefined) $("fit_low_" + key).value = oldCountBounds ? String(Number(item.low) * repeat) : String(item.low);
      if (item.high !== null && item.high !== undefined) $("fit_high_" + key).value = oldCountBounds ? String(Number(item.high) * repeat) : String(item.high);
    }
  }
  refreshFitControls();
  updateThicknessConversion();
  requestDraw();
  return migratedThicknessBounds;
}

function refreshFitControls() {
  const mode = filmAxisMode();
  for (const [key, inactive] of [["film_lattice_a", mode === "00l"], ["film_lattice_c", mode === "cubic" || mode === "hk0"]]) {
    const box = $("fit_enable_" + key);
    if (inactive) box.checked = false;
    box.disabled = inactive || state.fitBusy;
  }
  if ($("fit_enable_film_interface_width").checked) $("advancedFitVariables").open = true;
  for (const key of fitKeys) {
    const row = document.querySelector(`[data-fit-key="${key}"]`);
    row.classList.toggle("is-fixed", !$("fit_enable_" + key).checked);
  }
}

function fitNumber(id, description) {
  const raw = $(id).value.trim();
  if (!raw) throw new Error(`Enter a value for ${description}.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${description} must be a finite number.`);
  return value;
}

function validateFitBounds(key, low, high, scan) {
  const name = labelFor(key);
  if (!(low < high)) throw new Error(`The lower bound of ${name} must be below the upper bound.`);
  if (key === "substrate_planes" && (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > substrateFitMax)) throw new Error(`${name} bounds must be whole numbers from 1 to ${substrateFitMax.toLocaleString("en")}.`);
  if (key === "film_planes" && low <= 0) throw new Error("Thickness bounds must be greater than 0 nm.");
  if (["film_lattice_a", "film_lattice_c"].includes(key) && (low <= 0 || high > 20)) throw new Error("Film lattice constant bounds must be above 0 and at most 20 Å.");
  if (key === "film_lattice_gradient_a" && (low < -0.2 || high > 0.2)) throw new Error("Film out-of-plane lattice gradient bounds must be within −0.20 to +0.20 Å.");
  if (key === "angle_offset_deg" && (low < -5 || high > 5 || scan.xmin - high <= 0 || scan.xmax - low >= 180)) throw new Error("Zero offset bounds must be within ±5° and must keep the calculated angles inside 0–180°.");
  if (key === "film_intensity_scale" && (low < 0 || high > 100)) throw new Error("Film relative intensity scale bounds must be between 0 and 100.");
  if (key === "fwhm_deg" && (low < 0 || high > 2)) throw new Error("Instrumental width bounds must be between 0 and 2°.");
  if (key === "resolution_halo_fraction" && (low < 0 || high > 0.2)) throw new Error("Broad resolution component fraction f bounds must be between 0 and 0.2.");
  if (key === "resolution_halo_width" && (low < 1 || high > 20)) throw new Error("Broad resolution component width multiplier m bounds must be between 1 and 20.");
  if (key === "background" && (low < 0 || high >= 1)) throw new Error("Relative background bounds must be at least 0 and below 1.");
  if (key === "film_interface_width" && (low < 0 || high > 1000)) throw new Error("Film boundary taper width w bounds must be between 0 and 1,000 repeats.");
  if (key === "film_thickness_sigma" && (low < 0 || high > 20)) throw new Error("Film thickness spread σN bounds must be between 0 and 20 repeats.");
  if (key === "background_slope" && (low < -1 || high > 1)) throw new Error("Log background slope bounds must be between −1 and +1 log₁₀/°.");
}

function readFitSettings(config) {
  if (!state.measurement) throw new Error("Open a measurement first.");
  const low = fitNumber("fit_min", "fit start angle"), high = fitNumber("fit_max", "fit end angle");
  if (!(0 < low && low < high && high < 180)) throw new Error("The fit range must lie within 0–180°, with the end above the start.");
  const measurements = state.measurement.angles;
  const allowedLow = Math.max(measurements[0], config.scan.xmin);
  const allowedHigh = Math.min(measurements.at(-1), config.scan.xmax);
  if (low < allowedLow - 1e-8 || high > allowedHigh + 1e-8) throw new Error(`The fit range must lie inside ${allowedLow.toFixed(3)}–${allowedHigh.toFixed(3)}°, where the measurement and the calculation overlap.`);
  const fitPoints = upperBound(measurements, high) - lowerBound(measurements, low);
  if (fitPoints < 10) throw new Error("The fit range needs at least 10 measured points.");
  const bounds = {};
  let thicknessBoundsNm = null;
  for (const key of fitKeys) {
    if (!$("fit_enable_" + key).checked) continue;
    const lower = fitNumber("fit_low_" + key, `${labelFor(key)} lower bound`);
    const upper = fitNumber("fit_high_" + key, `${labelFor(key)} upper bound`);
    validateFitBounds(key, lower, upper, config.scan);
    if (key === "film_planes") thicknessBoundsNm = [lower, upper];
    else bounds[key] = [lower, upper];
  }
  if (thicknessBoundsNm) {
    const p = config.parameters;
    const aBounds = bounds.film_lattice_a || [p.film_lattice_a, p.film_lattice_a];
    const cBounds = bounds.film_lattice_c || [p.film_lattice_c, p.film_lattice_c];
    const lowRepeat = filmRepeatNm({...p, film_lattice_a:aBounds[0], film_lattice_c:cBounds[0]});
    const highRepeat = filmRepeatNm({...p, film_lattice_a:aBounds[1], film_lattice_c:cBounds[1]});
    const nLow = Math.max(1, Math.ceil(thicknessBoundsNm[0] / highRepeat - 1e-7));
    const nHigh = Math.min(20000, Math.floor(thicknessBoundsNm[1] / lowRepeat + 1e-7));
    if (!(nLow < nHigh)) throw new Error("At least two repeat counts must fall inside the thickness bounds. Widen them.");
    bounds.film_planes = [nLow, nHigh];
  }
  if (!Object.keys(bounds).length) throw new Error("Select at least one parameter to fit.");
  const maxEvaluations = Number($("fit_evaluations").value);
  if (!fitBudgetOptions.has(maxEvaluations)) throw new Error("Choose a search budget again.");
  return {range:[low, high], bounds, ...(thicknessBoundsNm ? {thickness_bounds_nm:thicknessBoundsNm} : {}), max_evaluations:maxEvaluations, scan:{...config.scan}};
}

function projectFitStart(config, fit) {
  const parameters = {...config.parameters}, adjusted = [];
  for (const [key, [low, high]] of Object.entries(fit.bounds)) {
    const original = key === "film_lattice_c" ? parameters[key] || parameters.film_lattice_a : parameters[key];
    parameters[key] = Math.max(low, Math.min(high, original));
    if (parameters[key] !== original) adjusted.push(`${key === "film_planes" ? "N from thickness" : labelFor(key)} ${trimNumber(original, 5)}→${trimNumber(parameters[key], 5)}`);
  }
  return {parameters, adjusted};
}

function validateCurve(raw, filename = "Measurement", {allowSigned = false} = {}) {
  if (!raw || typeof raw !== "object") throw new Error("The curve data could not be read.");
  const angleInput = raw.angles || raw.two_theta_deg;
  const intensityInput = raw.intensities || raw.intensity_raw;
  const angles = Array.isArray(angleInput) ? angleInput.slice() : angleInput;
  const intensities = Array.isArray(intensityInput) ? intensityInput.slice() : intensityInput;
  if (!Array.isArray(angles) || !Array.isArray(intensities) || angles.length < 2 || angles.length !== intensities.length) throw new Error("Angles and intensities must be two arrays of the same length, with at least two points.");
  if (angles.length > 1000000) throw new Error("That file is too large. Up to 1,000,000 points can be read.");
  let previous = -Infinity, positive = false;
  for (let i = 0; i < angles.length; i++) {
    const x = angles[i], y = intensities[i];
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || x >= 180 || x <= previous || (!allowSigned && y < 0)) throw new Error("Measured angles must be finite and increasing, and intensities finite. Analysis intensities must be nonnegative.");
    angles[i] = x; intensities[i] = y; previous = x;
    if (y > 0) positive = true;
  }
  if (!allowSigned && !positive) throw new Error("The measurement has no positive intensity.");
  return {angles, intensities, filename: String(raw.filename || filename)};
}

function setMeasurement(raw, {adjustScan = true, clearInputs = true} = {}) {
  const measurement = validateCurve(raw);
  measurement.intensity_transform = raw.intensity_transform;
  state.measurement = measurement;
  state.intensityPending = false;
  invalidatePeaks({clearInputs});
  invalidateFringes({clearInputs});
  hideFitResult({clearResidual:true});
  setFitProgress(`Waiting to fit · up to ${Number($("fit_evaluations").value).toLocaleString("en")} model evaluations`);
  const {angles, intensities, filename} = measurement;
  let peak = 0;
  for (let i = 1; i < intensities.length; i++) if (intensities[i] > intensities[peak]) peak = i;
  $("dataName").textContent = filename;
  $("dataMeta").textContent = `${angles.length.toLocaleString("en")} points · ${formatAngle(angles[0], 2)}–${formatAngle(angles.at(-1), 2)}° · strongest peak ${formatAngle(angles[peak], 3)}°`;
  if (adjustScan) {
    const xmin = Math.max(0.001, angles[0]);
    const xmax = Math.min(179.999, angles.at(-1));
    if (xmin < xmax) {
      $("xmin").value = String(xmin);
      $("xmax").value = String(xmax);
      const nominalStep = (xmax - xmin) / Math.max(1, angles.length - 1);
      const safeStep = Math.min(1, Math.max(0.001, nominalStep, (xmax - xmin) / 19999));
      $("step").value = trimNumber(safeStep, 6);
      $("fit_min").value = String(xmin);
      $("fit_max").value = String(xmax);
    }
  }
  state.stats = null;
  refreshIntensityControls();
  updateMetrics();
  renderResidualDiagnostics();
  requestDraw();
}

/* Raw imported values are retained separately. Only this ingestion boundary
   converts axes; every analysis continues to consume nonnegative linear values. */
function readIntensitySettings() {
  const intensity_scale = $("intensity_scale").value;
  const intensity_decades = Number($("intensity_decades").value);
  if (!$("intensity_decades").value.trim() || !Number.isFinite(intensity_decades) || intensity_decades < 1 || intensity_decades > 20) throw new Error("The decade count must be a finite value from 1 to 20.");
  return {intensity_scale, intensity_decades, negative_policy:$("negative_policy").value};
}
function applyIntensitySettings(saved = {}) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("Saved intensity-axis settings are invalid.");
  const scale = saved.intensity_scale === undefined ? "linear" : saved.intensity_scale, policy = saved.negative_policy === undefined ? "reject" : saved.negative_policy, decades = saved.intensity_decades === undefined ? 8 : saved.intensity_decades;
  if (!["linear", "log10", "log10_normalized"].includes(scale) || !["reject", "clip", "shift"].includes(policy) || typeof decades !== "number" || !Number.isFinite(decades) || decades < 1 || decades > 20) throw new Error("Saved intensity-axis settings are invalid.");
  $("intensity_scale").value = scale; $("negative_policy").value = policy; $("intensity_decades").value = String(decades);
  refreshIntensityControls();
}
function refreshIntensityControls() {
  const scale = $("intensity_scale").value;
  $("intensityDecadesField").hidden = scale !== "log10_normalized";
  $("intensityDecadesNote").hidden = scale !== "log10_normalized";
  $("negativePolicyField").hidden = scale !== "linear";
  $("applyIntensity").disabled = !state.measurementSource || state.fitBusy;
  $("runFit").disabled = !state.measurement || state.fitBusy;
  $("fitPeaks").disabled = !state.measurement || state.fitBusy;
  $("estimateFringes").disabled = !state.measurement || state.fitBusy;
  let lo=Infinity, hi=-Infinity, negatives=0;
  for (const y of state.measurementSource?.intensities || []) { lo=Math.min(lo,y); hi=Math.max(hi,y); if(y<0) negatives++; }
  $("intensityHint").hidden = !(negatives && Math.abs(hi-1)<=1e-6 && hi-lo<100);
  const m=state.measurement?.intensity_transform;
  let summary = state.intensityPending ? "Intensity conversion pending · measured-data analyses are unavailable." : "No applied intensity conversion";
  if (m) {
    const label = {linear:"linear", log10:"log₁₀ → linear", log10_normalized:"Normalized log₁₀ → linear"}[m.intensity_scale];
    summary = `Applied: ${label} · decades ${m.intensity_scale === "log10_normalized" ? m.intensity_decades : "—"} · negative policy ${m.intensity_scale === "linear" ? m.negative_policy : "—"} · added constant ${m.shift} · ${m.negative_count} negative source values`;
  }
  for (const node of document.querySelectorAll(".intensity-provenance")) node.textContent=summary;
}
function clearAppliedIntensity() {
  ++state.intensityRequest;
  state.measurement = null; state.stats = null;
  state.intensityPending = Boolean(state.measurementSource);
  hideFitResult({clearResidual:true}); invalidateFringes(); invalidatePeaks();
  refreshIntensityControls(); updateMetrics(); requestDraw();
}
function intensitySettingsChanged() {
  ++state.importRequest;
  clearAppliedIntensity();
  $("intensityStatus").textContent = "Settings changed. Press Apply intensity axis to convert again from the original values.";
  $("intensityStatus").classList.remove("error");
}
async function applyIntensity({adjustScan=state.intensityAdjustScan, clearInputs=false} = {}) {
  if (!state.measurementSource || state.fitBusy) return false;
  clearAppliedIntensity();
  const id=state.intensityRequest;
  try {
    const settings=readIntensitySettings();
    const converted=await getJson("/api/intensity", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({measurement:state.measurementSource, settings})});
    if(id!==state.intensityRequest) return false;
    setMeasurement(converted, {adjustScan, clearInputs});
    state.intensityAdjustScan=false;
    $("intensityStatus").textContent = "Converted once from the original values. All analyses use these linear intensities.";
    $("intensityStatus").classList.remove("error");
    setStatus("Applied the selected intensity axis.");
    return true;
  } catch(error) {
    if(id!==state.intensityRequest) return false;
    const hasNegative=state.measurementSource.intensities.some(y=>y<0);
    $("intensityStatus").textContent = hasNegative && $("intensity_scale").value==="linear" && $("negative_policy").value==="reject"
      ? "File read. Analysis is pending because values are negative. Check the stored axis and select a log mode, or explicitly choose clip or shift for linear data."
      : "Conversion failed. Check the axis and decade count. Exponents outside the supported range, or data without positive intensities, cannot be analyzed.";
    $("intensityStatus").classList.add("error");
    setStatus($("intensityStatus").textContent,true);
    return false;
  }
}
async function ingestMeasurement(raw, {adjustScan=true, settings=null, clearInputs=true} = {}) {
  const source=validateCurve(raw, "Measurement", {allowSigned:true});
  clearAppliedIntensity();
  state.measurementSource=source;
  state.intensityAdjustScan=adjustScan;
  state.intensityPending=true;
  if(settings) applyIntensitySettings(settings);
  $("dataName").textContent=source.filename;
  $("dataMeta").textContent=`${source.angles.length.toLocaleString("en")} points · ${formatAngle(source.angles[0],2)}–${formatAngle(source.angles.at(-1),2)}° · original values retained`;
  if(clearInputs) {invalidateFringes({clearInputs:true});invalidatePeaks({clearInputs:true});}
  refreshIntensityControls();
  return applyIntensity({adjustScan,clearInputs});
}

function trimNumber(value, digits = 5) {
  return Number(value.toFixed(digits)).toString();
}

function formatAngle(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

async function getJson(url, options) {
  if (window.XRDLocal) return XRDLocal.getJson(url, options);
  const response = await fetch(url, options);
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`The server reply could not be read. (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(result.error || `The request failed. (HTTP ${response.status})`);
  return result;
}

async function openSample() {
  const importId=++state.importRequest;
  ++state.intensityRequest;
  try {
    setStatus("Loading the bundled SRO/STO example…");
    const raw = await getJson("/api/sample");
    if(importId!==state.importRequest) return;
    if (!await ingestMeasurement(raw, {settings:{intensity_scale:"linear",intensity_decades:8,negative_policy:"reject"}}) || importId!==state.importRequest) return;
    if (await runSimulation() && importId===state.importRequest && state.measurement) setStatus(`Opened ${state.measurement.filename}. Check the reflection and wavelength you are assuming, then run the fit.`);
  } catch (error) {
    if(importId!==state.importRequest) return;
    if (!state.simulation) await runSimulation();
    if(importId!==state.importRequest) return;
    setStatus(`Example data error: ${error.message}`, true);
  }
}

async function openMeasurementFile(file) {
  if (!file) return;
  const importId=++state.importRequest;
  ++state.intensityRequest;
  try {
    setStatus(`Reading ${file.name}…`);
    const body = await file.arrayBuffer();
    const raw = await getJson("/api/parse", {method:"POST",headers:{"Content-Type":"application/octet-stream","X-Filename":encodeURIComponent(file.name)},body});
    if(importId!==state.importRequest) return;
    if (!await ingestMeasurement({...raw, filename:file.name}) || importId!==state.importRequest) return;
    if (await runSimulation() && importId===state.importRequest && state.measurement) setStatus(`${file.name} · ${state.measurement.angles.length.toLocaleString("en")} points loaded.`);
  } catch (error) { if(importId!==state.importRequest) return; setStatus(`Measurement file error: ${error.message}`, true); }
}

function validateSimulation(raw) {
  if (!raw || !Array.isArray(raw.angles) || !Array.isArray(raw.intensities) || raw.angles.length < 2 || raw.angles.length !== raw.intensities.length) throw new Error("The calculated angle and intensity arrays are not valid.");
  const angles = raw.angles, intensities = raw.intensities;
  let previous = -Infinity, positive = false;
  for (let i = 0; i < angles.length; i++) {
    const x = Number(angles[i]), y = Number(intensities[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= previous || y < 0) throw new Error("The calculation returned an invalid value.");
    angles[i] = x; intensities[i] = y; previous = x;
    if (y > 0) positive = true;
  }
  if (!positive) throw new Error("The calculation has no positive intensity.");
  const filmPeak = raw.film_peak == null ? null : Number(raw.film_peak);
  const substratePeak = raw.substrate_peak == null ? null : Number(raw.substrate_peak);
  return {angles, intensities, filmPeak:Number.isFinite(filmPeak) ? filmPeak : null, substratePeak:Number.isFinite(substratePeak) ? substratePeak : null};
}

function installSimulation(config, simulation) {
  state.simulation = simulation;
  state.config = config;
  state.configSignature = JSON.stringify(config);
  state.view = [simulation.angles[0], simulation.angles.at(-1)];
  state.stats = null;
  $("curveStale").hidden = true;
  $("scanBadge").textContent = `${simulation.angles.length.toLocaleString("en")} points · ${config.parameters.hkl} · λ ${config.parameters.wavelength} Å`;
  updateMetrics();
  renderResidualDiagnostics();
  requestDraw();
}

async function runSimulation() {
  if (state.fitBusy) return false;
  let config;
  try { config = readForm(); }
  catch (error) { setStatus(`Check the input: ${error.message}`, true); return false; }
  const id = ++state.requestId;
  const button = $("runSimulation");
  button.disabled = true;
  setStatus("Calculating…");
  try {
    const raw = await getJson("/api/simulate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});
    if (id !== state.requestId) return false;
    const simulation = validateSimulation(raw);
    const hadFitResult = Boolean(state.fitResult);
    installSimulation(config, simulation);
    hideFitResult();
    if (hadFitResult) setFitProgress("Applied. You can run a new fit now.");
    setStatus(`${state.simulation.angles.length.toLocaleString("en")} points calculated · reflection ${config.parameters.hkl} · wavelength ${config.parameters.wavelength} Å`);
    return true;
  } catch (error) {
    if (id === state.requestId) setStatus(`Calculation error: ${explainModelError(error)}`, true);
    return false;
  } finally { if (id === state.requestId) button.disabled = state.fitBusy; }
}

function validateFitResponse(raw, scan) {
  if (!raw || typeof raw !== "object" || !raw.parameters || typeof raw.parameters !== "object") throw new Error("The fit result is not in the expected form.");
  const config = validateConfig({parameters:raw.parameters, scan});
  const numeric = ["best_log_rmse", "thickness_nm", "evaluations", "fit_points"];
  for (const key of numeric) if (raw[key] === null || raw[key] === undefined || raw[key] === "" || !Number.isFinite(Number(raw[key]))) throw new Error(`The fit result value ${key} is not valid.`);
  const initial = raw.initial_log_rmse === null ? null : Number(raw.initial_log_rmse), best = Number(raw.best_log_rmse), thickness = Number(raw.thickness_nm);
  if (raw.initial_log_rmse !== null && (raw.initial_log_rmse === undefined || raw.initial_log_rmse === "" || !Number.isFinite(initial))) throw new Error("The starting error in the fit result is not valid.");
  const evaluations = Number(raw.evaluations), fitPoints = Number(raw.fit_points);
  if ((initial !== null && initial < 0) || best < 0 || thickness < 0 || !Number.isInteger(evaluations) || evaluations < 0 || !Number.isInteger(fitPoints) || fitPoints < 1) throw new Error("The error, thickness or evaluation count in the fit result is not valid.");
  let initialMerit = null, bestMerit = null;
  if (raw.best_fit_merit !== null && raw.best_fit_merit !== undefined) {
    bestMerit = Number(raw.best_fit_merit);
    if (!Number.isFinite(bestMerit) || bestMerit < 0) throw new Error("The peak-weighted error in the fit result is not valid.");
  }
  if (raw.initial_fit_merit !== null && raw.initial_fit_merit !== undefined) {
    initialMerit = Number(raw.initial_fit_merit);
    if (!Number.isFinite(initialMerit) || initialMerit < 0) throw new Error("The starting peak-weighted error in the fit result is not valid.");
  }
  const measuredPeakFwhm = raw.measured_peak_fwhm_deg == null ? null : Number(raw.measured_peak_fwhm_deg);
  const fittedPeakFwhm = raw.fitted_peak_fwhm_deg == null ? null : Number(raw.fitted_peak_fwhm_deg);
  if ((measuredPeakFwhm !== null && (!Number.isFinite(measuredPeakFwhm) || measuredPeakFwhm <= 0)) || (fittedPeakFwhm !== null && (!Number.isFinite(fittedPeakFwhm) || fittedPeakFwhm <= 0))) throw new Error("The peak width result is not valid.");
  const wing = (side) => {
    const value = raw.diagnostics?.[side]?.median_log10_model_over_measured ?? raw.diagnostics?.[`${side}_log_ratio`];
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  const diagnostics = raw.diagnostics && typeof raw.diagnostics === "object" ? {
    fixed_sto_wing_excess: raw.diagnostics.fixed_sto_wing_excess === true,
    fit_improved_materially: raw.diagnostics.fit_improved_materially !== false,
    left_wing_log_ratio: wing("left_wing"),
    right_wing_log_ratio: wing("right_wing")
  } : null;
  return {config, initial_log_rmse:initial, best_log_rmse:best, initial_fit_merit:initialMerit, best_fit_merit:bestMerit, measured_peak_fwhm_deg:measuredPeakFwhm, fitted_peak_fwhm_deg:fittedPeakFwhm, thickness_nm:thickness, evaluations, fit_points:fitPoints, reference_decimated:raw.reference_decimated === true, diagnostics, message:String(raw.message || "")};
}

function measurementForFit(measurement, range) {
  const start = lowerBound(measurement.angles, range[0]), end = upperBound(measurement.angles, range[1]);
  const sourcePoints = end - start, maxPoints = 5000;
  let indices;
  if (sourcePoints <= maxPoints) indices = Array.from({length:sourcePoints}, (_, index) => start + index);
  else {
    const selected = new Set();
    for (let index = 0; index < maxPoints; index++) selected.add(start + Math.round(index * (sourcePoints - 1) / (maxPoints - 1)));
    let highest = start;
    for (let index = start + 1; index < end; index++) if (measurement.intensities[index] > measurement.intensities[highest]) highest = index;
    for (let index = Math.max(start, highest - 2); index <= Math.min(end - 1, highest + 2); index++) selected.add(index);
    indices = [...selected].sort((a, b) => a - b);
  }
  const angles = indices.map((index) => measurement.angles[index]);
  const intensities = indices.map((index) => measurement.intensities[index]);
  if (!intensities.some((value) => value > 0)) throw new Error("The fit range needs positive measured intensity.");
  return {angles, intensities, sourcePoints};
}

function medianNumber(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function computeResidualDiagnostics(result, fit) {
  if (!state.measurement || !state.simulation) return null;
  const sample = measurementForFit(state.measurement, fit.range);
  const points = [];
  let measuredPeak = 0, modeledPeak = 0, peakAngle = fit.range[0];
  for (let index = 0; index < sample.angles.length; index++) {
    const angle = sample.angles[index], measured = sample.intensities[index];
    const modeled = interpolate(state.simulation.angles, state.simulation.intensities, angle);
    if (modeled === null || !Number.isFinite(modeled)) continue;
    points.push({angle, measured, modeled, residual:0});
    if (measured > measuredPeak) {measuredPeak = measured; peakAngle = angle;}
    if (modeled > modeledPeak) modeledPeak = modeled;
  }
  if (points.length < 10 || measuredPeak <= 0 || modeledPeak <= 0) return null;
  let totalSquared = 0;
  for (const point of points) {
    point.residual = Math.log10(Math.max(point.modeled / modeledPeak, 1e-12)) - Math.log10(Math.max(point.measured / measuredPeak, 1e-12));
    totalSquared += point.residual ** 2;
  }
  const span = fit.range[1] - fit.range[0];
  const halfWidth = Math.min(span / 6, Math.max(.15, result?.measured_peak_fwhm_deg || span * .02));
  const peakLow = Math.max(fit.range[0], peakAngle - halfWidth);
  const peakHigh = Math.min(fit.range[1], peakAngle + halfWidth);
  const definitions = [
    {name:"left", low:fit.range[0], high:peakLow},
    {name:"main peak", low:peakLow, high:peakHigh},
    {name:"right", low:peakHigh, high:fit.range[1]}
  ];
  const regions = definitions.map((definition, index) => {
    const selected = points.filter((point) => index === 2 ? point.angle >= definition.low && point.angle <= definition.high : point.angle >= definition.low && point.angle < definition.high);
    const rmse = selected.length ? Math.sqrt(selected.reduce((sum, point) => sum + point.residual ** 2, 0) / selected.length) : null;
    const median = medianNumber(selected.map((point) => point.residual));
    return {...definition, count:selected.length, rmse, median};
  });
  const largestResidual = points.reduce((largest, point) => Math.max(largest, Math.abs(point.residual)), 0);
  const chartLimit = Math.max(.25, Math.ceil(largestResidual * 4) / 4);
  return {points, regions, range:fit.range, peakAngle, peakLow, peakHigh, rmse:Math.sqrt(totalSquared / points.length), sourcePoints:sample.sourcePoints, chartLimit};
}

function ratioText(logRatio) {
  if (logRatio === null) return "—";
  const ratio = 10 ** logRatio;
  if (ratio >= 1000) return ">1,000×";
  if (ratio <= .001) return "<0.001×";
  return `${ratio.toFixed(ratio >= 10 ? 1 : 2)}×`;
}

function residualRangeFromCurrentInputs() {
  if (!state.measurement || !state.simulation) return null;
  const overlap = [Math.max(state.measurement.angles[0], state.simulation.angles[0]), Math.min(state.measurement.angles.at(-1), state.simulation.angles.at(-1))];
  if (!(overlap[0] < overlap[1])) return null;
  const low = Number($("fit_min").value), high = Number($("fit_max").value);
  const valid = $("fit_min").value.trim() && $("fit_max").value.trim() && Number.isFinite(low) && Number.isFinite(high) && overlap[0] <= low && low < high && high <= overlap[1] && upperBound(state.measurement.angles, high) - lowerBound(state.measurement.angles, low) >= 10;
  return {range:valid ? [low, high] : overlap, fallback:!valid};
}

function renderResidualDiagnostics(result = null, fit = null) {
  const selected = fit || residualRangeFromCurrentInputs();
  if (!selected) {state.residual = null; $("residualCard").hidden = true; return null;}
  fit = selected;
  let diagnostic;
  try { diagnostic = computeResidualDiagnostics(result, fit); }
  catch { diagnostic = null; }
  if (!diagnostic && !fit.fallback && !result) {
    const overlap = [Math.max(state.measurement.angles[0], state.simulation.angles[0]), Math.min(state.measurement.angles.at(-1), state.simulation.angles.at(-1))];
    if (overlap[0] < overlap[1] && (overlap[0] !== fit.range[0] || overlap[1] !== fit.range[1])) {
      try { diagnostic = computeResidualDiagnostics(null, {range:overlap}); }
      catch { diagnostic = null; }
    }
  }
  state.residual = diagnostic;
  $("residualCard").hidden = diagnostic === null;
  if (!diagnostic) return null;
  $("residualOverall").textContent = `${diagnostic.range[0].toFixed(2)}–${diagnostic.range[1].toFixed(2)}° · displayed residual RMSE ${diagnostic.rmse.toFixed(3)}`;
  const reviewRegions = diagnostic.regions.filter((region) => region.count >= 10);
  const worst = reviewRegions.reduce((current, region) => !current || region.rmse > current.rmse ? region : current, null);
  const cards = diagnostic.regions.map((region) => {
    const card = document.createElement("div");
    card.className = `residual-region${region === worst && reviewRegions.length > 1 ? " is-worst" : ""}`;
    const title = document.createElement("span");
    title.textContent = `${region.name} · ${region.low.toFixed(2)}–${region.high.toFixed(2)}°`;
    const value = document.createElement("strong");
    value.textContent = region.rmse === null ? "no measured points" : `log RMSE ${region.rmse.toFixed(3)}`;
    const detail = document.createElement("small");
    detail.textContent = region.rmse === null ? "adjust the range" : region.count < 10 ? `${region.count.toLocaleString("en")} measured points · too few, treat as indicative` : `median calculated/measured ${ratioText(region.median)} · ${region.count.toLocaleString("en")} points`;
    card.append(title, value, detail);
    return card;
  });
  $("residualRegions").replaceChildren(...cards);
  const extraction = diagnostic.sourcePoints > diagnostic.points.length ? ` · ${diagnostic.points.length.toLocaleString("en")} of ${diagnostic.sourcePoints.toLocaleString("en")} original points used` : "";
  const fallback = fit.fallback || diagnostic.range[0] !== fit.range[0] || diagnostic.range[1] !== fit.range[1] ? "The fit range could not be applied, so the whole overlapping region is shown. " : "";
  $("residualNote").textContent = `${fallback}Diagnostic${extraction} from the displayed calculated curve interpolated onto the measured angles. Zero intensity is treated as a relative 10⁻¹², and every residual is inside the chart axis. These numbers can differ from the peak-weighted optimisation score.`;
  requestDraw();
  return {worst, regions:diagnostic.regions, rmse:diagnostic.rmse};
}

function showFitResult(result, fit) {
  state.fitResult = {
    intensity_transform:state.measurement?.intensity_transform,
    parameters: result.config.parameters,
    initial_log_rmse: result.initial_log_rmse,
    best_log_rmse: result.best_log_rmse,
    initial_fit_merit: result.initial_fit_merit,
    best_fit_merit: result.best_fit_merit,
    measured_peak_fwhm_deg: result.measured_peak_fwhm_deg,
    fitted_peak_fwhm_deg: result.fitted_peak_fwhm_deg,
    thickness_nm: result.thickness_nm,
    evaluations: result.evaluations,
    fit_points: result.fit_points,
    reference_decimated: result.reference_decimated,
    diagnostics: result.diagnostics,
    message: result.message,
    range: fit.range,
    bounds: fit.bounds,
    thickness_bounds_nm: fit.thickness_bounds_nm,
    initial_parameters: fit.initial_parameters,
    adjusted: fit.adjusted,
    source_points: fit.sourcePoints || result.fit_points,
    stale: false
  };
  $("fitResult").classList.remove("is-stale");
  $("fitStale").hidden = true;
  $("fitResultRange").textContent = `${fit.range[0].toFixed(3)}–${fit.range[1].toFixed(3)}°`;
  const thicknessFitted = Boolean(fit.thickness_bounds_nm || fit.bounds?.film_planes);
  $("fitThicknessLabel").textContent = thicknessFitted ? "Thickness (fitted)" : "Thickness (converted at fixed N)";
  $("fitPlanesLabel").textContent = thicknessFitted ? "Repeats N (fitted)" : "Repeats N (fixed)";
  $("fitThickness").textContent = `${result.thickness_nm.toFixed(2)} nm`;
  const resultParams = result.config.parameters, activeC = filmAxisMode(resultParams) === "00l";
  $("fitLatticeLabel").textContent = activeC ? "Film mean c" : "Film mean a";
  $("fitLattice").textContent = `${filmActiveMean(resultParams).toFixed(5)} Å`;
  $("fitOtherLatticeField").hidden = resultParams.film_system !== "tetragonal";
  $("fitOtherLatticeLabel").textContent = activeC ? "Film a (fixed)" : "Film c";
  $("fitOtherLattice").textContent = `${(activeC ? resultParams.film_lattice_a : resultParams.film_lattice_c || resultParams.film_lattice_a).toFixed(5)} Å`;
  const meanA = filmActiveMean(result.config.parameters), gradientA = result.config.parameters.film_lattice_gradient_a;
  $("fitGradientLabel").textContent = filmGradientLabel(resultParams) + (fit.bounds?.film_lattice_gradient_a ? " (fitted)" : " (fixed)");
  $("fitGradient").textContent = `${gradientA > 0 ? "+" : ""}${gradientA.toFixed(5)} Å`;
  $("fitGradientEndpoints").textContent = `interface ${((meanA - gradientA / 2)).toFixed(5)} → surface ${((meanA + gradientA / 2)).toFixed(5)} Å`;
  $("fitPlanes").textContent = `${result.config.parameters.film_planes}`;
  const initialFwhm = Number(fit.initial_parameters?.fwhm_deg);
  const finalFwhm = result.config.parameters.fwhm_deg;
  $("fitFwhm").textContent = fit.bounds?.fwhm_deg ? (Number.isFinite(initialFwhm) ? `${initialFwhm.toFixed(4)} → ${finalFwhm.toFixed(4)}°` : `${finalFwhm.toFixed(4)}°`) : `${finalFwhm.toFixed(4)}° fixed`;
  for (const [key, id, unit] of [["resolution_halo_fraction", "fitHaloFraction", ""], ["resolution_halo_width", "fitHaloWidth", "×"], ["film_interface_width", "fitInterfaceWidth", "repeats"], ["film_thickness_sigma", "fitThicknessSigma", "repeats"], ["film_intensity_scale", "fitFilmScale", "×"], ["background_slope", "fitBackgroundSlope", "log₁₀/°"]]) {
    const value = result.config.parameters[key], mode = fit.bounds?.[key] ? "fitted" : "fixed";
    $(id).textContent = `${trimNumber(value, 5)} ${unit} · ${mode}`;
  }
  renderFringeComparison();
  $("fitLpMode").textContent = Array.from($("lp_mode").options).find(option => option.value === result.config.parameters.lp_mode)?.textContent || "—";
  $("fitPeakFwhm").textContent = result.measured_peak_fwhm_deg === null || result.fitted_peak_fwhm_deg === null ? "not measurable" : `${result.measured_peak_fwhm_deg.toFixed(4)} → ${result.fitted_peak_fwhm_deg.toFixed(4)}°`;
  $("fitError").textContent = `${result.initial_log_rmse === null ? "—" : result.initial_log_rmse.toFixed(3)} → ${result.best_log_rmse.toFixed(3)}`;
  const sourceDescription = fit.sourcePoints > result.fit_points ? ` (sampled from ${fit.sourcePoints.toLocaleString("en")} points in that range)` : "";
  const adjusted = Array.isArray(fit.adjusted) && fit.adjusted.length ? ` · starting values moved onto bounds: ${fit.adjusted.join(", ")}` : "";
  $("fitResultDetails").textContent = `${result.fit_points.toLocaleString("en")} measured points${sourceDescription} · ${result.evaluations.toLocaleString("en")} model evaluations${adjusted}`;
  $("fitMerit").hidden = result.best_fit_merit === null;
  if (result.best_fit_merit !== null) $("fitMerit").textContent = `Peak-weighted fit error ${result.initial_fit_merit === null ? "—" : result.initial_fit_merit.toFixed(3)} → ${result.best_fit_merit.toFixed(3)} · the optimisation criterion (log RMSE is a separate whole-range measure)`;
  const residualAssessment = renderResidualDiagnostics(result, fit);
  const boundaryHits = [];
  for (const [key, [low, high]] of Object.entries(fit.bounds || {})) {
    const value = result.config.parameters[key], tolerance = fitIntegerKeys.has(key) ? 0 : Math.max(1e-8, (high - low) * 1e-4);
    if (Math.abs(value - low) <= tolerance) boundaryHits.push({key, side:"lower bound"});
    else if (Math.abs(value - high) <= tolerance) boundaryHits.push({key, side:"upper bound"});
  }
  const warnings = [];
  if (filmAxisMode(resultParams) === "mixed" && fit.bounds?.film_lattice_a && fit.bounds?.film_lattice_c) warnings.push("A single mixed reflection constrains only a combination of a and c. Do not interpret both fitted axes as independent lattice measurements.");
  if (resultParams.film_intensity_scale === 0) warnings.push("Film intensity scale is zero, so there is no film scattering. Film lattice, thickness and gradient cannot be determined in this condition.");
  if (fit.bounds?.film_intensity_scale && resultParams.substrate_planes === 0) warnings.push("Without substrate scattering, normalization cancels a positive film intensity scale. Adding relative background does not determine this scale.");
  const haloFraction = result.config.parameters.resolution_halo_fraction;
  const haloWidth = result.config.parameters.resolution_halo_width;
  if (haloFraction === 0 && fit.bounds?.resolution_halo_width) warnings.push("The broad component fraction f is zero, so width multiplier m is unconstrained. Do not interpret a fitted m under this condition.");
  if (haloWidth === 1 && fit.bounds?.resolution_halo_fraction) warnings.push("With width multiplier m = 1, both Gaussian components are identical and fraction f is unconstrained.");
  if (finalFwhm === 0 && (haloFraction > 0 || fit.bounds?.resolution_halo_fraction || fit.bounds?.resolution_halo_width)) warnings.push("The instrumental FWHM is zero, so the broad resolution component has no effect. Do not interpret fitted f or m values.");
  if (result.config.parameters.film_interface_width > 0 && result.config.parameters.film_thickness_sigma > 0) warnings.push("Boundary taper w and thickness spread σN are both active. They can be correlated: compare the regional residuals from fitting each separately. Neither is an independent measurement of roughness.");
  if (result.config.parameters.background === 0 && (result.config.parameters.background_slope !== 0 || fit.bounds?.background_slope)) warnings.push("The relative background is zero, so the log background slope has no effect. Do not interpret a fitted slope under this condition.");
  let filmCountHit = boundaryHits.find((item) => item.key === "film_planes");
  if (!filmCountHit && fit.thickness_bounds_nm) {
    const repeatNm = filmRepeatNm(result.config.parameters);
    const smallestN = Math.ceil(fit.thickness_bounds_nm[0] / repeatNm - 1e-7);
    const largestN = Math.floor(fit.thickness_bounds_nm[1] / repeatNm + 1e-7);
    if (result.config.parameters.film_planes <= smallestN) filmCountHit = {key:"film_planes", side:"lower bound"};
    else if (result.config.parameters.film_planes >= largestN) filmCountHit = {key:"film_planes", side:"upper bound"};
  }
  if (filmCountHit) warnings.push(`The thickness reached the ${filmCountHit.side} of the possible integer repeat counts. Do not take the model thickness as settled — widen the range and check that the model fits.`);
  const gradientHit = boundaryHits.find((item) => item.key === "film_lattice_gradient_a");
  if (gradientHit) {
    const selectedEdge = gradientHit.side === "lower bound" ? fit.bounds.film_lattice_gradient_a[0] : fit.bounds.film_lattice_gradient_a[1];
    const limitAdvice = Math.abs(selectedEdge) >= .2 - 1e-9 ? "That is the end of the range this interface allows." : "Widen the bounds within ±0.20 Å and run it again if that is reasonable.";
    warnings.push(`${filmGradientLabel(resultParams)} reached the selected ${gradientHit.side} bound of ${selectedEdge.toFixed(3)} Å. ${limitAdvice} Do not interpret the model gradient as independently measured strain.`);
  }
  const largeGradient = Math.abs(gradientA) / meanA > .01;
  if (largeGradient) warnings.push(`The relative film lattice gradient is ${(Math.abs(gradientA) / meanA * 100).toFixed(2)}%. This is an effective normal-spacing change in the model, not independently established strain. Compare other gradient, thickness and instrumental-width assumptions.`);
  const fwhmHit = boundaryHits.find((item) => item.key === "fwhm_deg");
  if (fwhmHit) warnings.push(`The instrumental Gaussian FWHM reached its ${fwhmHit.side}. Check the measured and modelled peak positions and the reflection you assigned — FWHM does not correct a position error.`);
  if (fit.bounds?.fwhm_deg && result.measured_peak_fwhm_deg !== null && result.fitted_peak_fwhm_deg !== null && Math.abs(result.fitted_peak_fwhm_deg - result.measured_peak_fwhm_deg) / result.measured_peak_fwhm_deg > .25) warnings.push(`The calculated peak width ${result.fitted_peak_fwhm_deg.toFixed(4)}° differs from the measured ${result.measured_peak_fwhm_deg.toFixed(4)}° by more than 25%. Check the peak region, the instrumental-width bounds and the model assumptions.`);
  const substrateHit = boundaryHits.find((item) => item.key === "substrate_planes");
  const substrateAtGuiLimit = substrateHit?.side === "upper bound" && fit.bounds.substrate_planes[1] === substrateFitMax;
  if (substrateAtGuiLimit) warnings.push(`The substrate coherent repeat count reached this interface's upper limit of ${substrateFitMax.toLocaleString("en")}. This is not a physical substrate thickness. Check the substrate peak tails, the instrumental width, and the reflection and wavelength you assumed.`);
  else if (substrateHit?.side === "upper bound") warnings.push(`The substrate coherent repeat count reached your upper bound of ${fit.bounds.substrate_planes[1].toLocaleString("en")}. Widen it, up to this interface's limit of ${substrateFitMax.toLocaleString("en")}, and check again.`);
  else if (substrateHit?.side === "lower bound") warnings.push(fit.bounds.substrate_planes[0] === 1 ? "The substrate coherent repeat count reached the model minimum of 1. Check the substrate peak and the measurement conditions." : `The substrate coherent repeat count reached your lower bound of ${fit.bounds.substrate_planes[0].toLocaleString("en")}. Check whether a lower value is plausible, along with the bounds and measurement conditions.`);
  const backgroundHit = boundaryHits.find((item) => item.key === "background");
  if (backgroundHit?.side === "lower bound" && fit.bounds.background?.[0] === 0) warnings.push("The relative background reached its minimum of 0. Lowering the background cannot reduce the calculated tails any further. Check the substrate coherence length, instrumental width, reflection and wavelength, and the model assumptions.");
  else if (backgroundHit) warnings.push(`The relative background reached its ${backgroundHit.side}. Check the bounds.`);
  const otherHits = boundaryHits.filter((item) => !["film_planes", "film_lattice_gradient_a", "fwhm_deg", "substrate_planes", "background"].includes(item.key));
  if (otherHits.length) warnings.push(`${otherHits.map((item) => `${labelFor(item.key)} ${item.side}`).join(", ")} reached a bound. Widen it and check the result.`);
  if (result.diagnostics?.fixed_sto_wing_excess) {
    const ratio = (log) => log === null ? "more than 3×" : `about ${Math.pow(10, Math.min(4, Math.max(0, log))).toFixed(1)}×`;
    const advice = result.config.parameters.substrate_planes >= substrateFitMax ? "That is already this interface's upper limit, so review the substrate peak, the instrumental function and the model assumptions." : "Raise the substrate coherent repeat count, or select it as a fitted parameter.";
    warnings.push(`With the substrate coherent repeat count fixed at ${result.config.parameters.substrate_planes.toLocaleString("en")}, the calculated left and right tails sit ${ratio(result.diagnostics.left_wing_log_ratio)} and ${ratio(result.diagnostics.right_wing_log_ratio)} above the measurement. ${advice} Thickness and a positive background alone will not close that gap.`);
  }
  const rightResidual = residualAssessment?.regions.find((region) => region.name === "right");
  const rightWingBias = rightResidual?.count >= 10 && rightResidual.median !== null && Math.abs(rightResidual.median) >= Math.log10(2);
  if (rightWingBias && !result.diagnostics?.fixed_sto_wing_excess) warnings.push(`Over ${rightResidual.low.toFixed(2)}–${rightResidual.high.toFixed(2)}° on the right of the fit range, the median calculated/measured intensity ratio is ${ratioText(rightResidual.median)}. Do not judge the peak tails from the overall score alone.`);
  if (residualAssessment?.worst?.rmse >= .3 && result.best_log_rmse < .5 && !rightWingBias) warnings.push(`On the displayed curve, the ${residualAssessment.worst.name} region has a log RMSE of ${residualAssessment.worst.rmse.toFixed(3)}. Look at the per-region residuals.`);
  if (fit.thickness_bounds_nm && (result.thickness_nm < fit.thickness_bounds_nm[0] - 1e-7 || result.thickness_nm > fit.thickness_bounds_nm[1] + 1e-7)) warnings.push("The resulting thickness fell outside the nm bounds you asked for. Check the settings.");
  if (fit.bounds?.fwhm_deg && state.measurement && Number.isFinite(state.simulation?.substratePeak)) {
    const first = lowerBound(state.measurement.angles, fit.range[0]), last = upperBound(state.measurement.angles, fit.range[1]);
    let main = first;
    for (let i = first + 1; i < last; i++) if (state.measurement.intensities[i] > state.measurement.intensities[main]) main = i;
    const separation = Math.abs(state.measurement.angles[main] - state.simulation.substratePeak);
    if (separation > .1) warnings.push(`The measured main peak and the expected substrate position are ${separation.toFixed(3)}° apart. If you assigned this peak to the substrate, check the reflection and the zero offset — FWHM cannot close a position gap.`);
  }
  if (result.best_log_rmse >= .5) warnings.push("A large log error remains. Check the reflection, wavelength and material you assumed, the fit range, and whether the model suits this sample.");
  if (result.initial_log_rmse !== null && result.best_fit_merit !== null && result.best_log_rmse > result.initial_log_rmse + Math.max(.05, .05 * result.initial_log_rmse)) warnings.push("Matching the main peak width raised the whole-range log RMSE. Look at the residuals on the chart and at the fit range.");
  if (result.diagnostics?.fit_improved_materially === false && result.best_log_rmse >= .25) warnings.push("The fit error did not improve meaningfully over the starting values. Do not take this thickness as settled.");
  else if (result.best_fit_merit !== null && result.initial_fit_merit !== null && result.initial_fit_merit > 0 && result.best_fit_merit / result.initial_fit_merit > .95) warnings.push("The peak-weighted fit error barely improved over the starting values. Check the starting values and the fit bounds.");
  else if (result.best_fit_merit === null && result.initial_log_rmse !== null && result.initial_log_rmse > 0 && result.best_log_rmse / result.initial_log_rmse > .95) warnings.push("The error barely improved over the starting values. Check the starting values and the fit bounds.");
  if (result.initial_log_rmse === null) warnings.push("The starting model you entered did not produce a valid comparison curve. Check that the fit result is physically sensible.");
  if (fit.sourcePoints > result.fit_points) warnings.push("The optimisation used a sample of the measured points. Check the agreement against the whole measured curve.");
  if (result.reference_decimated) warnings.push("The fit ran on a reduced calculation grid. Check the agreement against the full-resolution curve.");
  const warningBox = $("fitWarning");
  warningBox.replaceChildren(...warnings.map((warning) => {
    const line = document.createElement("span");
    line.className = "fit-warning-item";
    line.textContent = warning;
    return line;
  }));
  warningBox.hidden = warnings.length === 0;
  const needsReview = Boolean(gradientHit) || largeGradient || substrateAtGuiLimit || result.best_log_rmse >= .5 || rightWingBias || residualAssessment?.worst?.rmse >= .3 || result.diagnostics?.fixed_sto_wing_excess === true || (result.diagnostics?.fit_improved_materially === false && result.best_log_rmse >= .25);
  $("fit-result-title").textContent = needsReview ? "Fit result needs review" : "Fit result";
  $("fitResult").querySelector(".eyebrow").textContent = needsReview ? "FIT CHECK" : "BEST FIT";
  $("fitResult").classList.toggle("needs-review", needsReview);
  $("fitResult").hidden = false;
  return {warningCount:warnings.length, needsReview};
}

async function runFit() {
  if (state.fitBusy) return;
  let config, fit;
  try { config = readForm(); fit = readFitSettings(config); }
  catch (error) { setFitProgress(error.message, "error"); setStatus(`Check the fit input: ${error.message}`, true); return; }
  const start = projectFitStart(config, fit);
  const measurement = state.measurement;
  let fitMeasurement;
  try { fitMeasurement = measurementForFit(measurement, fit.range); }
  catch (error) { setFitProgress(error.message, "error"); setStatus(`Check the fit input: ${error.message}`, true); return; }
  const id = ++state.requestId;
  const job = `fit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setFitBusy(true);
  const sampling = fitMeasurement.sourcePoints > fitMeasurement.angles.length ? ` · ${fitMeasurement.angles.length.toLocaleString("en")} of ${fitMeasurement.sourcePoints.toLocaleString("en")} points used` : "";
  const rangeText = `${fit.range[0].toFixed(3)}–${fit.range[1].toFixed(3)}°${sampling}${start.adjusted.length ? ` · starting values moved onto bounds: ${start.adjusted.join(", ")}` : ""}`;
  startFitWatch(job, fit.max_evaluations, rangeText);
  setStatus("Matching the measured log intensity together with the width and shape of the main peak…");
  try {
    const body = {parameters:start.parameters, measurement:{angles:fitMeasurement.angles,intensities:fitMeasurement.intensities}, fit, job};
    const raw = await getJson("/api/fit", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if (id !== state.requestId) return;
    if (raw && raw.cancelled) {
      setFitProgress("Fit stopped. Nothing was changed — adjust the bounds or the search budget and run it again.", "warning");
      setStatus("The fit was stopped.");
      return;
    }
    const result = validateFitResponse(raw, config.scan);
    const simulated = await getJson("/api/simulate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(result.config)});
    if (id !== state.requestId) return;
    const curve = validateSimulation(simulated);
    applyConfig(result.config);
    installSimulation(result.config, curve);
    const fitAssessment = showFitResult(result, {...fit, sourcePoints:fitMeasurement.sourcePoints, initial_parameters:start.parameters, adjusted:start.adjusted});
    const meritProgress = result.best_fit_merit === null ? `log RMSE ${result.initial_log_rmse === null ? "—" : result.initial_log_rmse.toFixed(3)} → ${result.best_log_rmse.toFixed(3)}` : `peak-weighted error ${result.initial_fit_merit === null ? "—" : result.initial_fit_merit.toFixed(3)} → ${result.best_fit_merit.toFixed(3)}`;
    setFitProgress(`${fitAssessment.needsReview ? "Needs review" : "Done"} · ${result.evaluations.toLocaleString("en")} evaluations · ${meritProgress}`, fitAssessment.needsReview ? "warning" : "success");
    setStatus(`${fitAssessment.needsReview ? "Fit result needs review" : "Fit finished"} · model thickness ${result.thickness_nm.toFixed(2)} nm${fitAssessment.warningCount ? " · read the cautions on the result." : ""}`);
  } catch (error) {
    if (id === state.requestId) {
      setFitProgress(`Fit failed: ${explainModelError(error)}`, "error");
      setStatus(`Fit error: ${explainModelError(error)}`, true);
    }
  } finally {
    stopFitWatch();
    const button = $("cancelFit");
    if (button) button.textContent = "Stop fitting";
    setFitBusy(false);
  }
}

function lowerBound(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (array[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}

function upperBound(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (array[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

function interpolate(xs, ys, x) {
  if (!xs || x < xs[0] || x > xs[xs.length - 1]) return null;
  const index = lowerBound(xs, x);
  if (index === 0) return ys[0];
  if (index >= xs.length) return ys[ys.length - 1];
  if (xs[index] === x) return ys[index];
  const portion = (x - xs[index - 1]) / (xs[index] - xs[index - 1]);
  return ys[index - 1] + portion * (ys[index] - ys[index - 1]);
}

function visibleMaximum(xs, ys, lo, hi) {
  const start = lowerBound(xs, lo), end = upperBound(xs, hi);
  let maximum = 0, index = -1;
  for (let i = start; i < end; i++) if (ys[i] > maximum) {maximum = ys[i]; index = i;}
  return {maximum, index};
}

function computeStats() {
  if (!state.simulation) return null;
  const [lo, hi] = state.view, sim = state.simulation, meas = state.measurement;
  const simPeak = visibleMaximum(sim.angles, sim.intensities, lo, hi);
  const measPeak = meas ? visibleMaximum(meas.angles, meas.intensities, lo, hi) : {maximum:0,index:-1};
  const simMax = simPeak.maximum || 1, measMax = measPeak.maximum || 1;
  let sum = 0, count = 0;
  if (meas && measPeak.index !== -1) {
    const start = lowerBound(sim.angles, lo), end = upperBound(sim.angles, hi);
    for (let i = start; i < end; i++) {
      const measured = interpolate(meas.angles, meas.intensities, sim.angles[i]);
      if (measured === null || measured <= 0) continue;
      const a = Math.log10(Math.max(measured / measMax, 1e-10));
      const b = Math.log10(Math.max(sim.intensities[i] / simMax, 1e-10));
      sum += (a - b) ** 2; count++;
    }
  }
  return {simMax, measMax, observedIndex:measPeak.index, rmse:count >= 3 ? Math.sqrt(sum / count) : null};
}

function updateMetrics() {
  const sim = state.simulation;
  if (!sim) return;
  state.stats = computeStats();
  const observed = state.stats.observedIndex >= 0 ? state.measurement.angles[state.stats.observedIndex] : null;
  $("observedPeak").textContent = observed === null ? "—" : `${formatAngle(observed)}°`;
  $("substratePeak").textContent = sim.substratePeak === null ? "out of range" : `${formatAngle(sim.substratePeak)}°`;
  $("filmPeak").textContent = sim.filmPeak === null ? "out of range" : `${formatAngle(sim.filmPeak)}°`;
  $("logRmse").textContent = state.stats.rmse === null ? "—" : state.stats.rmse.toFixed(3);
}

function niceStep(span, target = 6) {
  const rough = Math.max(span / target, 1e-10), base = 10 ** Math.floor(Math.log10(rough));
  for (const multiplier of [1, 2, 2.5, 5, 10]) if (multiplier * base >= rough) return multiplier * base;
  return base * 10;
}

function xTick(value, step) {
  const digits = Math.max(0, Math.min(5, -Math.floor(Math.log10(step)) + (step / (10 ** Math.floor(Math.log10(step))) < 2 ? 1 : 0)));
  return value.toFixed(digits);
}

function prepareCanvases() {
  const wrap = $("plotWrap"), rect = wrap.getBoundingClientRect();
  const width = Math.max(0, rect.width), height = Math.max(0, rect.height);
  if (width < 100 || height < 100) return null;
  const ratio = Math.min(2.5, window.devicePixelRatio || 1);
  for (const canvas of [$("chartCanvas"), $("interactionCanvas")]) {
    const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
    canvas.getContext("2d").setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  const left = width < 500 ? 52 : 64;
  return {width, height, left, right:width - 15, top:31, bottom:height - 48};
}

function xPixel(x) { return state.plot.left + (x - state.view[0]) / (state.view[1] - state.view[0]) * (state.plot.right - state.plot.left); }
function pixelX(x) { return state.view[0] + (x - state.plot.left) / (state.plot.right - state.plot.left) * (state.view[1] - state.view[0]); }
function yPixel(relative) {
  const ratio = state.logScale ? (Math.log10(Math.max(relative, 1e-9)) + 9) / 9 : relative;
  return state.plot.bottom - Math.max(0, Math.min(1, ratio)) * (state.plot.bottom - state.plot.top);
}

function drawAxes(ctx) {
  const p = state.plot, span = state.view[1] - state.view[0];
  ctx.clearRect(0, 0, p.width, p.height);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, p.width, p.height);
  ctx.save(); ctx.font = "11px system-ui, sans-serif"; ctx.fillStyle = "#8594a6"; ctx.strokeStyle = "#e9eef3"; ctx.lineWidth = 1;
  const yTicks = state.logScale ? [0,-1,-2,-3,-4,-5,-6,-7,-8,-9] : [0,.2,.4,.6,.8,1];
  for (const tick of yTicks) {
    const rel = state.logScale ? 10 ** tick : tick, py = yPixel(rel);
    ctx.beginPath(); ctx.moveTo(p.left, py + .5); ctx.lineTo(p.right, py + .5); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(state.logScale ? (tick === 0 ? "1" : `10⁻${-tick}`) : tick.toFixed(1), p.left - 9, py);
  }
  const step = niceStep(span, p.width < 550 ? 5 : 8);
  const first = Math.ceil((state.view[0] - 1e-10) / step) * step;
  for (let x = first; x <= state.view[1] + step * 1e-5; x += step) {
    const px = xPixel(x);
    ctx.beginPath(); ctx.moveTo(px + .5, p.top); ctx.lineTo(px + .5, p.bottom); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(xTick(x, step), px, p.bottom + 10);
  }
  ctx.strokeStyle = "#afbdcb"; ctx.beginPath(); ctx.moveTo(p.left + .5, p.top); ctx.lineTo(p.left + .5, p.bottom + .5); ctx.lineTo(p.right, p.bottom + .5); ctx.stroke();
  ctx.fillStyle = "#687b91"; ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.font = "600 11px system-ui, sans-serif"; ctx.fillText("2θ (°)", (p.left + p.right) / 2, p.height - 3);
  ctx.restore();
}

function drawMarker(ctx, x, color, label, y) {
  const p = state.plot;
  if (x === null || x < state.view[0] || x > state.view[1]) return;
  const px = xPixel(x);
  ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = .78; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.moveTo(px, p.top); ctx.lineTo(px, p.bottom); ctx.stroke();
  ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.fillStyle = color; ctx.font = "700 10px system-ui, sans-serif"; ctx.textBaseline = "middle";
  const labelWidth = ctx.measureText(label).width + 12;
  const labelX = Math.min(p.right - labelWidth, Math.max(p.left + 2, px + 5));
  ctx.fillStyle = "#fff"; ctx.fillRect(labelX - 3, y - 7, labelWidth + 2, 15);
  ctx.fillStyle = color; ctx.fillText(label, labelX + 2, y);
  ctx.restore();
}

function drawFitRegion(ctx) {
  const low = Number($("fit_min").value), high = Number($("fit_max").value), p = state.plot;
  if (!$("fit_min").value.trim() || !$("fit_max").value.trim() || !Number.isFinite(low) || !Number.isFinite(high) || low >= high || high < state.view[0] || low > state.view[1]) return;
  const left = Math.max(p.left, xPixel(low)), right = Math.min(p.right, xPixel(high));
  ctx.save();
  ctx.beginPath(); ctx.rect(p.left, p.top, p.right - p.left, p.bottom - p.top); ctx.clip();
  ctx.fillStyle = "rgba(37,102,207,.045)"; ctx.fillRect(left, p.top, right - left, p.bottom - p.top);
  ctx.strokeStyle = "rgba(91,139,210,.62)"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  for (const edge of [low, high]) {
    if (edge < state.view[0] || edge > state.view[1]) continue;
    const x = xPixel(edge) + .5;
    ctx.beginPath(); ctx.moveTo(x, p.top); ctx.lineTo(x, p.bottom); ctx.stroke();
  }
  ctx.restore();
}

function drawCurve(ctx, xs, ys, denominator, color, width) {
  if (!xs || !ys || !xs.length || !state.plot) return;
  const p = state.plot;
  const first = Math.max(0, lowerBound(xs, state.view[0]) - 1);
  const last = Math.min(xs.length, upperBound(xs, state.view[1]) + 1);
  if (last - first < 2) return;
  const capacity = Math.max(200, Math.floor((p.right - p.left) * 2.5));
  const stride = Math.max(1, Math.ceil((last - first) / capacity));
  ctx.save(); ctx.beginPath(); ctx.rect(p.left, p.top, p.right - p.left, p.bottom - p.top); ctx.clip();
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath(); let started = false;
  function point(index) {
    const px = xPixel(xs[index]), py = yPixel(ys[index] / denominator);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  for (let start = first; start < last; start += stride) {
    const end = Math.min(last, start + stride);
    let min = start, max = start;
    for (let j = start + 1; j < end; j++) { if (ys[j] < ys[min]) min = j; if (ys[j] > ys[max]) max = j; }
    if (stride === 1) point(start);
    else if (min === max) point(min);
    else { point(Math.min(min, max)); point(Math.max(min, max)); }
  }
  ctx.stroke(); ctx.restore();
}

function drawChart() {
  state.framePending = false;
  state.plot = prepareCanvases();
  if (!state.plot) { drawResidualChart(); return; }
  const ctx = $("chartCanvas").getContext("2d");
  drawAxes(ctx);
  drawFitRegion(ctx);
  if (state.simulation) {
    if (!state.stats) state.stats = computeStats();
    drawMarker(ctx, state.simulation.substratePeak, "#2d9b83", substrateShortLabel(), 13);
    drawMarker(ctx, state.simulation.filmPeak, "#806ec4", "Film", 28);
    drawCurve(ctx, state.simulation.angles, state.simulation.intensities, state.stats.simMax, "#2566cf", 1.85);
    if (state.measurement) drawCurve(ctx, state.measurement.angles, state.measurement.intensities, state.stats.measMax, "#e5753b", 2.1);
  }
  drawOverlay();
  drawResidualChart();
}

function drawResidualChart() {
  const diagnostic = state.residual, wrap = $("residualPlotWrap");
  if (!diagnostic || $("residualCard").hidden) return;
  const rect = wrap.getBoundingClientRect(), width = rect.width, height = rect.height;
  if (width < 100 || height < 100) return;
  const canvas = $("residualCanvas"), ratio = Math.min(2.5, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) { canvas.width = pixelWidth; canvas.height = pixelHeight; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, width, height);
  const p = {left:width < 500 ? 47 : 58, right:width - 17, top:22, bottom:height - 37};
  const span = diagnostic.range[1] - diagnostic.range[0], limit = diagnostic.chartLimit;
  const xPixelResidual = (angle) => p.left + (angle - diagnostic.range[0]) / span * (p.right - p.left);
  const yPixelResidual = (value) => p.bottom - (value + limit) / (2 * limit) * (p.bottom - p.top);
  ctx.save();
  ctx.fillStyle = "rgba(37,102,207,.055)";
  ctx.fillRect(xPixelResidual(diagnostic.peakLow), p.top, xPixelResidual(diagnostic.peakHigh) - xPixelResidual(diagnostic.peakLow), p.bottom - p.top);
  ctx.font = "10px system-ui, sans-serif"; ctx.fillStyle = "#718399"; ctx.strokeStyle = "#e7edf3"; ctx.lineWidth = 1;
  for (const tick of [-limit, -limit / 2, 0, limit / 2, limit]) {
    const y = yPixelResidual(tick);
    ctx.beginPath(); ctx.moveTo(p.left, y + .5); ctx.lineTo(p.right, y + .5); ctx.stroke();
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    ctx.fillText(`${tick > 0 ? "+" : ""}${tick.toFixed(limit >= 2 ? 1 : 2)}`, p.left - 7, y);
  }
  const step = niceStep(span, width < 550 ? 4 : 7), first = Math.ceil((diagnostic.range[0] - 1e-10) / step) * step;
  for (let angle = first; angle <= diagnostic.range[1] + step * 1e-5; angle += step) {
    const x = xPixelResidual(angle);
    ctx.beginPath(); ctx.moveTo(x + .5, p.top); ctx.lineTo(x + .5, p.bottom); ctx.stroke();
    ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillText(xTick(angle, step), x, p.bottom + 8);
  }
  ctx.strokeStyle = "#839ab6"; ctx.lineWidth = 1.25;
  const zero = yPixelResidual(0); ctx.beginPath(); ctx.moveTo(p.left, zero + .5); ctx.lineTo(p.right, zero + .5); ctx.stroke();
  ctx.beginPath(); ctx.rect(p.left, p.top, p.right - p.left, p.bottom - p.top); ctx.clip();
  ctx.strokeStyle = "#305fba"; ctx.lineWidth = 1.6; ctx.lineJoin = "round";
  ctx.beginPath();
  diagnostic.points.forEach((point, index) => {
    const x = xPixelResidual(point.angle), y = yPixelResidual(point.residual);
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke(); ctx.restore();
  ctx.save(); ctx.strokeStyle = "#b8c6d5"; ctx.beginPath(); ctx.moveTo(p.left + .5, p.top); ctx.lineTo(p.left + .5, p.bottom + .5); ctx.lineTo(p.right, p.bottom + .5); ctx.stroke();
  ctx.fillStyle = "#58708b"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillText("calculated higher +", p.left + 5, p.top + 11); ctx.fillText("measured higher −", p.left + 5, p.bottom - 7);
  ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText("2θ (°)", (p.left + p.right) / 2, height - 2); ctx.restore();
}

function requestDraw() {
  if (state.framePending) return;
  state.framePending = true;
  requestAnimationFrame(drawChart);
}

function drawOverlay() {
  if (!state.plot) return;
  const ctx = $("interactionCanvas").getContext("2d"), p = state.plot;
  ctx.clearRect(0, 0, p.width, p.height);
  if (state.dragStart !== null && state.dragEnd !== null) {
    const left = Math.min(state.dragStart, state.dragEnd), right = Math.max(state.dragStart, state.dragEnd);
    ctx.fillStyle = "rgba(37,102,207,.12)"; ctx.fillRect(left, p.top, right - left, p.bottom - p.top);
    ctx.strokeStyle = "#2566cf"; ctx.setLineDash([5, 4]); ctx.strokeRect(left + .5, p.top + .5, right - left, p.bottom - p.top); ctx.setLineDash([]);
  } else if (state.hover !== null && state.hover >= p.left && state.hover <= p.right) {
    ctx.strokeStyle = "rgba(62,83,108,.55)"; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(state.hover + .5, p.top); ctx.lineTo(state.hover + .5, p.bottom); ctx.stroke(); ctx.setLineDash([]);
  }
}

function updateHover(clientX, clientY) {
  if (!state.plot || !state.simulation) return;
  const rect = $("plotWrap").getBoundingClientRect(), px = clientX - rect.left, py = clientY - rect.top, p = state.plot;
  const tooltip = $("plotTooltip");
  if (px < p.left || px > p.right || py < p.top || py > p.bottom) {
    state.hover = null; tooltip.hidden = true; $("hoverReadout").textContent = "Hover over a 2θ position to read the values."; drawOverlay(); return;
  }
  state.hover = px;
  const x = pixelX(px), stats = state.stats || computeStats();
  const measured = state.measurement ? interpolate(state.measurement.angles, state.measurement.intensities, x) : null;
  const simulated = interpolate(state.simulation.angles, state.simulation.intensities, x);
  const measuredRelative = measured === null ? null : measured / stats.measMax;
  const simulatedRelative = simulated === null ? null : simulated / stats.simMax;
  $("hoverReadout").textContent = `2θ ${x.toFixed(3)}° · measured ${measuredRelative === null ? "—" : measuredRelative.toExponential(2)} · calculated ${simulatedRelative === null ? "—" : simulatedRelative.toExponential(2)}`;
  tooltip.replaceChildren();
  const title = document.createElement("b"); title.textContent = `2θ ${x.toFixed(3)}°`; tooltip.append(title, document.createElement("br"));
  const line1 = document.createElement("span"); line1.className = "orange"; line1.textContent = `measured relative intensity  ${measuredRelative === null ? "—" : measuredRelative.toExponential(3)}`; tooltip.append(line1, document.createElement("br"));
  const line2 = document.createElement("span"); line2.className = "blue"; line2.textContent = `calculated relative intensity  ${simulatedRelative === null ? "—" : simulatedRelative.toExponential(3)}`; tooltip.append(line2);
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(p.width - 170, Math.max(10, px + 13))}px`;
  tooltip.style.top = `${Math.min(p.height - 75, Math.max(6, py + 13))}px`;
  drawOverlay();
}

function resetZoom() {
  if (!state.simulation) return;
  state.view = [state.simulation.angles[0], state.simulation.angles.at(-1)];
  state.hover = null; state.stats = null; $("plotTooltip").hidden = true;
  updateMetrics(); requestDraw();
  setStatus("Back to the full calculated range.");
}

function useVisibleRange() {
  if (!state.measurement || !state.simulation) { setFitProgress("Load a measurement and a calculated curve first.", "error"); return; }
  const lo = Math.max(state.view[0], state.measurement.angles[0], state.simulation.angles[0]);
  const hi = Math.min(state.view[1], state.measurement.angles.at(-1), state.simulation.angles.at(-1));
  if (hi <= lo || upperBound(state.measurement.angles, hi) - lowerBound(state.measurement.angles, lo) < 10) {
    setFitProgress("The visible range needs at least 10 measured points to fit.", "error");
    return;
  }
  $("fit_min").value = trimNumber(lo, 8);
  $("fit_max").value = trimNumber(hi, 8);
  markFitResultStale();
  renderResidualDiagnostics();
  setFitProgress(`Fit range: ${lo.toFixed(3)}–${hi.toFixed(3)}°`);
  requestDraw();
}

function observedPeakIn(lo, hi) {
  if (!state.measurement) return null;
  const found = visibleMaximum(state.measurement.angles, state.measurement.intensities, lo, hi);
  return found.index >= 0 ? state.measurement.angles[found.index] : null;
}

function braggAngle(a, hkl, wavelength, c = 0, system = "cubic") {
  const sine = wavelength / (2 * latticeD(a, hkl, c, system));
  if (!Number.isFinite(sine) || sine <= 0 || sine > 1) throw new Error("That reflection is not reachable at this wavelength and lattice constant.");
  return 2 * Math.asin(sine) * 180 / Math.PI;
}

async function alignObservedAsSto() {
  let config;
  try { config = readForm(); }
  catch (error) { setStatus(`Check the input: ${error.message}`, true); return; }
  const observed = observedPeakIn(config.scan.xmin, config.scan.xmax);
  if (observed === null) { setStatus("The measured peak to align with is outside the current calculation range.", true); return; }
  try {
    const p = config.parameters, entry = substrates.get(p.substrate_material), indices = parseHkl(p.hkl);
    if (reflectionAbsent(indices, entry?.centering || "P") || entry?.basis === "rutile" && rutileReflectionAbsent(indices)) throw new Error("The selected substrate reflection is systematically absent and cannot be used for alignment.");
    const expected = braggAngle(p.substrate_lattice_a, p.hkl, p.wavelength, p.substrate_lattice_c, entry?.system || "cubic");
    const offset = observed - expected;
    if (Math.abs(offset) > 5) throw new Error("The offset needed is beyond ±5°. Check the reflection and the wavelength.");
    $("angle_offset_deg").value = offset.toFixed(5);
    invalidateFringes(); invalidatePeaks();
    markCurveStale();
    markFitResultStale();
    if (await runSimulation()) setStatus(`Took the measured main peak at ${observed.toFixed(3)}° as the substrate ${config.parameters.hkl} and applied a zero offset of ${offset >= 0 ? "+" : ""}${offset.toFixed(3)}°. Check the reflection assignment yourself.`);
  } catch (error) { setStatus(`Cannot align: ${error.message}`, true); }
}

function downloadText(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], {type:mime}));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function ensureCurrentSimulation() {
  const config = readForm();
  if (!state.simulation || JSON.stringify(config) !== state.configSignature) return runSimulation();
  return true;
}

async function saveProject() {
  try {
    if (!await ensureCurrentSimulation()) return;
    const project = {format:"xrd-studio-project-v1",model_revision:modelRevision,parameters:state.config.parameters,scan:state.config.scan,measurement_name:state.measurementSource?.filename || state.measurement?.filename || "no measurement"};
    if (state.measurement) project.measurement = {two_theta_deg:state.measurement.angles,intensity_raw:state.measurement.intensities};
    project.intensity_settings = readIntensitySettings();
    if (state.measurementSource) project.measurement_source = {two_theta_deg:state.measurementSource.angles,intensity_raw:state.measurementSource.intensities};
    if (state.measurement) project.intensity_transform = state.measurement.intensity_transform;
    project.fit_settings = captureFitSettings();
    project.fringe_settings = captureFringeInputs();
    project.peak_settings = capturePeakInputs();
    if (state.fitResult && !state.fitResult.stale) project.fit_result = state.fitResult;
    downloadText("xrd_studio_project.json", JSON.stringify(project, null, 2), "application/json;charset=utf-8");
    setStatus("Saved the settings, the fit range and the raw measured data to a JSON file.");
  } catch (error) { setStatus(`Save error: ${error.message}`, true); }
}

async function loadProject(file) {
  if (!file) return;
  const importId=++state.importRequest;
  ++state.intensityRequest;
  try {
    const project = JSON.parse(await file.text());
    if(importId!==state.importRequest) return;
    if (project.format !== "xrd-studio-project-v1") throw new Error("That is not an XRD Studio settings file.");
    const config = validateConfig({parameters:project.parameters, scan:project.scan});
    let measurement = null;
    const source = project.measurement_source || project.measurement;
    if (project.intensity_settings && !project.measurement_source && project.intensity_settings.intensity_scale && project.intensity_settings.intensity_scale !== "linear") throw new Error("Log-axis settings require the original values before conversion.");
    if(source) measurement=validateCurve({...source,filename:project.measurement_name || "saved measurement"}, "Measurement", {allowSigned:true});
    applyIntensitySettings(project.intensity_settings === undefined ? {} : project.intensity_settings);
    applyConfig(config);
    if(measurement) { await ingestMeasurement(measurement, {adjustScan:false}); measurement=state.measurement; }
    else { state.measurementSource=null; clearAppliedIntensity(); invalidateFringes({clearInputs:true}); invalidatePeaks({clearInputs:true}); $("dataName").textContent="no measurement"; $("dataMeta").textContent="2θ (°), intensity · two-column file"; }
    if(importId!==state.importRequest) return;
    const savedLinear = project.measurement;
    const sameSavedMeasurement = !project.measurement_source || savedLinear && JSON.stringify(savedLinear.two_theta_deg)===JSON.stringify(measurement?.angles) && JSON.stringify(savedLinear.intensity_raw)===JSON.stringify(measurement?.intensities);
    applyFringeInputs(project.fringe_settings);
    applyPeakInputs(project.peak_settings);
    const migratedThicknessBounds = applyFitSettings(project.fit_settings);
    if (await runSimulation()) {
      if(importId!==state.importRequest) return;
      if (measurement && project.fit_result && (project.model_revision !== modelRevision || !sameSavedMeasurement)) {
        setFitProgress("The saved fit used a different calculation. Run the fit again.");
      }
      if (measurement && project.fit_result && project.model_revision === modelRevision && sameSavedMeasurement) {
        try {
          const saved = project.fit_result;
          const result = validateFitResponse(saved, config.scan);
          const range = Array.isArray(saved.range) && saved.range.length === 2 ? saved.range.map(Number) : null;
          const bounds = {};
          if (saved.bounds && typeof saved.bounds === "object") {
            for (const key of fitKeys) {
              const pair = saved.bounds[key];
              if (Array.isArray(pair) && pair.length === 2 && pair.every((value) => Number.isFinite(Number(value)))) bounds[key] = pair.map(Number);
            }
          }
          if (range && range.every(Number.isFinite) && JSON.stringify(result.config.parameters) === JSON.stringify(config.parameters)) {
            const sourcePoints = Number(saved.source_points);
            const thicknessBoundsNm = Array.isArray(saved.thickness_bounds_nm) && saved.thickness_bounds_nm.length === 2 && saved.thickness_bounds_nm.every((value) => Number.isFinite(Number(value))) ? saved.thickness_bounds_nm.map(Number) : null;
            const initialParameters = saved.initial_parameters && typeof saved.initial_parameters === "object" && Number.isFinite(Number(saved.initial_parameters.fwhm_deg)) ? saved.initial_parameters : null;
            showFitResult(result, {range, bounds, thickness_bounds_nm:thicknessBoundsNm, initial_parameters:initialParameters, adjusted:Array.isArray(saved.adjusted) ? saved.adjusted : [], sourcePoints:Number.isInteger(sourcePoints) && sourcePoints >= result.fit_points ? sourcePoints : result.fit_points});
            setFitProgress("Restored the saved fit result.", "success");
          }
        } catch { /* Old or malformed optional fit result does not block project loading. */ }
      }
      if(state.intensityPending) setStatus($("intensityStatus").textContent,true);
      else setStatus(`Opened the settings and measurement from ${file.name}.${migratedThicknessBounds ? " Older N bounds were converted to nm." : ""}`);
    }
  } catch (error) { if(importId!==state.importRequest) return; setStatus(`Open error: ${error.message}`, true); }
}

async function exportCsv() {
  try {
    if (!await ensureCurrentSimulation()) return;
    const sim = state.simulation, meas = state.measurement;
    const measuredMaximum = meas ? visibleMaximum(meas.angles, meas.intensities, sim.angles[0], sim.angles.at(-1)).maximum || 1 : 1;
    const meta=meas?.intensity_transform;
    const rows = ["two_theta_deg,simulation_relative,measurement_raw,measurement_relative,measurement_linear,intensity_scale,intensity_decades,negative_policy,intensity_shift,source_negative_count"];
    for (let i = 0; i < sim.angles.length; i++) {
      const x = sim.angles[i], raw = meas ? interpolate(meas.angles, meas.intensities, x) : null;
      const sourceRaw=state.measurementSource ? interpolate(state.measurementSource.angles,state.measurementSource.intensities,x) : raw;
      rows.push(`${x.toFixed(8)},${sim.intensities[i].toPrecision(10)},${sourceRaw === null ? "" : sourceRaw.toPrecision(10)},${raw === null ? "" : (raw / measuredMaximum).toPrecision(10)},${raw === null ? "" : raw.toPrecision(10)},${meta?.intensity_scale || ""},${meta?.intensity_decades ?? ""},${meta?.negative_policy || ""},${meta?.shift ?? ""},${meta?.negative_count ?? ""}`);
    }
    downloadText("xrd_simulation.csv", "\uFEFF" + rows.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
    setStatus("Exported simulation, original measured values, linear intensities and applied axis settings to CSV.");
  } catch (error) { setStatus(`CSV export error: ${error.message}`, true); }
}

function bindEvents() {
  $("applyIntensity").addEventListener("click", async () => { ++state.importRequest; if(await applyIntensity()) await runSimulation(); });
  for (const id of ["intensity_scale", "intensity_decades", "negative_policy"]) $(id).addEventListener("input", intensitySettingsChanged);
  $("settingsForm").addEventListener("submit", (event) => {event.preventDefault(); runSimulation();});
  for (const eventName of ["input", "change"]) $("settingsForm").addEventListener(eventName, (event) => {
    if (!event.target.matches("input, select")) return;
    markFitResultStale();
    if (modelInputIds.has(event.target.id)) markCurveStale();
    if (["wavelength", "angle_offset_deg", "hkl", "film_material", "substrate_material"].includes(event.target.id)) invalidatePeaks();
    if (["wavelength", "angle_offset_deg"].includes(event.target.id)) invalidateFringes();
    else renderFringeComparison();
    if (event.target.id === "fit_min" || event.target.id === "fit_max") renderResidualDiagnostics();
  });
  $("film_thickness_nm").addEventListener("input", updateThicknessConversion);
  for (const eventName of ["change", "blur"]) $("film_thickness_nm").addEventListener(eventName, () => { try { snapThicknessToModel(); } catch (error) { setStatus(error.message, true); } });
  for (const id of ["film_lattice_a", "film_lattice_c", "hkl"]) $(id).addEventListener("input", () => { refreshFilmControls(); refreshSubstrateNote(); syncThicknessForLatticeChange(); });
  $("film_material").addEventListener("change", onFilmChange);
  for (const id of ["film_system", "film_basis"]) $(id).addEventListener("change", () => { refreshFilmControls(); syncThicknessForLatticeChange(); });
  for (const id of ["fit_low_film_planes", "fit_high_film_planes", "fit_low_film_lattice_a", "fit_high_film_lattice_a", "fit_low_film_lattice_c", "fit_high_film_lattice_c"]) $(id).addEventListener("input", updateThicknessConversion);
  $("fitPeaks").addEventListener("click", analyzePeaks);
  $("peakUseVisible").addEventListener("click", useVisiblePeakRange);
  for (const id of ["peak_min", "peak_max", "peak_count", "peak_reference_center", "peak_reference_d"]) $(id).addEventListener("input", () => invalidatePeaks());
  $("estimateFringes").addEventListener("click", estimateFringes);
  $("fringeUseVisible").addEventListener("click", useVisibleFringeRange);
  for (const id of ["fringe_min", "fringe_max", "fringe_manual_peaks", "fringe_manual_orders"]) $(id).addEventListener("input", () => invalidateFringes());
  $("runFit").addEventListener("click", runFit);
  $("cancelFit").addEventListener("click", cancelFit);
  $("useVisibleRange").addEventListener("click", useVisibleRange);
  $("fit_evaluations").addEventListener("change", () => setFitProgress(`Search budget: up to ${Number($("fit_evaluations").value).toLocaleString("en")} model evaluations`));
  for (const key of fitKeys) $("fit_enable_" + key).addEventListener("change", refreshFitControls);
  for (const id of ["fit_min", "fit_max"]) $(id).addEventListener("input", requestDraw);
  $("openData").addEventListener("click", () => $("dataFile").click());
  $("dataFile").addEventListener("change", async (event) => {await openMeasurementFile(event.target.files?.[0]); event.target.value = "";});
  $("openSample").addEventListener("click", openSample);
  $("saveProject").addEventListener("click", saveProject);
  $("loadProject").addEventListener("click", () => $("projectFile").click());
  $("projectFile").addEventListener("change", async (event) => {await loadProject(event.target.files?.[0]); event.target.value = "";});
  $("exportCsv").addEventListener("click", exportCsv);
  $("alignPeak").addEventListener("click", alignObservedAsSto);
  $("resetZoom").addEventListener("click", resetZoom);
  $("logScale").addEventListener("click", () => {state.logScale = true; $("logScale").setAttribute("aria-pressed", "true"); $("linearScale").setAttribute("aria-pressed", "false"); requestDraw();});
  $("linearScale").addEventListener("click", () => {state.logScale = false; $("logScale").setAttribute("aria-pressed", "false"); $("linearScale").setAttribute("aria-pressed", "true"); requestDraw();});
  const wrap = $("plotWrap");
  wrap.addEventListener("pointerdown", (event) => {
    if (!state.plot || !state.simulation) return;
    const rect = wrap.getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top, p = state.plot;
    if (px < p.left || px > p.right || py < p.top || py > p.bottom) return;
    event.preventDefault(); wrap.setPointerCapture(event.pointerId);
    state.dragStart = px; state.dragEnd = px; state.hover = null; $("plotTooltip").hidden = true; drawOverlay();
  });
  wrap.addEventListener("pointermove", (event) => {
    if (!state.plot) return;
    if (state.dragStart !== null) {
      const rect = wrap.getBoundingClientRect();
      state.dragEnd = Math.max(state.plot.left, Math.min(state.plot.right, event.clientX - rect.left));
      drawOverlay();
    } else updateHover(event.clientX, event.clientY);
  });
  wrap.addEventListener("pointerup", (event) => {
    if (state.dragStart === null || !state.plot) return;
    const start = state.dragStart, end = state.dragEnd;
    state.dragStart = null; state.dragEnd = null;
    if (Math.abs(end - start) >= 8) {
      const lo = pixelX(Math.min(start, end)), hi = pixelX(Math.max(start, end));
      if (hi - lo >= (state.config?.scan.step || .001) * 3) {
        state.view = [lo, hi]; state.stats = null; updateMetrics(); requestDraw();
        setStatus(`Zoomed to 2θ ${lo.toFixed(3)}–${hi.toFixed(3)}°.`);
      }
    }
    if (wrap.hasPointerCapture(event.pointerId)) wrap.releasePointerCapture(event.pointerId);
    drawOverlay();
  });
  wrap.addEventListener("pointercancel", () => {state.dragStart = null; state.dragEnd = null; drawOverlay();});
  wrap.addEventListener("pointerleave", () => {if (state.dragStart === null) {state.hover = null; $("plotTooltip").hidden = true; drawOverlay();}});
  wrap.addEventListener("dblclick", (event) => {event.preventDefault(); resetZoom();});
  new ResizeObserver(requestDraw).observe(wrap);
  new ResizeObserver(requestDraw).observe($("residualPlotWrap"));
}

bindEvents();
$("substrate_material").addEventListener("change", onSubstrateChange);
$("hkl").addEventListener("change", () => {
  try { $("hkl").value = normaliseHkl($("hkl").value); } catch (error) { /* reported on submit */ }
  refreshSubstrateNote();
});
refreshFitControls();
updateThicknessConversion();
loadCatalogue().then(openSample);
