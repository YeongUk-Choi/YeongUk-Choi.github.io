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
  if (!cleaned) throw new Error("반사 (hkl)을 입력하세요. 예: 110");
  let parts;
  if (/^-?\d(\s|,|-)/.test(cleaned) || /[\s,]/.test(cleaned)) {
    parts = cleaned.split(/[\s,]+/).filter(Boolean);
  } else if (/^\d+$/.test(cleaned) && (cleaned.length === 3 || cleaned.length === 4)) {
    parts = cleaned.split("");
  } else {
    parts = cleaned.split(/[\s,]+/).filter(Boolean);
  }
  if (parts.length === 4) parts = [parts[0], parts[1], parts[3]];   // (hkil) -> (hkl)
  if (parts.length !== 3) throw new Error("반사는 지수 세 개입니다. 예: 110, 0 0 6, 1 -1 2");
  const values = parts.map(part => {
    if (!/^-?\d+$/.test(part)) throw new Error("반사 지수는 정수여야 합니다. 예: 110, 0 0 6");
    return Number(part);
  });
  if (values.every(value => value === 0)) throw new Error("반사 지수가 모두 0일 수는 없습니다.");
  if (values.some(value => Math.abs(value) > maxMillerIndex)) throw new Error(`반사 지수는 ±${maxMillerIndex} 안이어야 합니다.`);
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
  for (const node of document.querySelectorAll("#settingsForm input, #settingsForm select, #settingsForm button, .head-actions button")) node.disabled = busy;
  // the one control that has to stay alive while everything else is locked
  const cancel = $("cancelFit");
  if (cancel) { cancel.hidden = !busy; cancel.disabled = false; }
  if (!busy) refreshFitControls();
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
        const best = typeof status.best === "number" ? ` · 현재 최저 오차 ${status.best.toFixed(3)}` : "";
        detail = ` · ${status.evaluations.toLocaleString("ko-KR")}/${maxEvaluations.toLocaleString("ko-KR")}회 평가${best}`;
      }
    } catch (error) { /* the status call is a courtesy; never fail the fit over it */ }
    if (!state.fitWatch || state.fitWatch.job !== job) return;
    setFitProgress(`자동 피팅 계산 중… ${rangeText}${detail} · 경과 ${seconds}초 · 중단하려면 아래 버튼을 누르세요`);
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
  if (button) { button.disabled = true; button.textContent = "중단하는 중…"; }
  setFitProgress("피팅을 중단하는 중입니다…", "warning");
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
  $("fit-result-title").textContent = "이전 피팅 결과 · 재피팅 필요";
  renderFringeComparison();
}

function markCurveStale() {
  if (state.simulation) $("curveStale").hidden = false;
}

function explainModelError(error) {
  const message = String(error?.message || error);
  if (/no finite diffraction intensity/i.test(message)) {
    return "이 조건에서는 계산 강도가 0입니다. 선택한 반사가 기판의 격자 소광으로 사라졌거나(허용 반사로 바꾸세요) 박막·기판 반복 수가 모두 0인지 확인하세요.";
  }
  if (/Gaussian broadening needs .* integration steps|integration grid|120,000 integration steps/i.test(message)) {
    return "선택한 조건에서 계산 적분 격자가 120,000단계 한계를 넘었습니다. 2θ 계산 스캔 범위, 기판 유효 간섭 반복 수 또는 넓은 분해능 성분 폭 배수 m을 줄이세요. 피팅 범위를 좁힐 때는 계산 스캔 범위도 함께 조정하세요.";
  }
  if (/Resolution (?:halo )?convolution is too large/i.test(message)) {
    return "분해능 합성곱 계산량이 한계를 넘었습니다. FWHM, 유효 간섭 반복 수, 계산 지점 수 또는 넓은 성분의 폭 배수 m을 줄이세요.";
  }
  if (/Footprint broadening reaches zero incidence/i.test(message)) {
    return "분해능 적분 범위가 2θ=0°에 닿아 조사 길이 근사를 사용할 수 없습니다. FWHM이나 폭 배수 m을 줄이거나 조사 길이 보정을 끄세요.";
  }
  if (/Film domain\/taper (calculation|integration) is too large/i.test(message)) {
    return "두께 분포·테이퍼 계산량이 한계를 넘었습니다. 계산 스캔 범위를 좁히거나 두께 분포, 격자 구배 또는 유효 간섭 반복 수를 줄이세요.";
  }
  return message;
}

function numericField(id) {
  const value = $(id).value.trim();
  if (!value) throw new Error(`${labelFor(id)} 값을 입력하세요.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${labelFor(id)}에 유한한 숫자를 입력하세요.`);
  return number;
}

function labelFor(id) {
  if (id === "film_lattice_gradient_a") return filmGradientLabel();
  return ({wavelength:"파장",film_lattice_a:"박막 평균 격자상수 a",film_lattice_c:"박막 평균 격자상수 c",film_lattice_gradient_a:"박막 수직 격자 구배 Δa",film_interface_width:"박막 경계 테이퍼 폭 w",film_thickness_sigma:"박막 두께 분포 σN",film_intensity_scale:"박막 상대 강도 배율",substrate_lattice_a:"기판 격자상수",substrate_lattice_c:"기판 c축",film_planes:"Thickness",film_thickness_nm:"Thickness",substrate_planes:"기판 유효 간섭 반복 수",angle_offset_deg:"2θ 영점 보정",fwhm_deg:"기구 Gaussian FWHM",resolution_halo_fraction:"넓은 분해능 성분 비율 f",resolution_halo_width:"넓은 분해능 성분 폭 배수 m",background:"상대 배경",background_slope:"로그 배경 기울기",lp_mode:"편광·조사 길이 가정",xmin:"2θ 시작",xmax:"2θ 끝",step:"계산 간격"})[id] || id;
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
  return filmAxisMode(p) === "00l" ? "박막 수직 격자 구배 Δc" : "박막 수직 격자 구배 Δa";
}
function rutileReflectionAbsent(values) {
  const [h,k,l] = values;
  return (h === 0 && (k+l)%2 !== 0) || (k === 0 && (h+l)%2 !== 0);
}

function thicknessToPlanes(thicknessNm, a, hkl, c = 0, system = "cubic") {
  if (!Number.isFinite(thicknessNm) || thicknessNm < 0) throw new Error("Thickness는 0 nm 이상이어야 합니다.");
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(projectedRepeatNm(a, hkl, c, system))) throw new Error("Thickness 환산에는 유효한 격자상수와 반사면이 필요합니다.");
  const planes = Math.round(thicknessNm / projectedRepeatNm(a, hkl, c, system));
  if (planes > 20000) throw new Error("Thickness가 모델 최대 반복 단위 20,000개를 초과합니다.");
  return planes;
}

