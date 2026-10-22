"use strict";

// Descriptive intensity decomposition. No phase/volume/depth inference.
const XRDPeaks = (() => {
  const LN2 = Math.log(2), CG = Math.sqrt(4 * LN2 / Math.PI), CL = 2 / Math.PI, FLOOR = .005;
  const number = (value, label) => {
    if (!["number", "string"].includes(typeof value) || typeof value === "string" && !value.trim()
        || !Number.isFinite(Number(value))) throw new Error(`${label} must be a finite number`);
    return Number(value);
  };
  const median = values => { const a = [...values].sort((x,y) => x-y), n = a.length; return n % 2 ? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2; };

  function pseudoVoigt(x, center, width, eta) {
    const t = (x-center)/width;
    return (1-eta)*CG/width*Math.exp(-4*LN2*t*t)+eta*CL/width/(1+4*t*t);
  }

  function erf(x) {
    // Positive-term series for exp(x²)*erf(x); no cancellation. Outside ±6
    // the complementary Gaussian area is below double-precision resolution.
    const sign = x < 0 ? -1 : 1, a = Math.abs(x);
    if (a >= 6) return sign;
    let term = a, sum = a;
    for (let n = 1; n < 300; n++) {
      term *= 2*a*a/(2*n+1); sum += term;
      if (term <= Math.abs(sum)*1e-17) break;
    }
    return sign * 2/Math.sqrt(Math.PI)*Math.exp(-a*a)*sum;
  }

  function pseudoVoigtIntegral(low, high, center, width, eta) {
    const a = (low-center)/width, b = (high-center)/width;
    return (1-eta)*.5*(erf(2*Math.sqrt(LN2)*b)-erf(2*Math.sqrt(LN2)*a))
      +eta*(Math.atan(2*b)-Math.atan(2*a))/Math.PI;
  }

  function solve(matrix, vector) {
    const n = vector.length, a = matrix.map((row,i) => [...row,vector[i]]);
    for (let col = 0; col < n; col++) {
      let pivot = col;
      for (let row = col+1; row < n; row++) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
      if (Math.abs(a[pivot][col]) < 1e-20) return null;
      [a[col],a[pivot]] = [a[pivot],a[col]];
      const scale = a[col][col];
      for (let j = col; j <= n; j++) a[col][j] /= scale;
      for (let row = col+1; row < n; row++) {
        const factor = a[row][col];
        for (let j = col; j <= n; j++) a[row][j] -= factor*a[col][j];
      }
    }
    const out = Array(n).fill(0);
    for (let row = n-1; row >= 0; row--) {
      let sum = 0;
      for (let j = row+1; j < n; j++) sum += a[row][j]*out[j];
      out[row] = a[row][n]-sum;
    }
    return out;
  }

  function parseHkl(value) {
    if (typeof value === "string") {
      const cleaned = value.trim().replace(/^[([]|[)\]]$/g, "");
      const parts = /^\d{3}$/.test(cleaned) ? cleaned.split("") : cleaned.split(/[,\s]+/);
      if (parts.some(part => !/^[+-]?\d+$/.test(part))) throw new Error("hkl must contain three integer indices");
      value = parts.map(Number);
    }
    if (!Array.isArray(value) || value.length !== 3 || value.some(x => !Number.isInteger(x)) || !value.some(Boolean)) {
      throw new Error("hkl must contain three integer indices, not all zero");
    }
    return value.slice();
  }

  function evaluate(v, x, y, count, loss) {
    const size = v.length, hessian = Array.from({length:size}, () => Array(size).fill(0)), gradient = Array(size).fill(0);
    let squared = 0;
    for (let n = 0; n < x.length; n++) {
      const u = x[n], observed = y[n], derivatives = [];
      let predicted = v[size-2]*(1-u)+v[size-1]*u;
      for (let k = 0; k < count; k++) {
        const [center,width,area,eta] = v.slice(4*k,4*k+4), t = (u-center)/width, denominator = 1+4*t*t;
        const gaussian = CG/width*Math.exp(-4*LN2*t*t), lorentz = CL/width/denominator;
        const shape = (1-eta)*gaussian+eta*lorentz;
        predicted += area*shape;
        derivatives.push(area*((1-eta)*gaussian*8*LN2*t/width+eta*lorentz*8*t/(width*denominator)),
          area*((1-eta)*gaussian*(-1+8*LN2*t*t)/width+eta*lorentz*(-1+8*t*t/denominator)/width),
          shape,area*(lorentz-gaussian));
      }
      derivatives.push(1-u,u);
      const residual = loss === "soft_log" ? Math.log10(predicted+FLOOR)-Math.log10(observed+FLOOR) : predicted-observed;
      const factor = loss === "soft_log" ? 1/(Math.log(10)*(predicted+FLOOR)) : 1, jacobian = derivatives.map(value => value*factor);
      squared += residual*residual;
      for (let i = 0; i < size; i++) {
        gradient[i] += jacobian[i]*residual;
        for (let j = 0; j <= i; j++) hessian[i][j] += jacobian[i]*jacobian[j];
      }
    }
    for (let i = 0; i < size; i++) for (let j = 0; j < i; j++) hessian[j][i] = hessian[i][j];
    return [Math.sqrt(squared/x.length),hessian,gradient];
  }

  function seeds(x, y, count, widthLow, initial) {
    const smooth = y.map((v,i) => i === 0 || i === y.length-1 ? v : (y[i-1]+2*v+y[i+1])/4), maxima = [];
    for (let i = 1; i < y.length-1; i++) if (smooth[i] >= smooth[i-1] && smooth[i] > smooth[i+1]) maxima.push(i);
    maxima.sort((i,j) => smooth[j]-smooth[i] || i-j);
    const selected = [];
    for (const i of maxima) {
      if (selected.every(u => Math.abs(x[i]-u) >= Math.max(.04,2*widthLow))) selected.push(x[i]);
      if (selected.length === 3) break;
    }
    let maximum = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[maximum]) maximum = i;
    const dominant = x[maximum], pairs = selected.length >= 2 ? [selected.slice(0,2).sort((a,b) => a-b)] : [];
    pairs.push([Math.max(0,dominant-.10),Math.min(1,dominant+.10)],[.30,.70],[.40,.60]);
    const centers = count === 1 ? [dominant,.35,.65].map(u => [u]) : pairs;
    const baseline = .8*Math.min(...y);
    let total = 0;
    for (let i = 1; i < x.length; i++) total += (y[i]+y[i-1]-2*baseline)*(x[i]-x[i-1])/2;
    total = Math.max(total,.02);
    const result = initial ? [initial] : [];
    for (const pair of centers) for (const [width,eta] of [[.08,.15],[.18,.5],[.32,.85]]) {
      const vector = [];
      for (const center of pair) vector.push(center,Math.max(widthLow,width),Math.min(4,total/count),eta);
      vector.push(baseline,baseline);
      if (!result.some(old => old.every((v,i) => v === vector[i]))) result.push(vector);
    }
    return result;
  }

  function analyzePeaks(request) {
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("Expected a peak-analysis object");
    const measurement = request.measurement;
    if (!measurement || typeof measurement !== "object" || Array.isArray(measurement)) throw new Error("Peak analysis needs measurement data");
    let angles = measurement.angles, intensities = measurement.intensities;
    if (!Array.isArray(angles) || !Array.isArray(intensities) || angles.length !== intensities.length || angles.length < 20 || angles.length > 200000) {
      throw new Error("Peak analysis needs 20–200,000 matching angle/intensity values");
    }
    angles = angles.map(value => number(value,"measurement angle"));
    intensities = intensities.map(value => number(value,"measurement intensity"));
    if (angles.some((v,i) => !(v > 0 && v < 180) || i > 0 && v <= angles[i-1])) throw new Error("Measurement angles must increase strictly within 0–180°");
    if (intensities.some(v => v < 0)) throw new Error("Measurement intensities must be nonnegative");
    if (!Array.isArray(request.roi) || request.roi.length !== 2) throw new Error("Peak ROI needs [start, end]");
    const [low,high] = request.roi.map(value => number(value,"ROI bound"));
    if (!(angles[0] <= low && low < high && high <= angles[angles.length-1])) throw new Error("Peak ROI must lie within the measurement");
    const wavelength = number(request.wavelength,"wavelength");
    if (!(wavelength > 0)) throw new Error("wavelength must be positive");
    const offset = number(request.angle_offset_deg === undefined ? 0 : request.angle_offset_deg,"angle_offset_deg");
    if (!(low-offset > 0 && high-offset < 180)) throw new Error("Peak ROI offset leaves the physical 0–180° range");
    const hkl = parseHkl(request.hkl === undefined ? "002" : request.hkl);
    let reference = request.reference === undefined ? null : request.reference;
    if (reference !== null) {
      if (!reference || typeof reference !== "object" || Array.isArray(reference)) throw new Error("reference needs center_deg and d_angstrom");
      reference = {center_deg:number(reference.center_deg,"reference center"),d_angstrom:number(reference.d_angstrom,"reference d-spacing")};
      if (!(reference.d_angstrom > 0 && reference.center_deg-offset > 0 && reference.center_deg-offset < 180)) throw new Error("Reference d-spacing must be positive and its corrected angle within 0–180°");
    }
    const count = request.peak_count === undefined ? 2 : request.peak_count;
    if (!Number.isInteger(count) || ![1,2].includes(count)) throw new Error("peak_count must be 1 or 2");
    const loss = request.loss === undefined ? "soft_log" : request.loss;
    if (!["soft_log","linear"].includes(loss)) throw new Error("loss must be soft_log or linear");
    const budget = request.max_evaluations === undefined ? 2000 : request.max_evaluations;
    if (!Number.isInteger(budget) || budget < 100 || budget > 6000) throw new Error("max_evaluations must be an integer from 100 to 6,000");
    const grid = [], observed = [];
    angles.forEach((a,i) => { if (a >= low && a <= high) { grid.push(a); observed.push(intensities[i]); } });
    if (grid.length < 20) throw new Error("Peak ROI needs at least 20 measured points");
    if (grid.length*budget > 5000000) throw new Error("Peak fit exceeds the work limit; narrow the ROI or reduce max_evaluations");
    const peak = Math.max(...observed);
    if (!(peak > 0)) throw new Error("Peak ROI has no positive intensity");
    const span = high-low, x = grid.map(a => (a-low)/span), y = observed.map(v => v/peak);
    const widthLow = Math.max(2*median(grid.slice(1).map((a,i) => a-grid[i]))/span,1e-4);
    if (widthLow >= 1) throw new Error("Peak ROI is too narrow for a resolved width");
    const bounds = [];
    for (let k = 0; k < count; k++) bounds.push([0,1],[widthLow,1],[0,4],[0,1]);
    bounds.push([0,1],[0,1]);
    let initial = request.initial_components === undefined ? null : request.initial_components;
    if (initial !== null) {
      if (!Array.isArray(initial) || initial.length !== count || initial.some(c => !c || typeof c !== "object" || Array.isArray(c))) throw new Error("initial_components must match peak_count");
      const vector = [];
      for (const component of initial) {
        const values = [(number(component.center_deg,"initial center")-low)/span,
          number(component.fwhm_deg,"initial FWHM")/span,number(component.area,"initial area")/(peak*span),number(component.eta,"initial eta")];
        if (values.some((v,i) => v < bounds[i][0] || v > bounds[i][1])) throw new Error("Initial peak component is outside the analysis bounds");
        vector.push(...values);
      }
      vector.push(.8*Math.min(...y),.8*Math.min(...y)); initial = vector;
    }
    const starts = seeds(x,y,count,widthLow,initial), solutions = [];
    let evaluations = 0;
    for (let index = 0; index < starts.length; index++) {
      const allowance = Math.max(1,Math.floor((budget-evaluations)/(starts.length-index))), stop = evaluations+allowance;
      let current = starts[index].slice(), [score,hessian,gradient] = evaluate(current,x,y,count,loss), damping = .01;
      evaluations++;
      while (evaluations < stop) {
        const matrix = hessian.map(row => row.slice());
        for (let i = 0; i < current.length; i++) matrix[i][i] += damping*Math.max(hessian[i][i],1e-8);
        const step = solve(matrix,gradient.map(v => -v));
        if (!step) { damping *= 10; if (damping > 1e14) break; continue; }
        const trial = current.map((v,i) => Math.min(bounds[i][1],Math.max(bounds[i][0],v+step[i])));
        if (Math.max(...trial.map((v,i) => Math.abs(v-current[i]))) < 1e-9) break;
        const [result,nextHessian,nextGradient] = evaluate(trial,x,y,count,loss); evaluations++;
        if (result < score) {
          const improvement = score-result;
          current = trial; score = result; hessian = nextHessian; gradient = nextGradient;
          damping = Math.max(1e-9,damping*.3);
          if (improvement < 1e-11 && Math.max(...step.map(Math.abs)) < 1e-6) break;
        } else { damping *= 5; if (damping > 1e14) break; }
      }
      solutions.push([score,current]);
    }
    solutions.sort((a,b) => a[0]-b[0]);
    const [bestScore,best] = solutions[0], components = [], boundaries = [], names = ["center","FWHM","area","eta"];
    for (let k = 0; k < count; k++) {
      const [center,width,area,eta] = best.slice(4*k,4*k+4);
      const component = {center_deg:low+center*span,fwhm_deg:width*span,area:area*peak*span,eta,boundary_hits:[]};
      component.roi_area = component.area*pseudoVoigtIntegral(low,high,component.center_deg,component.fwhm_deg,eta);
      for (let j = 0; j < 4; j++) {
        const value = best[4*k+j], [a,b] = bounds[4*k+j];
        if (Math.abs(value-a) <= 1e-5*(b-a)) component.boundary_hits.push(`${names[j]}: lower`);
        else if (Math.abs(value-b) <= 1e-5*(b-a)) component.boundary_hits.push(`${names[j]}: upper`);
      }
      components.push(component);
    }
    components.sort((a,b) => a.center_deg-b.center_deg);
    const total = components.reduce((sum,c) => sum+c.area,0), roiTotal = components.reduce((sum,c) => sum+c.roi_area,0);
    components.forEach((component,i) => {
      boundaries.push(...component.boundary_hits.map(hit => `component ${i+1} ${hit}`));
      component.area_fraction = total ? component.area/total : null;
      component.roi_area_fraction = roiTotal ? component.roi_area/roiTotal : null;
      component.weak_intensity_component = component.area_fraction !== null && component.area_fraction < .15;
      const sine = Math.sin((component.center_deg-offset)/2*Math.PI/180), is00l = hkl[0] === 0 && hkl[1] === 0;
      component.d_angstrom = wavelength/(2*sine);
      component.c_00l_angstrom = is00l ? Math.abs(hkl[2])*component.d_angstrom : null;
      component.d_reference_angstrom = reference ? reference.d_angstrom*Math.sin((reference.center_deg-offset)/2*Math.PI/180)/sine : null;
      component.c_00l_reference_angstrom = reference && is00l ? Math.abs(hkl[2])*component.d_reference_angstrom : null;
    });
    const baseline = {left:best[best.length-2]*peak,right:best[best.length-1]*peak};
    ["left","right"].forEach((name,i) => {
      const value = best[best.length-2+i];
      if (value <= 1e-5) boundaries.push(`baseline ${name}: lower`);
      else if (value >= 1-1e-5) boundaries.push(`baseline ${name}: upper`);
    });
    const predicted = grid.map((a,i) => baseline.left*(1-x[i])+baseline.right*x[i]
      +components.reduce((sum,c) => sum+c.area*pseudoVoigt(a,c.center_deg,c.fwhm_deg,c.eta),0));
    const residuals = predicted.map((a,i) => a-observed[i]);
    const logRmse = Math.sqrt(predicted.reduce((sum,a,i) => sum+(Math.log10(Math.max(a/peak,1e-12))-Math.log10(Math.max(observed[i]/peak,1e-12)))**2,0)/grid.length);
    const linearRmse = Math.sqrt(residuals.reduce((sum,v) => sum+v*v,0)/grid.length);
    const softLogRmse = Math.sqrt(predicted.reduce((sum,a,i) => sum+(Math.log10(a/peak+FLOOR)-Math.log10(observed[i]/peak+FLOOR))**2,0)/grid.length);
    const alternatives = []; let different = false;
    for (const [score,vector] of solutions) {
      if (score > bestScore*1.02+1e-6) continue;
      const parts = Array.from({length:count},(_,k) => vector.slice(4*k,4*k+4)).sort((a,b) => a[0]-b[0]);
      const sum = parts.reduce((s,c) => s+c[2],0), fractions = parts.map(c => sum ? c[2]/sum : 0);
      alternatives.push({fit_rmse:score,centers_deg:parts.map(c => low+c[0]*span),area_fractions:fractions});
      if (parts.some((c,i) => Math.abs(low+c[0]*span-components[i].center_deg) > .02*span
          || Math.abs(fractions[i]-(components[i].area_fraction || 0)) > .10)) different = true;
    }
    const warnings = ["Descriptive peak areas are intensity shares, not phase or volume fractions; spatial arrangement and depth are unresolved.",
      "Full-profile area fractions extrapolate beyond the ROI; compare the separately reported ROI area fractions.",
      "This bounded multistart fit does not provide uncertainty intervals or establish a unique decomposition.",
      "Bragg-equivalent spacings assume the supplied wavelength, common zero offset and indexing; they do not identify a crystal phase."];
    if (boundaries.length) warnings.push("The optimum reaches parameter bounds; inspect the ROI and alternative fits.");
    if (different) warnings.push("Similar-scoring starts give materially different centers or area fractions; the decomposition is not unique.");
    if (components.some(c => c.roi_area < .8*c.area)) warnings.push("More than 20% of a component area lies outside the ROI; its full-profile fraction is extrapolation-sensitive.");
    if (components.some(c => c.weak_intensity_component)) warnings.push("A component contributes less than 15% of fitted intensity area; treat it as a weak descriptive feature, not a phase fraction.");
    return {components,baseline,angles:grid,measured:observed,predicted,residuals,roi:[low,high],wavelength,
      angle_offset_deg:offset,peak_count:count,hkl,reference,loss,fit_rmse:bestScore,soft_log_rmse:softLogRmse,soft_log_floor:FLOOR*peak,
      log_rmse:logRmse,linear_rmse:linearRmse,normalized_linear_rmse:linearRmse/peak,evaluations,boundary_hits:boundaries,warnings,
      multistart:{starts:starts.length,near_best_solutions:alternatives,materially_different:different}};
  }
  return {analyzePeaks,pseudoVoigt,pseudoVoigtIntegral};
})();
if (typeof module !== "undefined" && module.exports) module.exports = XRDPeaks;