function updateThicknessConversion() {
  const {film_lattice_a:a, film_lattice_c:c, film_system:system, hkl} = filmFormGeometry(), thickness = Number($("film_thickness_nm").value);
  const node = $("filmThicknessQuantization"), boundNote = $("fitThicknessBoundNote");
  if (!(a > 0) || !Number.isFinite(projectedRepeatNm(a, hkl, c, system)) || !Number.isFinite(thickness) || thickness < 0) {
    node.textContent = "격자상수·반사면·Thickness를 입력하세요.";
    boundNote.textContent = "격자상수·반사면을 입력하면 N 환산 범위를 표시합니다.";
    return;
  }
  const repeat = projectedRepeatNm(a, hkl, c, system), planes = Math.round(thickness / repeat);
  state.lastFilmPlanes = planes;
  node.textContent = `모델 계산값 ${trimNumber(planes * repeat, 4)} nm · 환산 N = ${planes.toLocaleString("ko-KR")}`;
  const low = Number($("fit_low_film_planes").value), high = Number($("fit_high_film_planes").value);
  if (Number.isFinite(low) && Number.isFinite(high) && low < high) {
    const nLow = Math.ceil(low / repeat - 1e-7), nHigh = Math.floor(high / repeat + 1e-7);
    boundNote.textContent = `현재 격자·hkl 기준 N = ${nLow.toLocaleString("ko-KR")}–${nHigh.toLocaleString("ko-KR")} · 실제 두께 경계는 피팅 중에도 유지`;
  } else boundNote.textContent = "Thickness 경계를 입력하면 N 환산 범위를 표시합니다.";
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
  if (!input || typeof input !== "object" || !input.parameters || !input.scan) throw new Error("설정 형식이 올바르지 않습니다.");
  const source = input.parameters, scanSource = input.scan;
  const parameters = {hkl: String(source.hkl), film_material: String(source.film_material),
                      substrate_material: String(source.substrate_material ?? "SrTiO3"), lp_mode: String(source.lp_mode ?? "none")};
  parameters.film_system = source.film_system ?? filmMetadata(parameters.film_material).system;
  parameters.film_basis = source.film_basis ?? filmMetadata(parameters.film_material).basis;
  if (!["cubic", "tetragonal"].includes(parameters.film_system)) throw new Error("박막 결정계는 입방 또는 정방을 선택하세요. M1은 지원하지 않습니다.");
  if (!["perovskite", "rutile", "lattice"].includes(parameters.film_basis)) throw new Error("박막 구조 인자 모델을 목록에서 선택하세요.");
  if (parameters.film_basis !== "lattice" && parameters.film_basis !== filmMetadata(parameters.film_material).basis) throw new Error("선택한 재료와 구조 인자 모델이 맞지 않습니다.");
  const scan = {};
  parameters.hkl = normaliseHkl(parameters.hkl);
  if (!materials.has(parameters.film_material)) throw new Error("지원하지 않는 박막 재료입니다.");
  if (substrates.size && !substrates.has(parameters.substrate_material)) throw new Error("지원하지 않는 기판입니다.");
  if (!lpModes.has(parameters.lp_mode)) throw new Error("편광·조사 길이 가정을 목록에서 선택하세요.");
  for (const key of numericParameters) {
    const blankable = Object.prototype.hasOwnProperty.call(optionalModelDefaults, key);
    const value = blankable && (source[key] === undefined || source[key] === "") ? optionalModelDefaults[key] : source[key];
    if (value === "" || value === null || value === undefined) throw new Error(`${labelFor(key)} 값이 없습니다.`);
    if (key.startsWith("resolution_halo_") && (!["number", "string"].includes(typeof value) || typeof value === "string" && !value.trim())) throw new Error(`${labelFor(key)}에 유한한 숫자를 입력하세요.`);
    parameters[key] = Number(value);
    if (!Number.isFinite(parameters[key])) throw new Error(`${labelFor(key)}에 유한한 숫자를 입력하세요.`);
  }
  if (source.film_planes === "" || source.film_planes === null || source.film_planes === undefined) throw new Error("Thickness 환산 반복 단위 N 값이 없습니다.");
  parameters.film_planes = Number(source.film_planes);
  for (const key of numericScan) {
    if (scanSource[key] === "" || scanSource[key] === null || scanSource[key] === undefined) throw new Error(`${labelFor(key)} 값이 없습니다.`);
    scan[key] = Number(scanSource[key]);
    if (!Number.isFinite(scan[key])) throw new Error(`${labelFor(key)}에 유한한 숫자를 입력하세요.`);
  }
  if (parameters.film_lattice_c < 0) throw new Error("박막 c축은 0(=a와 동일) 이상이어야 합니다.");
  if (parameters.substrate_lattice_c < 0) throw new Error("기판 c축은 0(=a와 동일) 이상이어야 합니다.");
  for (const key of ["wavelength", "film_lattice_a", "substrate_lattice_a"]) {
    if (parameters[key] <= 0) throw new Error(`${labelFor(key)}는 0보다 커야 합니다.`);
  }
  if (Math.abs(parameters.film_lattice_gradient_a) > 0.2) throw new Error("박막 수직 격자 구배는 −0.20~+0.20 Å 안에 있어야 합니다.");
  if (filmActiveMean(parameters) - Math.abs(parameters.film_lattice_gradient_a) / 2 <= 0) throw new Error("박막 평균 격자와 구배를 조정해 계면·표면의 격자 간격이 모두 양수가 되게 하세요.");
  for (const key of ["film_planes", "substrate_planes"]) {
    const maximum = key === "substrate_planes" ? substrateFitMax : 20000;
    if (!Number.isInteger(parameters[key]) || parameters[key] < 0 || parameters[key] > maximum) throw new Error(`${labelFor(key)}는 0~${maximum.toLocaleString("ko-KR")}의 정수여야 합니다.`);
  }
  if (parameters.film_lattice_gradient_a !== 0 && parameters.film_planes < 2) throw new Error("박막 수직 격자 구배를 적용하려면 박막 반복 단위 N이 2 이상이어야 합니다.");
  if (parameters.film_planes === 0 && parameters.substrate_planes === 0) throw new Error("박막 또는 기판 반복 수 중 하나는 0보다 커야 합니다.");
  if (parameters.film_intensity_scale < 0 || parameters.film_intensity_scale > 100) throw new Error("박막 상대 강도 배율은 0~100으로 입력하세요.");
  if (parameters.fwhm_deg < 0) throw new Error("기구 폭은 0 이상이어야 합니다.");
  if (parameters.resolution_halo_fraction < 0 || parameters.resolution_halo_fraction > 0.2) throw new Error("넓은 분해능 성분 비율 f는 0~0.2로 입력하세요.");
  if (parameters.resolution_halo_width < 1 || parameters.resolution_halo_width > 20) throw new Error("넓은 분해능 성분 폭 배수 m은 1~20으로 입력하세요.");
  if (parameters.background < 0 || parameters.background >= 1) throw new Error("상대 배경은 0 이상 1 미만이어야 합니다.");
  if (parameters.film_interface_width < 0 || parameters.film_interface_width > 1000) throw new Error("박막 경계 테이퍼 폭 w는 0~1,000 반복 단위로 입력하세요.");
  if (parameters.film_thickness_sigma < 0 || parameters.film_thickness_sigma > 20) throw new Error("박막 두께 분포 σN은 0~20 반복 단위로 입력하세요.");
  if (Math.abs(parameters.background_slope) > 1) throw new Error("로그 배경 기울기는 −1~+1 log₁₀/° 안에 있어야 합니다.");
  if (!(0 < scan.xmin && scan.xmin < scan.xmax && scan.xmax < 180)) throw new Error("2θ 시작과 끝은 0°와 180° 사이에서 순서대로 입력하세요.");
  if (scan.step < 0.001 || scan.step > 1) throw new Error("계산 간격은 0.001°~1°로 입력하세요.");
  let count = Math.floor((scan.xmax - scan.xmin) / scan.step + 1e-9) + 1;
  const last = scan.xmin + (count - 1) * scan.step;
  if (scan.xmax - last > Math.max(1e-9, scan.step * 1e-7)) count++;
  if (count < 3 || count > 20001) throw new Error("계산 지점은 3~20,001개여야 합니다. 범위나 간격을 조정하세요.");
  if (scan.xmin - parameters.angle_offset_deg <= 0 || scan.xmax - parameters.angle_offset_deg >= 180) throw new Error("영점 보정으로 계산 각도가 물리적 0–180° 범위를 벗어납니다.");
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

const systemNames = {cubic: "입방", tetragonal: "정방", hexagonal: "육방"};

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
    ? "Δc = 표면 c − 계면 c입니다. 00l에서는 c만 수직 간격을 정하며 a는 결정할 수 없습니다. Thickness는 평균 c로 환산합니다."
    : mode === "mixed" ? "Δa = 표면 a − 계면 a입니다. 혼합 반사에서는 a와 c가 같은 비율로 변하는 법선 간격 구배를 가정합니다. 단일 반사로 a와 c를 독립적으로 결정할 수 없어 기본값은 c 고정입니다."
    : "Δa = 표면 a − 계면 a입니다. 반사면 법선 간격의 선형 변화를 가정합니다. Thickness는 평균 격자와 hkl로 환산합니다.";
  let note = p.film_basis === "rutile"
    ? "루틸 원자 구조 인자 모델입니다. 격자와 산소 좌표는 기준 프리셋이며 시료의 구조 정련값이 아닙니다. VO₂는 R상 가정이며 M1은 지원하지 않습니다. 단일 반사 피팅만으로 M1/R을 구별할 수 없습니다."
    : p.film_basis === "lattice" ? "유효 산란체 격자 모델입니다. 상대 강도는 원자 구조를 완전히 반영하지 않습니다."
    : "ABO₃ 원자 구조 인자 모델입니다. 입력 격자와 반사 배정을 확인하세요.";
  try { if (p.film_basis === "rutile" && rutileReflectionAbsent(parseHkl(p.hkl))) note = "선택한 반사는 루틸의 계통 소멸 조건입니다. 정확한 Bragg 위치의 반사는 사라지지만 유한 박막의 주변 산란은 남을 수 있습니다. " + note; } catch (error) {}
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
  if (!entry) return "기판";
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
  parts.push(entry.basis === "rutile" ? "루틸 원자 구조 인자로 계산합니다. 기준 격자와 산소 좌표는 시료의 구조 정련값이 아닙니다." : entry.modelled
    ? "ABO₃ 구조 인자로 계산합니다 — 피크 위치와 상대 강도 모두 모델값입니다."
    : "격자만 쓰는 근사입니다 — 피크 위치와 간섭 무늬 간격은 맞지만 기판 피크의 상대 높이는 근사값입니다(유효 간섭 반복 수로 흡수됩니다).");
  if (entry.system === "hexagonal") parts.push("육방 지수는 (h k l) 세 자리로 입력하세요. 예: 사파이어 (0006) → 006");
  let warning = "";
  try {
    if (reflectionAbsent(parseHkl($("hkl").value), entry.centering || "P") || entry.basis === "rutile" && rutileReflectionAbsent(parseHkl($("hkl").value))) {
      warning = `<b class="sw-absent">이 반사는 ${entry.label}의 격자 소광으로 나타나지 않습니다.</b> 해당 Bragg 표시는 생략합니다 — 허용 반사(예: ${entry.suggest})로 바꾸세요.`;
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
  $("fringeStatus").textContent = "아직 추정하지 않았습니다. 반복 무늬가 보이는 측정 구간을 지정하세요.";
  $("fringeStatus").classList.remove("error");
  $("fringeResult").hidden = true;
  $("fringeWarning").hidden = true;
}
function useVisibleFringeRange() {
  if (!state.measurement) { $("fringeStatus").textContent = "먼저 측정 데이터를 불러오세요."; return; }
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
  $("fringeModelLabel").textContent = fitted ? "피팅 결과의 두께" : "현재 모델 두께 (환산값)";
  $("fringeModelThickness").textContent = Number.isFinite(model) ? `${trimNumber(model, 3)} nm` : "—";
  const difference = Number.isFinite(model) ? Math.abs(model / t - 1) : null;
  $("fringeDifference").textContent = difference === null ? "—" : `${trimNumber(difference * 100, 2)}%`;
  $("fringeWarning").hidden = difference === null || difference <= 0.05;
  if (difference > 0.05) $("fringeWarning").textContent = "두 두께가 5% 넘게 다릅니다. 프린지 선택·차수 배정·피팅 모델을 확인하세요. 이 차이는 통계적 신뢰 구간이 아닙니다.";
}
async function estimateFringes() {
  let body;
  try {
    if (!state.measurement) throw new Error("먼저 측정 데이터를 불러오세요.");
    const low = fitNumber("fringe_min", "프린지 구간 시작"), high = fitNumber("fringe_max", "프린지 구간 끝");
    if (!(low > 0 && low < high && high < 180)) throw new Error("프린지 구간은 0–180° 안에서 시작보다 끝이 커야 합니다.");
    if (low < state.measurement.angles[0] || high > state.measurement.angles.at(-1)) throw new Error("프린지 구간을 측정 데이터의 각도 범위 안에 지정하세요.");
    const wavelength = numericField("wavelength"), offset = numericField("angle_offset_deg");
    if (!(wavelength > 0) || low - offset <= 0 || high - offset >= 180) throw new Error("프린지 평가의 파장과 영점 보정을 확인하세요.");
    body = {measurement:state.measurement, wavelength, angle_offset_deg:offset, roi:[low, high]};
    const manual = $("fringe_manual_peaks").value.trim();
    if (manual) {
      const peaks = manual.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (peaks.length < 4 || peaks.some((value, index) => !Number.isFinite(value) || value < low || value > high || index > 0 && value <= peaks[index-1])) throw new Error("수동 프린지는 구간 안의 최대점 각도를 작은 순서로 4개 이상 입력하세요.");
      body.manual_peaks = peaks;
    }
    const manualOrders = $("fringe_manual_orders").value.trim();
    if (manualOrders) {
      const orders = manualOrders.split(/[\s,;]+/).filter(Boolean).map(Number);
      if (!body.manual_peaks || orders.length !== body.manual_peaks.length || orders.some((value, index) => !Number.isSafeInteger(value) || Math.abs(value) > 10000 || index > 0 && value <= orders[index-1])) throw new Error("수동 차수는 최대점마다 하나씩, −10,000~10,000 안의 증가하는 정수로 입력하세요. 차수를 건너뛸 수 있습니다.");
      body.manual_orders = orders;
    }
  } catch (error) { $("fringeStatus").textContent = error.message; $("fringeStatus").classList.add("error"); return; }
  invalidateFringes();
  const request = state.fringeRequest;
  $("estimateFringes").disabled = true;
  $("fringeStatus").textContent = "측정 프린지의 q 간격을 평가하는 중입니다…";
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
      $("fringeQuality").textContent = `최대점 ${result.peak_angles.length}개 · 차수당 q 간격 ${result.q_slope.toPrecision(5)} Å⁻¹ · 간격 상대 산포 ${trimNumber(result.relative_scatter * 100, 2)}%`;
      const detail=$("fringePeaks"), table=document.createElement("table");detail.replaceChildren();table.className="peak-table";
      const header=document.createElement("tr");
      for(const label of ["차수","측정 2θ (°)","회귀 2θ (°)","각도 잔차 (°)"]){const th=document.createElement("th");th.textContent=label;header.append(th);}table.append(header);
      for(const [i,value] of result.peak_angles.entries()) {
        const row=document.createElement("tr");
        for(const text of [`n=${result.orders[i]}`,value.toFixed(6),result.predicted_peak_angles[i].toFixed(6),result.angular_residuals_deg[i].toFixed(6)]){const td=document.createElement("td");td.textContent=text;row.append(td);}table.append(row);
      }detail.append(table);
      $("fringeResult").hidden = false;
    }
    if (!valid) {
      $("fringeThickness").textContent = "추정 불가";
      $("fringeModelThickness").textContent = "—";
      $("fringeDifference").textContent = "—";
      $("fringeStatus").textContent = result?.status === "irregular" ? "추정 불가: 간격 품질 조건을 통과하지 못했습니다. 배정한 차수의 회귀 잔차를 보고 구간·최대점·차수를 검토하세요." : "추정 불가: 신뢰할 수 있는 프린지가 충분하지 않습니다. 반복 무늬가 보이는 구간이나 수동 최대점·차수를 지정하세요.";
      return;
    }
    state.fringe = result;
    $("fringeStatus").textContent = "선택한 최대점과 차수 배정에 따른 두께입니다. 규칙적인 간격이나 작은 잔차만으로 배정이 증명되지는 않습니다.";
    $("fringeThickness").textContent = `${trimNumber(result.thickness_nm, 3)} nm`;
    renderFringeComparison();
  } catch (error) {
    if (request === state.fringeRequest) { $("fringeStatus").textContent = "프린지 평가를 완료하지 못했습니다. 측정 데이터, 파장, 영점 보정과 선택 구간을 확인하세요."; $("fringeStatus").classList.add("error"); }
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
  $("peakStatus").textContent = "아직 분석하지 않았습니다. 피크가 포함된 측정 구간을 지정하세요.";
}
function useVisiblePeakRange() {
  if (!state.measurement) { $("peakStatus").textContent = "먼저 측정 데이터를 불러오세요."; return; }
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
    if (!state.measurement) throw new Error("먼저 측정 데이터를 불러오세요.");
    const lo=fitNumber("peak_min", "피크 분석 구간 시작"), hi=fitNumber("peak_max", "피크 분석 구간 끝");
    if (!(state.measurement.angles[0]<=lo && lo<hi && hi<=state.measurement.angles.at(-1))) throw new Error("피크 분석 구간을 측정 범위 안에서 증가하는 각도로 지정하세요.");
    const wavelength=numericField("wavelength"), angle_offset_deg=numericField("angle_offset_deg");
    if (!(wavelength>0) || lo-angle_offset_deg<=0 || hi-angle_offset_deg>=180) throw new Error("피크 분석의 파장과 영점 보정을 확인하세요.");
    body={measurement:state.measurement,wavelength,angle_offset_deg,roi:[lo,hi],hkl:normaliseHkl($("hkl").value),peak_count:Number($("peak_count").value),max_evaluations:2000};
    if ($("peak_reference_center").value.trim() || $("peak_reference_d").value.trim()) {
      const center_deg=fitNumber("peak_reference_center","기준 피크 중심"), d_angstrom=fitNumber("peak_reference_d","기준 d");
      if (!(center_deg-angle_offset_deg>0 && center_deg-angle_offset_deg<180 && d_angstrom>0)) throw new Error("기준 피크 각도와 양의 기준 d를 함께 확인하세요.");
      body.reference={center_deg,d_angstrom};
    }
  } catch(error) { $("peakStatus").textContent=error.message;$("peakStatus").classList.add("error");return; }
  invalidatePeaks();const request=state.peakRequest;$("fitPeaks").disabled=true;
  $("peakStatus").textContent="선택 구간의 피크 모양을 분해하는 중입니다…";
  try {
    const results=[];
    for(const loss of ["soft_log","linear"]) {
      const result=await getJson("/api/peaks",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,loss})});
      if(request!==state.peakRequest)return;
      if(!result || !Array.isArray(result.components) || result.components.length!==body.peak_count || !result.components.every(c=>[c.center_deg,c.fwhm_deg,c.area,c.area_fraction,c.roi_area_fraction,c.eta,c.d_angstrom].every(Number.isFinite)) || !Array.isArray(result.angles) || result.angles.length<3 || !Array.isArray(result.measured) || !Array.isArray(result.predicted) || result.measured.length!==result.angles.length || result.predicted.length!==result.angles.length || ![...result.angles,...result.measured,...result.predicted,result.soft_log_rmse,result.log_rmse,result.fit_rmse,result.evaluations].every(Number.isFinite)) throw new Error("Invalid peak analysis response");
      results.push(result);
      if(loss==="soft_log")$("peakStatus").textContent="같은 구간을 선형 오차로 분석해 방법 차이를 비교하는 중입니다…";
    }
    const [soft,linear]=results;state.peakAnalysis={soft_log:soft,linear};
    const tbody=$("peakComponents"), comparison=$("peakComparison");tbody.replaceChildren();comparison.replaceChildren();
    $("peakReferenceDHeader").hidden=!body.reference;$("peakReferenceCHeader").hidden=!body.reference;
    const appendRow=(target,values)=>{const row=document.createElement("tr");for(const value of values){const cell=document.createElement("td");cell.textContent=String(value);row.append(cell);}target.append(row);};
    const methodDifferences=[];
    for(let i=0;i<body.peak_count;i++) {
      const a=soft.components[i],b=linear.components[i],difference=Math.abs(a.center_deg-b.center_deg);methodDifferences.push(difference);
      const weak=Math.min(a.area_fraction,b.area_fraction)<.15;
      appendRow(comparison,[i+1,a.center_deg.toFixed(5),b.center_deg.toFixed(5),difference.toFixed(5),Number.isFinite(a.c_00l_angstrom)?a.c_00l_angstrom.toFixed(5):"—",Number.isFinite(b.c_00l_angstrom)?b.c_00l_angstrom.toFixed(5):"—",`${trimNumber(a.area_fraction*100,2)}%`,`${trimNumber(b.area_fraction*100,2)}%`,weak?"약하게 결정된 성분 (가정한 프로파일)":"프로파일 성분"]);
    }
    for(const [method,result] of [["soft-log",soft],["linear",linear]])for(const [i,c] of result.components.entries()) {
      const values=[method,i+1,c.center_deg.toFixed(5),c.d_angstrom.toFixed(5),Number.isFinite(c.c_00l_angstrom)?c.c_00l_angstrom.toFixed(5):"—",c.fwhm_deg.toFixed(5),c.area.toPrecision(5),`${trimNumber(c.area_fraction*100,2)}%`,`${trimNumber(c.roi_area_fraction*100,2)}%`,trimNumber(c.eta,3)];
      if(body.reference)values.push(Number.isFinite(c.d_reference_angstrom)?c.d_reference_angstrom.toFixed(5):"—",Number.isFinite(c.c_00l_reference_angstrom)?c.c_00l_reference_angstrom.toFixed(5):"—");
      appendRow(tbody,values);
    }
    $("peakMetrics").textContent=`soft-log 목적함수 RMSE ${soft.fit_rmse.toFixed(4)} · 선형 목적함수 RMSE ${linear.fit_rmse.toFixed(4)} · ${soft.evaluations.toLocaleString("ko-KR")} + ${linear.evaluations.toLocaleString("ko-KR")}회 평가 (서로 다른 오차 정의)`;
    const warning=[];
    if(methodDifferences.some(value=>value>.02))warning.push("방법 간 중심 차이가 0.02°를 넘습니다. 피크 위치가 목적함수 선택에 민감합니다.");
    if(results.some(result=>result.boundary_hits?.length))warning.push("일부 값이 탐색 경계에 닿았습니다. 구간·초기값에 따른 변화를 확인하세요.");
    if(results.some(result=>result.multistart?.materially_different))warning.push("비슷한 오차를 가진 다른 성분 분해가 있습니다. 이 배정은 유일하지 않습니다.");
    if(results.some(result=>result.components.some(c=>c.area_fraction<.15)))warning.push("작은 성분은 약하게 결정된 프로파일 특징입니다. 프린지 중첩이나 다른 분해 가능성을 함께 검토하세요.");
    if(results.some(result=>result.components.some(c=>c.roi_area<.8*c.area)))warning.push("성분 면적의 20% 넘게 선택 구간 밖으로 외삽됩니다. 전체 면적 비율과 구간 면적 비율을 함께 확인하세요.");
    $("peakWarnings").textContent=warning.join(" ");$("peakWarnings").hidden=!warning.length;
    $("peakStatus").textContent="피크 모양 분해 결과입니다. 성분의 공간 배치·층 구조·상 배정은 이 결과로 결정되지 않습니다.";
    $("peakResult").hidden=false;drawPeakAnalysis(soft,linear);
  } catch(error) {
    if(request===state.peakRequest){$("peakStatus").textContent="피크 분석을 완료하지 못했습니다. 측정 데이터와 선택 구간, 파장·영점 보정을 확인하세요.";$("peakStatus").classList.add("error");}
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
  if (!raw) throw new Error(`${description} 값을 입력하세요.`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${description}에 유한한 숫자를 입력하세요.`);
  return value;
}

function validateFitBounds(key, low, high, scan) {
  const name = labelFor(key);
  if (!(low < high)) throw new Error(`${name} 하한은 상한보다 작아야 합니다.`);
  if (key === "substrate_planes" && (!Number.isInteger(low) || !Number.isInteger(high) || low < 1 || high > substrateFitMax)) throw new Error(`${name} 경계는 1~${substrateFitMax.toLocaleString("ko-KR")}의 정수로 입력하세요.`);
  if (key === "film_planes" && low <= 0) throw new Error("Thickness 경계는 0 nm 초과로 입력하세요.");
  if (["film_lattice_a", "film_lattice_c"].includes(key) && (low <= 0 || high > 20)) throw new Error("박막 격자상수 경계는 0 초과 20 Å 이하로 입력하세요.");
  if (key === "film_lattice_gradient_a" && (low < -0.2 || high > 0.2)) throw new Error("박막 수직 격자 구배 경계는 −0.20~+0.20 Å 안에 있어야 합니다.");
  if (key === "angle_offset_deg" && (low < -5 || high > 5 || scan.xmin - high <= 0 || scan.xmax - low >= 180)) throw new Error("영점 보정 경계는 ±5° 이내이며 계산 각도가 0–180°를 벗어나지 않아야 합니다.");
  if (key === "film_intensity_scale" && (low < 0 || high > 100)) throw new Error("박막 상대 강도 배율 경계는 0~100으로 입력하세요.");
  if (key === "fwhm_deg" && (low < 0 || high > 2)) throw new Error("기구 폭 경계는 0~2°로 입력하세요.");
  if (key === "resolution_halo_fraction" && (low < 0 || high > 0.2)) throw new Error("넓은 분해능 성분 비율 f 경계는 0~0.2로 입력하세요.");
  if (key === "resolution_halo_width" && (low < 1 || high > 20)) throw new Error("넓은 분해능 성분 폭 배수 m 경계는 1~20으로 입력하세요.");
  if (key === "background" && (low < 0 || high >= 1)) throw new Error("상대 배경 경계는 0 이상 1 미만이어야 합니다.");
  if (key === "film_interface_width" && (low < 0 || high > 1000)) throw new Error("박막 경계 테이퍼 폭 w 경계는 0~1,000 반복 단위로 입력하세요.");
  if (key === "film_thickness_sigma" && (low < 0 || high > 20)) throw new Error("박막 두께 분포 σN 경계는 0~20 반복 단위로 입력하세요.");
  if (key === "background_slope" && (low < -1 || high > 1)) throw new Error("로그 배경 기울기 경계는 −1~+1 log₁₀/° 안에 있어야 합니다.");
}

function readFitSettings(config) {
  if (!state.measurement) throw new Error("먼저 측정 데이터를 불러오세요.");
  const low = fitNumber("fit_min", "피팅 시작 각도"), high = fitNumber("fit_max", "피팅 끝 각도");
  if (!(0 < low && low < high && high < 180)) throw new Error("피팅 범위는 0–180° 안에서 시작보다 끝이 커야 합니다.");
  const measurements = state.measurement.angles;
  const allowedLow = Math.max(measurements[0], config.scan.xmin);
  const allowedHigh = Math.min(measurements.at(-1), config.scan.xmax);
  if (low < allowedLow - 1e-8 || high > allowedHigh + 1e-8) throw new Error(`피팅 범위는 측정·계산이 겹치는 ${allowedLow.toFixed(3)}–${allowedHigh.toFixed(3)}° 안에 있어야 합니다.`);
  const fitPoints = upperBound(measurements, high) - lowerBound(measurements, low);
  if (fitPoints < 10) throw new Error("피팅 범위에 측정점이 10개 이상 필요합니다.");
  const bounds = {};
  let thicknessBoundsNm = null;
  for (const key of fitKeys) {
    if (!$("fit_enable_" + key).checked) continue;
    const lower = fitNumber("fit_low_" + key, `${labelFor(key)} 하한`);
    const upper = fitNumber("fit_high_" + key, `${labelFor(key)} 상한`);
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
    if (!(nLow < nHigh)) throw new Error("Thickness 경계에 들어오는 반복 단위가 2개 이상 필요합니다. 두께 경계를 넓히세요.");
    bounds.film_planes = [nLow, nHigh];
  }
  if (!Object.keys(bounds).length) throw new Error("피팅할 변수를 하나 이상 선택하세요.");
  const maxEvaluations = Number($("fit_evaluations").value);
  if (!fitBudgetOptions.has(maxEvaluations)) throw new Error("탐색 예산을 다시 선택하세요.");
  return {range:[low, high], bounds, ...(thicknessBoundsNm ? {thickness_bounds_nm:thicknessBoundsNm} : {}), max_evaluations:maxEvaluations, scan:{...config.scan}};
}

function projectFitStart(config, fit) {
  const parameters = {...config.parameters}, adjusted = [];
  for (const [key, [low, high]] of Object.entries(fit.bounds)) {
    const original = key === "film_lattice_c" ? parameters[key] || parameters.film_lattice_a : parameters[key];
    parameters[key] = Math.max(low, Math.min(high, original));
    if (parameters[key] !== original) adjusted.push(`${key === "film_planes" ? "Thickness 환산 N" : labelFor(key)} ${trimNumber(original, 5)}→${trimNumber(parameters[key], 5)}`);
  }
  return {parameters, adjusted};
}

function validateCurve(raw, filename = "측정 데이터") {
  if (!raw || typeof raw !== "object") throw new Error("곡선 데이터를 읽을 수 없습니다.");
  const angles = raw.angles || raw.two_theta_deg;
  const intensities = raw.intensities || raw.intensity_raw;
  if (!Array.isArray(angles) || !Array.isArray(intensities) || angles.length < 2 || angles.length !== intensities.length) throw new Error("각도와 강도는 길이가 같은 2개 이상의 배열이어야 합니다.");
  if (angles.length > 1000000) throw new Error("데이터가 너무 큽니다. 최대 1,000,000점까지 읽을 수 있습니다.");
  let previous = -Infinity, positive = false;
  for (let i = 0; i < angles.length; i++) {
    const x = Number(angles[i]), y = Number(intensities[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || x >= 180 || x <= previous || y < 0) throw new Error("측정 데이터에는 0–180° 범위에서 증가하는 각도와 음수가 아닌 유한한 강도가 필요합니다.");
    angles[i] = x; intensities[i] = y; previous = x;
    if (y > 0) positive = true;
  }
  if (!positive) throw new Error("측정 데이터에 양의 강도가 없습니다.");
  return {angles, intensities, filename: String(raw.filename || filename)};
}

function setMeasurement(raw, {adjustScan = true} = {}) {
  const measurement = validateCurve(raw);
  state.measurement = measurement;
  invalidatePeaks({clearInputs:true});
  invalidateFringes({clearInputs:true});
  hideFitResult({clearResidual:true});
  setFitProgress(`피팅 대기 중 · 최대 ${Number($("fit_evaluations").value).toLocaleString("ko-KR")}회 모델 평가`);
  const {angles, intensities, filename} = measurement;
  let peak = 0;
  for (let i = 1; i < intensities.length; i++) if (intensities[i] > intensities[peak]) peak = i;
  $("dataName").textContent = filename;
  $("dataMeta").textContent = `${angles.length.toLocaleString("ko-KR")}점 · ${formatAngle(angles[0], 2)}–${formatAngle(angles.at(-1), 2)}° · 주 피크 ${formatAngle(angles[peak], 3)}°`;
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
  requestDraw();
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
  catch { throw new Error(`서버 응답을 읽을 수 없습니다. (HTTP ${response.status})`); }
  if (!response.ok) throw new Error(result.error || `요청이 실패했습니다. (HTTP ${response.status})`);
  return result;
}

async function openSample() {
  try {
    setStatus("SRO/STO 예시 데이터를 불러오는 중입니다.");
    const raw = await getJson("/api/sample");
    setMeasurement(raw);
    if (await runSimulation()) setStatus(`${state.measurement.filename}을(를) 열었습니다. 반사면·파장 가정을 확인한 뒤 자동 피팅을 실행하세요.`);
  } catch (error) {
    if (!state.simulation) await runSimulation();
    setStatus(`예시 데이터 오류: ${error.message}`, true);
  }
}

async function openMeasurementFile(file) {
  if (!file) return;
  try {
    setStatus(`${file.name}을(를) 읽는 중입니다.`);
    const body = await file.arrayBuffer();
    const raw = await getJson("/api/parse", {method:"POST",headers:{"Content-Type":"application/octet-stream","X-Filename":encodeURIComponent(file.name)},body});
    setMeasurement({...raw, filename:file.name});
    if (await runSimulation()) setStatus(`${file.name} · 원본 ${state.measurement.angles.length.toLocaleString("ko-KR")}점을 불러왔습니다.`);
  } catch (error) { setStatus(`측정 파일 오류: ${error.message}`, true); }
}

function validateSimulation(raw) {
  if (!raw || !Array.isArray(raw.angles) || !Array.isArray(raw.intensities) || raw.angles.length < 2 || raw.angles.length !== raw.intensities.length) throw new Error("계산 결과의 각도와 강도 배열이 올바르지 않습니다.");
  const angles = raw.angles, intensities = raw.intensities;
  let previous = -Infinity, positive = false;
  for (let i = 0; i < angles.length; i++) {
    const x = Number(angles[i]), y = Number(intensities[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= previous || y < 0) throw new Error("계산 결과에 유효하지 않은 값이 있습니다.");
    angles[i] = x; intensities[i] = y; previous = x;
    if (y > 0) positive = true;
  }
  if (!positive) throw new Error("계산 결과에 양의 강도가 없습니다.");
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
  $("scanBadge").textContent = `${simulation.angles.length.toLocaleString("ko-KR")}점 · ${config.parameters.hkl} · λ ${config.parameters.wavelength} Å`;
  updateMetrics();
  renderResidualDiagnostics();
  requestDraw();
}

async function runSimulation() {
  if (state.fitBusy) return false;
  let config;
  try { config = readForm(); }
  catch (error) { setStatus(`입력 확인: ${error.message}`, true); return false; }
  const id = ++state.requestId;
  const button = $("runSimulation");
  button.disabled = true;
  setStatus("시뮬레이션 계산 중입니다…");
  try {
    const raw = await getJson("/api/simulate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(config)});
    if (id !== state.requestId) return false;
    const simulation = validateSimulation(raw);
    const hadFitResult = Boolean(state.fitResult);
    installSimulation(config, simulation);
    hideFitResult();
    if (hadFitResult) setFitProgress("수동 계산을 적용했습니다. 새 자동 피팅을 실행할 수 있습니다.");
    setStatus(`${state.simulation.angles.length.toLocaleString("ko-KR")}점 계산 완료 · 반사 ${config.parameters.hkl} · 파장 ${config.parameters.wavelength} Å`);
    return true;
  } catch (error) {
    if (id === state.requestId) setStatus(`계산 오류: ${explainModelError(error)}`, true);
    return false;
  } finally { if (id === state.requestId) button.disabled = state.fitBusy; }
}

function validateFitResponse(raw, scan) {
  if (!raw || typeof raw !== "object" || !raw.parameters || typeof raw.parameters !== "object") throw new Error("피팅 결과 형식이 올바르지 않습니다.");
  const config = validateConfig({parameters:raw.parameters, scan});
  const numeric = ["best_log_rmse", "thickness_nm", "evaluations", "fit_points"];
  for (const key of numeric) if (raw[key] === null || raw[key] === undefined || raw[key] === "" || !Number.isFinite(Number(raw[key]))) throw new Error(`피팅 결과 ${key} 값이 올바르지 않습니다.`);
  const initial = raw.initial_log_rmse === null ? null : Number(raw.initial_log_rmse), best = Number(raw.best_log_rmse), thickness = Number(raw.thickness_nm);
  if (raw.initial_log_rmse !== null && (raw.initial_log_rmse === undefined || raw.initial_log_rmse === "" || !Number.isFinite(initial))) throw new Error("피팅 결과의 초기 오차가 올바르지 않습니다.");
  const evaluations = Number(raw.evaluations), fitPoints = Number(raw.fit_points);
  if ((initial !== null && initial < 0) || best < 0 || thickness < 0 || !Number.isInteger(evaluations) || evaluations < 0 || !Number.isInteger(fitPoints) || fitPoints < 1) throw new Error("피팅 결과의 오차, 두께 또는 계산 횟수가 올바르지 않습니다.");
  let initialMerit = null, bestMerit = null;
  if (raw.best_fit_merit !== null && raw.best_fit_merit !== undefined) {
    bestMerit = Number(raw.best_fit_merit);
    if (!Number.isFinite(bestMerit) || bestMerit < 0) throw new Error("피팅 결과의 피크 가중 오차가 올바르지 않습니다.");
  }
  if (raw.initial_fit_merit !== null && raw.initial_fit_merit !== undefined) {
    initialMerit = Number(raw.initial_fit_merit);
    if (!Number.isFinite(initialMerit) || initialMerit < 0) throw new Error("피팅 결과의 초기 피크 가중 오차가 올바르지 않습니다.");
  }
  const measuredPeakFwhm = raw.measured_peak_fwhm_deg == null ? null : Number(raw.measured_peak_fwhm_deg);
  const fittedPeakFwhm = raw.fitted_peak_fwhm_deg == null ? null : Number(raw.fitted_peak_fwhm_deg);
  if ((measuredPeakFwhm !== null && (!Number.isFinite(measuredPeakFwhm) || measuredPeakFwhm <= 0)) || (fittedPeakFwhm !== null && (!Number.isFinite(fittedPeakFwhm) || fittedPeakFwhm <= 0))) throw new Error("피크 반치폭 결과가 올바르지 않습니다.");
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
  if (!intensities.some((value) => value > 0)) throw new Error("피팅 범위 안에 양의 측정 강도가 필요합니다.");
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
    {name:"왼쪽", low:fit.range[0], high:peakLow},
    {name:"주 피크", low:peakLow, high:peakHigh},
    {name:"오른쪽", low:peakHigh, high:fit.range[1]}
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
  $("residualOverall").textContent = `${diagnostic.range[0].toFixed(2)}–${diagnostic.range[1].toFixed(2)}° · 화면 잔차 RMSE ${diagnostic.rmse.toFixed(3)}`;
  const reviewRegions = diagnostic.regions.filter((region) => region.count >= 10);
  const worst = reviewRegions.reduce((current, region) => !current || region.rmse > current.rmse ? region : current, null);
  const cards = diagnostic.regions.map((region) => {
    const card = document.createElement("div");
    card.className = `residual-region${region === worst && reviewRegions.length > 1 ? " is-worst" : ""}`;
    const title = document.createElement("span");
    title.textContent = `${region.name} · ${region.low.toFixed(2)}–${region.high.toFixed(2)}°`;
    const value = document.createElement("strong");
    value.textContent = region.rmse === null ? "측정점 없음" : `로그 RMSE ${region.rmse.toFixed(3)}`;
    const detail = document.createElement("small");
    detail.textContent = region.rmse === null ? "범위를 조정하세요" : region.count < 10 ? `측정 ${region.count.toLocaleString("ko-KR")}점 · 표본 부족, 참고값` : `중위 계산/측정 ${ratioText(region.median)} · ${region.count.toLocaleString("ko-KR")}점`;
    card.append(title, value, detail);
    return card;
  });
  $("residualRegions").replaceChildren(...cards);
  const extraction = diagnostic.sourcePoints > diagnostic.points.length ? ` · 원본 ${diagnostic.sourcePoints.toLocaleString("ko-KR")}점 중 ${diagnostic.points.length.toLocaleString("ko-KR")}점 사용` : "";
  const fallback = fit.fallback || diagnostic.range[0] !== fit.range[0] || diagnostic.range[1] !== fit.range[1] ? "피팅 범위 입력을 적용할 수 없어 측정과 계산이 겹치는 전체 구간을 표시합니다. " : "";
  $("residualNote").textContent = `${fallback}표시된 계산 곡선을 측정 각도에 보간한 진단${extraction}입니다. 0강도는 상대값 10⁻¹²로 계산하며 모든 잔차를 차트 축에 포함합니다. 피크 가중 최적화 점수와 값이 다를 수 있습니다.`;
  requestDraw();
  return {worst, regions:diagnostic.regions, rmse:diagnostic.rmse};
}

function showFitResult(result, fit) {
  state.fitResult = {
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
  $("fitThicknessLabel").textContent = thicknessFitted ? "Thickness (피팅값)" : "Thickness (N 고정·환산값)";
  $("fitPlanesLabel").textContent = thicknessFitted ? "반복 단위 N (피팅)" : "반복 단위 N (고정)";
  $("fitThickness").textContent = `${result.thickness_nm.toFixed(2)} nm`;
  const resultParams = result.config.parameters, activeC = filmAxisMode(resultParams) === "00l";
  $("fitLatticeLabel").textContent = activeC ? "박막 평균 c" : "박막 평균 a";
  $("fitLattice").textContent = `${filmActiveMean(resultParams).toFixed(5)} Å`;
  $("fitOtherLatticeField").hidden = resultParams.film_system !== "tetragonal";
  $("fitOtherLatticeLabel").textContent = activeC ? "박막 a (고정)" : "박막 c";
  $("fitOtherLattice").textContent = `${(activeC ? resultParams.film_lattice_a : resultParams.film_lattice_c || resultParams.film_lattice_a).toFixed(5)} Å`;
  const meanA = filmActiveMean(result.config.parameters), gradientA = result.config.parameters.film_lattice_gradient_a;
  $("fitGradientLabel").textContent = filmGradientLabel(resultParams) + (fit.bounds?.film_lattice_gradient_a ? " (피팅)" : " (고정)");
  $("fitGradient").textContent = `${gradientA > 0 ? "+" : ""}${gradientA.toFixed(5)} Å`;
  $("fitGradientEndpoints").textContent = `계면 ${((meanA - gradientA / 2)).toFixed(5)} → 표면 ${((meanA + gradientA / 2)).toFixed(5)} Å`;
  $("fitPlanes").textContent = `${result.config.parameters.film_planes}`;
  const initialFwhm = Number(fit.initial_parameters?.fwhm_deg);
  const finalFwhm = result.config.parameters.fwhm_deg;
  $("fitFwhm").textContent = fit.bounds?.fwhm_deg ? (Number.isFinite(initialFwhm) ? `${initialFwhm.toFixed(4)} → ${finalFwhm.toFixed(4)}°` : `${finalFwhm.toFixed(4)}°`) : `${finalFwhm.toFixed(4)}° 고정`;
  for (const [key, id, unit] of [["resolution_halo_fraction", "fitHaloFraction", ""], ["resolution_halo_width", "fitHaloWidth", "×"], ["film_interface_width", "fitInterfaceWidth", "반복 단위"], ["film_thickness_sigma", "fitThicknessSigma", "반복 단위"], ["film_intensity_scale", "fitFilmScale", "×"], ["background_slope", "fitBackgroundSlope", "log₁₀/°"]]) {
    const value = result.config.parameters[key], mode = fit.bounds?.[key] ? "피팅" : "고정";
    $(id).textContent = `${trimNumber(value, 5)} ${unit} · ${mode}`;
  }
  renderFringeComparison();
  $("fitLpMode").textContent = Array.from($("lp_mode").options).find(option => option.value === result.config.parameters.lp_mode)?.textContent || "—";
  $("fitPeakFwhm").textContent = result.measured_peak_fwhm_deg === null || result.fitted_peak_fwhm_deg === null ? "측정 불가" : `${result.measured_peak_fwhm_deg.toFixed(4)} → ${result.fitted_peak_fwhm_deg.toFixed(4)}°`;
  $("fitError").textContent = `${result.initial_log_rmse === null ? "—" : result.initial_log_rmse.toFixed(3)} → ${result.best_log_rmse.toFixed(3)}`;
  const sourceDescription = fit.sourcePoints > result.fit_points ? ` (원본 구간 ${fit.sourcePoints.toLocaleString("ko-KR")}점에서 추출)` : "";
  const adjusted = Array.isArray(fit.adjusted) && fit.adjusted.length ? ` · 초기값 경계 조정: ${fit.adjusted.join(", ")}` : "";
  $("fitResultDetails").textContent = `${result.fit_points.toLocaleString("ko-KR")}개 측정점${sourceDescription} · ${result.evaluations.toLocaleString("ko-KR")}회 모델 평가${adjusted}`;
  $("fitMerit").hidden = result.best_fit_merit === null;
  if (result.best_fit_merit !== null) $("fitMerit").textContent = `피크 가중 피팅 오차 ${result.initial_fit_merit === null ? "—" : result.initial_fit_merit.toFixed(3)} → ${result.best_fit_merit.toFixed(3)} · 최적화 기준 (로그 RMSE는 전체 구간의 별도 지표)`;
  const residualAssessment = renderResidualDiagnostics(result, fit);
  const boundaryHits = [];
  for (const [key, [low, high]] of Object.entries(fit.bounds || {})) {
    const value = result.config.parameters[key], tolerance = fitIntegerKeys.has(key) ? 0 : Math.max(1e-8, (high - low) * 1e-4);
    if (Math.abs(value - low) <= tolerance) boundaryHits.push({key, side:"하한"});
    else if (Math.abs(value - high) <= tolerance) boundaryHits.push({key, side:"상한"});
  }
  const warnings = [];
  if (filmAxisMode(resultParams) === "mixed" && fit.bounds?.film_lattice_a && fit.bounds?.film_lattice_c) warnings.push("단일 혼합 반사는 a와 c의 조합만 제한합니다. 두 축의 피팅값을 독립적인 격자 측정으로 해석하지 마세요.");
  if (resultParams.film_intensity_scale === 0) warnings.push("박막 상대 강도 배율이 0이므로 박막 산란이 없습니다. 이 조건에서 박막 격자·두께·구배를 결정할 수 없습니다.");
  if (fit.bounds?.film_intensity_scale && resultParams.substrate_planes === 0) warnings.push("기판 산란이 없으면 양의 박막 강도 배율은 정규화로 상쇄됩니다. 상대 배경을 넣어도 이 배율은 결정되지 않습니다.");
  const haloFraction = result.config.parameters.resolution_halo_fraction;
  const haloWidth = result.config.parameters.resolution_halo_width;
  if (haloFraction === 0 && fit.bounds?.resolution_halo_width) warnings.push("넓은 분해능 성분 비율 f가 0이므로 폭 배수 m은 결정되지 않습니다. 이 조건의 m 피팅값을 해석하지 마세요.");
  if (haloWidth === 1 && fit.bounds?.resolution_halo_fraction) warnings.push("폭 배수 m이 1이면 두 Gaussian 성분이 같아 비율 f는 결정되지 않습니다.");
  if (finalFwhm === 0 && (haloFraction > 0 || fit.bounds?.resolution_halo_fraction || fit.bounds?.resolution_halo_width)) warnings.push("기구 FWHM이 0이므로 넓은 분해능 성분은 계산에 영향을 주지 않습니다. f와 m 피팅값을 해석하지 마세요.");
  if (result.config.parameters.film_interface_width > 0 && result.config.parameters.film_thickness_sigma > 0) warnings.push("경계 테이퍼 w와 두께 분포 σN을 함께 적용했습니다. 서로 상관될 수 있으므로 각각 따로 피팅한 구간별 잔차와 비교하세요. 어느 값도 거칠기의 독립 측정값은 아닙니다.");
  if (result.config.parameters.background === 0 && (result.config.parameters.background_slope !== 0 || fit.bounds?.background_slope)) warnings.push("상대 배경이 0이므로 로그 배경 기울기는 계산에 영향을 주지 않습니다. 이 조건에서 기울기 피팅값을 해석하지 마세요.");
  let filmCountHit = boundaryHits.find((item) => item.key === "film_planes");
  if (!filmCountHit && fit.thickness_bounds_nm) {
    const repeatNm = filmRepeatNm(result.config.parameters);
    const smallestN = Math.ceil(fit.thickness_bounds_nm[0] / repeatNm - 1e-7);
    const largestN = Math.floor(fit.thickness_bounds_nm[1] / repeatNm + 1e-7);
    if (result.config.parameters.film_planes <= smallestN) filmCountHit = {key:"film_planes", side:"하한"};
    else if (result.config.parameters.film_planes >= largestN) filmCountHit = {key:"film_planes", side:"상한"};
  }
  if (filmCountHit) warnings.push(`Thickness가 선택한 ${filmCountHit.side}의 가능한 정수 반복 단위 N에 도달했습니다. 표시된 모델 두께를 확정값으로 사용하지 말고 범위와 모델 적합성을 확인하세요.`);
  const gradientHit = boundaryHits.find((item) => item.key === "film_lattice_gradient_a");
  if (gradientHit) {
    const selectedEdge = gradientHit.side === "하한" ? fit.bounds.film_lattice_gradient_a[0] : fit.bounds.film_lattice_gradient_a[1];
    const limitAdvice = Math.abs(selectedEdge) >= .2 - 1e-9 ? "현재 GUI 허용 범위의 끝입니다." : "필요하면 ±0.20 Å 안에서 경계를 넓혀 다시 확인하세요.";
    warnings.push(`${filmGradientLabel(resultParams)}가 선택한 ${gradientHit.side} ${selectedEdge.toFixed(3)} Å에 도달했습니다. ${limitAdvice} 모델 구배를 독립적으로 측정한 strain으로 해석하지 마세요.`);
  }
  const largeGradient = Math.abs(gradientA) / meanA > .01;
  if (largeGradient) warnings.push(`박막 수직 격자 구배의 상대 변화가 ${(Math.abs(gradientA) / meanA * 100).toFixed(2)}%입니다. 이 값은 모델의 유효 법선 간격 변화이며 독립적으로 확인된 strain이 아닙니다. 다른 구배·두께·기구 폭 가정도 비교하세요.`);
  const fwhmHit = boundaryHits.find((item) => item.key === "fwhm_deg");
  if (fwhmHit) warnings.push(`기구 Gaussian FWHM이 ${fwhmHit.side}에 도달했습니다. 측정·모델 피크 위치와 선택한 반사 배정을 확인하세요. FWHM은 피크 위치 오차를 보정하지 않습니다.`);
  if (fit.bounds?.fwhm_deg && result.measured_peak_fwhm_deg !== null && result.fitted_peak_fwhm_deg !== null && Math.abs(result.fitted_peak_fwhm_deg - result.measured_peak_fwhm_deg) / result.measured_peak_fwhm_deg > .25) warnings.push(`계산 피크 반치폭 ${result.fitted_peak_fwhm_deg.toFixed(4)}°가 측정 ${result.measured_peak_fwhm_deg.toFixed(4)}°와 25% 이상 다릅니다. 피크 구간·기구 폭 경계·모델 가정을 확인하세요.`);
  const substrateHit = boundaryHits.find((item) => item.key === "substrate_planes");
  const substrateAtGuiLimit = substrateHit?.side === "상한" && fit.bounds.substrate_planes[1] === substrateFitMax;
  if (substrateAtGuiLimit) warnings.push(`기판 유효 간섭 반복 수가 현재 GUI 입력 상한 ${substrateFitMax.toLocaleString("ko-KR")}에 도달했습니다. 이 값은 실제 기판 두께가 아닙니다. 기판 피크 꼬리·기구 폭·반사면·파장 가정을 확인하세요.`);
  else if (substrateHit?.side === "상한") warnings.push(`기판 유효 간섭 반복 수가 선택한 상한 ${fit.bounds.substrate_planes[1].toLocaleString("ko-KR")}에 도달했습니다. 필요하면 현재 GUI 입력 상한 ${substrateFitMax.toLocaleString("ko-KR")} 이내에서 경계를 넓혀 다시 확인하세요.`);
  else if (substrateHit?.side === "하한") warnings.push(fit.bounds.substrate_planes[0] === 1 ? "기판 유효 간섭 반복 수가 모델 최솟값 1에 도달했습니다. 기판 피크와 측정 조건을 확인하세요." : `기판 유효 간섭 반복 수가 선택한 하한 ${fit.bounds.substrate_planes[0].toLocaleString("ko-KR")}에 도달했습니다. 더 낮은 값이 타당한지 경계와 측정 조건을 확인하세요.`);
  const backgroundHit = boundaryHits.find((item) => item.key === "background");
  if (backgroundHit?.side === "하한" && fit.bounds.background?.[0] === 0) warnings.push("상대 배경이 최솟값 0에 도달했습니다. 배경을 더 낮춰 계산 꼬리를 줄일 수는 없습니다. 기판 간섭 길이·기구 폭·반사면·파장 및 모델 가정을 확인하세요.");
  else if (backgroundHit) warnings.push(`상대 배경 ${backgroundHit.side}에 도달했습니다. 경계를 확인하세요.`);
  const otherHits = boundaryHits.filter((item) => !["film_planes", "film_lattice_gradient_a", "fwhm_deg", "substrate_planes", "background"].includes(item.key));
  if (otherHits.length) warnings.push(`${otherHits.map((item) => `${labelFor(item.key)} ${item.side}`).join(", ")}에 도달했습니다. 해당 경계를 넓혀 결과를 확인하세요.`);
  if (result.diagnostics?.fixed_sto_wing_excess) {
    const ratio = (log) => log === null ? "3배 이상" : `약 ${Math.pow(10, Math.min(4, Math.max(0, log))).toFixed(1)}배`;
    const advice = result.config.parameters.substrate_planes >= substrateFitMax ? "이미 현재 GUI 입력 상한이므로 기판 피크·기구 함수와 모델 가정을 검토하세요." : "기판 간섭 반복 수를 늘리거나 피팅 변수로 선택하세요.";
    warnings.push(`기판 유효 간섭 반복 수 ${result.config.parameters.substrate_planes.toLocaleString("ko-KR")}을 고정한 상태에서 계산 곡선의 왼쪽·오른쪽 꼬리가 측정보다 각각 ${ratio(result.diagnostics.left_wing_log_ratio)}, ${ratio(result.diagnostics.right_wing_log_ratio)} 높습니다. ${advice} Thickness와 양수 배경만 조정해서는 이 차이를 없애기 어렵습니다.`);
  }
  const rightResidual = residualAssessment?.regions.find((region) => region.name === "오른쪽");
  const rightWingBias = rightResidual?.count >= 10 && rightResidual.median !== null && Math.abs(rightResidual.median) >= Math.log10(2);
  if (rightWingBias && !result.diagnostics?.fixed_sto_wing_excess) warnings.push(`피팅 구간 오른쪽 ${rightResidual.low.toFixed(2)}–${rightResidual.high.toFixed(2)}°에서 중위 계산/측정 강도비가 ${ratioText(rightResidual.median)}입니다. 전체 점수만으로 피크 꼬리의 불일치를 판단하지 마세요.`);
  if (residualAssessment?.worst?.rmse >= .3 && result.best_log_rmse < .5 && !rightWingBias) warnings.push(`표시 곡선의 ${residualAssessment.worst.name} 구간 로그 RMSE가 ${residualAssessment.worst.rmse.toFixed(3)}입니다. 구간별 잔차를 확인하세요.`);
  if (fit.thickness_bounds_nm && (result.thickness_nm < fit.thickness_bounds_nm[0] - 1e-7 || result.thickness_nm > fit.thickness_bounds_nm[1] + 1e-7)) warnings.push("결과 Thickness가 요청한 nm 경계를 벗어났습니다. 설정을 다시 확인하세요.");
  if (fit.bounds?.fwhm_deg && state.measurement && Number.isFinite(state.simulation?.substratePeak)) {
    const first = lowerBound(state.measurement.angles, fit.range[0]), last = upperBound(state.measurement.angles, fit.range[1]);
    let main = first;
    for (let i = first + 1; i < last; i++) if (state.measurement.intensities[i] > state.measurement.intensities[main]) main = i;
    const separation = Math.abs(state.measurement.angles[main] - state.simulation.substratePeak);
    if (separation > .1) warnings.push(`측정 주 피크와 기판 예상 위치가 ${separation.toFixed(3)}° 떨어져 있습니다. 이 피크를 기판으로 배정했다면 반사면·영점 보정을 확인하세요. FWHM으로 위치 차이를 줄일 수 없습니다.`);
  }
  if (result.best_log_rmse >= .5) warnings.push("잔여 로그 오차가 큽니다. 반사면·파장·재료 가정과 피팅 범위, 모델 적합성을 확인하세요.");
  if (result.initial_log_rmse !== null && result.best_fit_merit !== null && result.best_log_rmse > result.initial_log_rmse + Math.max(.05, .05 * result.initial_log_rmse)) warnings.push("주 피크 폭을 우선 맞추면서 전체 구간 로그 RMSE가 증가했습니다. 그래프의 잔차와 피팅 범위를 확인하세요.");
  if (result.diagnostics?.fit_improved_materially === false && result.best_log_rmse >= .25) warnings.push("초기값 대비 피팅 오차가 의미 있게 줄지 않았습니다. 현재 결과의 Thickness를 확정값으로 사용하지 마세요.");
  else if (result.best_fit_merit !== null && result.initial_fit_merit !== null && result.initial_fit_merit > 0 && result.best_fit_merit / result.initial_fit_merit > .95) warnings.push("초기값 대비 피크 가중 피팅 오차 개선이 작습니다. 초기값과 피팅 경계를 확인하세요.");
  else if (result.best_fit_merit === null && result.initial_log_rmse !== null && result.initial_log_rmse > 0 && result.best_log_rmse / result.initial_log_rmse > .95) warnings.push("초기값 대비 오차 개선이 작습니다. 초기값과 피팅 경계를 확인하세요.");
  if (result.initial_log_rmse === null) warnings.push("입력한 초기 모델은 유효한 비교 곡선을 계산하지 못했습니다. 피팅 결과의 물리적 타당성을 확인하세요.");
  if (fit.sourcePoints > result.fit_points) warnings.push("측정점 일부를 추출해 최적화했습니다. 전체 측정 곡선과의 일치를 확인하세요.");
  if (result.reference_decimated) warnings.push("계산 참조 격자를 축약해 피팅했습니다. 전체 해상도 계산 곡선과의 일치를 확인하세요.");
  const warningBox = $("fitWarning");
  warningBox.replaceChildren(...warnings.map((warning) => {
    const line = document.createElement("span");
    line.className = "fit-warning-item";
    line.textContent = warning;
    return line;
  }));
  warningBox.hidden = warnings.length === 0;
  const needsReview = Boolean(gradientHit) || largeGradient || substrateAtGuiLimit || result.best_log_rmse >= .5 || rightWingBias || residualAssessment?.worst?.rmse >= .3 || result.diagnostics?.fixed_sto_wing_excess === true || (result.diagnostics?.fit_improved_materially === false && result.best_log_rmse >= .25);
  $("fit-result-title").textContent = needsReview ? "피팅 결과 검토 필요" : "자동 피팅 결과";
  $("fitResult").querySelector(".eyebrow").textContent = needsReview ? "FIT CHECK" : "BEST FIT";
  $("fitResult").classList.toggle("needs-review", needsReview);
  $("fitResult").hidden = false;
  return {warningCount:warnings.length, needsReview};
}

async function runFit() {
  if (state.fitBusy) return;
  let config, fit;
  try { config = readForm(); fit = readFitSettings(config); }
  catch (error) { setFitProgress(error.message, "error"); setStatus(`피팅 입력 확인: ${error.message}`, true); return; }
  const start = projectFitStart(config, fit);
  const measurement = state.measurement;
  let fitMeasurement;
  try { fitMeasurement = measurementForFit(measurement, fit.range); }
  catch (error) { setFitProgress(error.message, "error"); setStatus(`피팅 입력 확인: ${error.message}`, true); return; }
  const id = ++state.requestId;
  const job = `fit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setFitBusy(true);
  const sampling = fitMeasurement.sourcePoints > fitMeasurement.angles.length ? ` · ${fitMeasurement.sourcePoints.toLocaleString("ko-KR")}점 중 ${fitMeasurement.angles.length.toLocaleString("ko-KR")}점 사용` : "";
  const rangeText = `${fit.range[0].toFixed(3)}–${fit.range[1].toFixed(3)}°${sampling}${start.adjusted.length ? ` · 초기값 경계 조정: ${start.adjusted.join(", ")}` : ""}`;
  startFitWatch(job, fit.max_evaluations, rangeText);
  setStatus("측정 데이터의 로그 강도와 주 피크 폭·형상을 함께 맞추는 중입니다…");
  try {
    const body = {parameters:start.parameters, measurement:{angles:fitMeasurement.angles,intensities:fitMeasurement.intensities}, fit, job};
    const raw = await getJson("/api/fit", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    if (id !== state.requestId) return;
    if (raw && raw.cancelled) {
      setFitProgress("피팅을 중단했습니다. 값은 그대로 두었습니다 — 경계나 탐색 예산을 바꾸고 다시 실행하세요.", "warning");
      setStatus("자동 피팅을 중단했습니다.");
      return;
    }
    const result = validateFitResponse(raw, config.scan);
    const simulated = await getJson("/api/simulate", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(result.config)});
    if (id !== state.requestId) return;
    const curve = validateSimulation(simulated);
    applyConfig(result.config);
    installSimulation(result.config, curve);
    const fitAssessment = showFitResult(result, {...fit, sourcePoints:fitMeasurement.sourcePoints, initial_parameters:start.parameters, adjusted:start.adjusted});
    const meritProgress = result.best_fit_merit === null ? `로그 RMSE ${result.initial_log_rmse === null ? "—" : result.initial_log_rmse.toFixed(3)} → ${result.best_log_rmse.toFixed(3)}` : `피크 가중 오차 ${result.initial_fit_merit === null ? "—" : result.initial_fit_merit.toFixed(3)} → ${result.best_fit_merit.toFixed(3)}`;
    setFitProgress(`${fitAssessment.needsReview ? "결과 검토 필요" : "완료"} · ${result.evaluations.toLocaleString("ko-KR")}회 평가 · ${meritProgress}`, fitAssessment.needsReview ? "warning" : "success");
    setStatus(`${fitAssessment.needsReview ? "피팅 결과 검토 필요" : "자동 피팅 계산 완료"} · 모델 두께 ${result.thickness_nm.toFixed(2)} nm${fitAssessment.warningCount ? " · 결과의 주의 표시를 확인하세요." : ""}`);
  } catch (error) {
    if (id === state.requestId) {
      setFitProgress(`피팅 실패: ${explainModelError(error)}`, "error");
      setStatus(`피팅 오류: ${explainModelError(error)}`, true);
    }
  } finally {
    stopFitWatch();
    const button = $("cancelFit");
    if (button) button.textContent = "피팅 중단";
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
  $("substratePeak").textContent = sim.substratePeak === null ? "범위 밖" : `${formatAngle(sim.substratePeak)}°`;
  $("filmPeak").textContent = sim.filmPeak === null ? "범위 밖" : `${formatAngle(sim.filmPeak)}°`;
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
    drawMarker(ctx, state.simulation.filmPeak, "#806ec4", "박막", 28);
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
  ctx.fillStyle = "#58708b"; ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.fillText("계산 높음 +", p.left + 5, p.top + 11); ctx.fillText("측정 높음 −", p.left + 5, p.bottom - 7);
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
    state.hover = null; tooltip.hidden = true; $("hoverReadout").textContent = "2θ 위치 위에 마우스를 올려 값을 확인하세요."; drawOverlay(); return;
  }
  state.hover = px;
  const x = pixelX(px), stats = state.stats || computeStats();
  const measured = state.measurement ? interpolate(state.measurement.angles, state.measurement.intensities, x) : null;
  const simulated = interpolate(state.simulation.angles, state.simulation.intensities, x);
  const measuredRelative = measured === null ? null : measured / stats.measMax;
  const simulatedRelative = simulated === null ? null : simulated / stats.simMax;
  $("hoverReadout").textContent = `2θ ${x.toFixed(3)}° · 측정 ${measuredRelative === null ? "—" : measuredRelative.toExponential(2)} · 계산 ${simulatedRelative === null ? "—" : simulatedRelative.toExponential(2)}`;
  tooltip.replaceChildren();
  const title = document.createElement("b"); title.textContent = `2θ ${x.toFixed(3)}°`; tooltip.append(title, document.createElement("br"));
  const line1 = document.createElement("span"); line1.className = "orange"; line1.textContent = `측정 상대 강도  ${measuredRelative === null ? "—" : measuredRelative.toExponential(3)}`; tooltip.append(line1, document.createElement("br"));
  const line2 = document.createElement("span"); line2.className = "blue"; line2.textContent = `계산 상대 강도  ${simulatedRelative === null ? "—" : simulatedRelative.toExponential(3)}`; tooltip.append(line2);
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
  setStatus("전체 계산 범위로 돌아왔습니다.");
}

function useVisibleRange() {
  if (!state.measurement || !state.simulation) { setFitProgress("측정 데이터와 계산 곡선을 먼저 불러오세요.", "error"); return; }
  const lo = Math.max(state.view[0], state.measurement.angles[0], state.simulation.angles[0]);
  const hi = Math.min(state.view[1], state.measurement.angles.at(-1), state.simulation.angles.at(-1));
  if (hi <= lo || upperBound(state.measurement.angles, hi) - lowerBound(state.measurement.angles, lo) < 10) {
    setFitProgress("현재 그래프 범위에는 피팅할 측정점이 10개 이상 필요합니다.", "error");
    return;
  }
  $("fit_min").value = trimNumber(lo, 8);
  $("fit_max").value = trimNumber(hi, 8);
  markFitResultStale();
  renderResidualDiagnostics();
  setFitProgress(`피팅 범위: ${lo.toFixed(3)}–${hi.toFixed(3)}°`);
  requestDraw();
}

function observedPeakIn(lo, hi) {
  if (!state.measurement) return null;
  const found = visibleMaximum(state.measurement.angles, state.measurement.intensities, lo, hi);
  return found.index >= 0 ? state.measurement.angles[found.index] : null;
}

function braggAngle(a, hkl, wavelength, c = 0, system = "cubic") {
  const sine = wavelength / (2 * latticeD(a, hkl, c, system));
  if (!Number.isFinite(sine) || sine <= 0 || sine > 1) throw new Error("선택한 반사면이 파장과 격자상수에서 접근 불가능합니다.");
  return 2 * Math.asin(sine) * 180 / Math.PI;
}

async function alignObservedAsSto() {
  let config;
  try { config = readForm(); }
  catch (error) { setStatus(`입력 확인: ${error.message}`, true); return; }
  const observed = observedPeakIn(config.scan.xmin, config.scan.xmax);
  if (observed === null) { setStatus("정렬할 측정 피크가 현재 계산 범위에 없습니다.", true); return; }
  try {
    const p = config.parameters, entry = substrates.get(p.substrate_material), indices = parseHkl(p.hkl);
    if (reflectionAbsent(indices, entry?.centering || "P") || entry?.basis === "rutile" && rutileReflectionAbsent(indices)) throw new Error("선택한 기판 반사는 계통 소멸 조건이므로 정렬 기준으로 사용할 수 없습니다.");
    const expected = braggAngle(p.substrate_lattice_a, p.hkl, p.wavelength, p.substrate_lattice_c, entry?.system || "cubic");
    const offset = observed - expected;
    if (Math.abs(offset) > 5) throw new Error("필요한 보정값이 ±5°를 넘습니다. 반사면과 파장을 확인하세요.");
    $("angle_offset_deg").value = offset.toFixed(5);
    invalidateFringes(); invalidatePeaks();
    markCurveStale();
    markFitResultStale();
    if (await runSimulation()) setStatus(`측정 주 피크 ${observed.toFixed(3)}°를 기판 ${config.parameters.hkl}로 가정해 영점 보정 ${offset >= 0 ? "+" : ""}${offset.toFixed(3)}°를 적용했습니다. 반사 배정은 직접 확인하세요.`);
  } catch (error) { setStatus(`정렬 불가: ${error.message}`, true); }
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
    const project = {format:"xrd-studio-project-v1",model_revision:modelRevision,parameters:state.config.parameters,scan:state.config.scan,measurement_name:state.measurement?.filename || "측정 데이터 없음"};
    if (state.measurement) project.measurement = {two_theta_deg:state.measurement.angles,intensity_raw:state.measurement.intensities};
    project.fit_settings = captureFitSettings();
    project.fringe_settings = captureFringeInputs();
    project.peak_settings = capturePeakInputs();
    if (state.fitResult && !state.fitResult.stale) project.fit_result = state.fitResult;
    downloadText("xrd_studio_project.json", JSON.stringify(project, null, 2), "application/json;charset=utf-8");
    setStatus("설정, 피팅 범위와 측정 원본 데이터를 JSON 파일로 저장했습니다.");
  } catch (error) { setStatus(`설정 저장 오류: ${error.message}`, true); }
}

async function loadProject(file) {
  if (!file) return;
  try {
    const project = JSON.parse(await file.text());
    if (project.format !== "xrd-studio-project-v1") throw new Error("XRD Studio 설정 파일이 아닙니다.");
    const config = validateConfig({parameters:project.parameters, scan:project.scan});
    let measurement = null;
    if (project.measurement) measurement = validateCurve({...project.measurement, filename:project.measurement_name || "저장된 측정 데이터"});
    applyConfig(config);
    if (measurement) setMeasurement(measurement, {adjustScan:false});
    else {state.measurement = null; invalidateFringes({clearInputs:true}); $("dataName").textContent = "측정 데이터 없음"; $("dataMeta").textContent = "2θ(°), 강도 · 2열 파일";}
    applyFringeInputs(project.fringe_settings);
    applyPeakInputs(project.peak_settings);
    const migratedThicknessBounds = applyFitSettings(project.fit_settings);
    if (await runSimulation()) {
      if (measurement && project.fit_result && project.model_revision !== modelRevision) {
        setFitProgress("저장된 피팅의 계산 기준이 현재와 다릅니다. 다시 피팅하세요.");
      }
      if (measurement && project.fit_result && project.model_revision === modelRevision) {
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
            setFitProgress("저장된 피팅 결과를 복원했습니다.", "success");
          }
        } catch { /* Old or malformed optional fit result does not block project loading. */ }
      }
      setStatus(`${file.name}에서 설정과 측정 데이터를 열었습니다.${migratedThicknessBounds ? " 이전 N 피팅 경계를 nm로 환산했습니다." : ""}`);
    }
  } catch (error) { setStatus(`설정 열기 오류: ${error.message}`, true); }
}

async function exportCsv() {
  try {
    if (!await ensureCurrentSimulation()) return;
    const sim = state.simulation, meas = state.measurement;
    const measuredMaximum = meas ? visibleMaximum(meas.angles, meas.intensities, sim.angles[0], sim.angles.at(-1)).maximum || 1 : 1;
    const rows = ["two_theta_deg,simulation_relative,measurement_raw,measurement_relative"];
    for (let i = 0; i < sim.angles.length; i++) {
      const x = sim.angles[i], raw = meas ? interpolate(meas.angles, meas.intensities, x) : null;
      rows.push(`${x.toFixed(8)},${sim.intensities[i].toPrecision(10)},${raw === null ? "" : raw.toPrecision(10)},${raw === null ? "" : (raw / measuredMaximum).toPrecision(10)}`);
    }
    downloadText("xrd_simulation.csv", "\uFEFF" + rows.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
    setStatus("계산 곡선과 측정 원본/상대 강도를 CSV로 내보냈습니다.");
  } catch (error) { setStatus(`CSV 내보내기 오류: ${error.message}`, true); }
}

function bindEvents() {
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
  $("fit_evaluations").addEventListener("change", () => setFitProgress(`탐색 예산: 최대 ${Number($("fit_evaluations").value).toLocaleString("ko-KR")}회 모델 평가`));
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
        setStatus(`2θ ${lo.toFixed(3)}–${hi.toFixed(3)}° 구간으로 확대했습니다.`);
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
