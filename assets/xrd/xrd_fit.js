/* The bounded fit, in the browser.

   A port of xrd_fit.py: same objective, same bounds handling, same search
   (Latin-hypercube seeding → differential evolution → pattern search), same
   diagnostics. test_fit_parity.py runs both on the same measurement and
   checks that the fitted parameters agree to a physically irrelevant margin.

   One deliberate difference: the random stream. CPython's Mersenne Twister
   with its sample/shuffle semantics would have to be re-implemented exactly to
   match draw for draw, and a subtle error there would diverge silently. This
   uses its own seeded generator instead — deterministic, so the same input
   always gives the same answer in the browser, just not the same sequence of
   trial points as the desktop. The parity test is what guards the result. */
"use strict";

const XRDFit = (() => {
  const FITTABLE = new Set(["film_lattice_a", "film_planes", "angle_offset_deg",
                            "fwhm_deg", "substrate_planes", "background",
                            "film_lattice_gradient_a"]);
  const INTEGER = new Set(["film_planes", "substrate_planes"]);
  const MAX_FIT_POINTS = 1400;
  const MAX_REFERENCE_POINTS = 3001;
  const ORDER = ["film_lattice_a", "film_planes", "film_lattice_gradient_a",
                 "angle_offset_deg", "fwhm_deg", "substrate_planes", "background"];

  let Core = null;
  function useCore(core) { Core = core; }

  /* Deterministic generator: same seed, same sequence, every run. */
  function makeRng(seed) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
      random: next,
      randrange: (n) => Math.min(n - 1, Math.floor(next() * n)),
      uniform: (a, b) => a + next() * (b - a),
      shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
          const j = Math.min(i, Math.floor(next() * (i + 1)));
          [array[i], array[j]] = [array[j], array[i]];
        }
      },
      sample(items, count) {
        const pool = Array.from(items);
        const picked = [];
        for (let i = 0; i < count; i++) {
          const index = Math.min(pool.length - 1, Math.floor(next() * pool.length));
          picked.push(pool[index]);
          pool[index] = pool[pool.length - 1];
          pool.pop();
        }
        return picked;
      },
    };
  }

  const bisectLeft = (array, value) => {
    let lo = 0, hi = array.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (array[mid] < value) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const median = (values) => {
    const sorted = Array.from(values).sort((a, b) => a - b);
    const n = sorted.length;
    if (!n) return null;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  };
  const argmax = (values, first, last) => {
    let best = first;
    for (let i = first + 1; i < last; i++) if (values[i] > values[best]) best = i;
    return best;
  };
  const argmin = (values, first, last) => {
    let best = first;
    for (let i = first + 1; i < last; i++) if (values[i] < values[best]) best = i;
    return best;
  };

  function curve(angles, intensities, [low, high]) {
    if (angles.length !== intensities.length || angles.length < 3) {
      throw new Error("Measurement needs at least three angle/intensity pairs");
    }
    const fullX = [], fullY = [], selectedX = [], selectedY = [];
    let previous = -Infinity;
    for (let i = 0; i < angles.length; i++) {
      const x = angles[i], y = intensities[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Measurement values must be finite");
      if (!(x > 0 && x < 180) || x <= previous) {
        throw new Error("Measurement angles must increase strictly within 0–180°");
      }
      if (y < 0) throw new Error("Measurement intensity must be nonnegative");
      previous = x;
      fullX.push(x); fullY.push(y);
      if (x >= low && x <= high) { selectedX.push(x); selectedY.push(y); }
    }
    if (selectedX.length < 3) throw new Error("The fit range must contain at least three measurement points");
    if (!selectedY.some((y) => y > 0)) throw new Error("The fit range contains no positive measured intensity");
    if (selectedX.length <= MAX_FIT_POINTS) return [fullX, fullY, selectedX, selectedY];

    const n = selectedX.length;
    const chosen = new Set();
    for (let i = 0; i < 960; i++) chosen.add(Math.round((i * (n - 1)) / 959));
    for (let bin = 0; bin < 200; bin++) {
      const first = Math.floor((bin * n) / 200);
      const last = Math.floor(((bin + 1) * n) / 200);
      if (first >= last) continue;
      chosen.add(argmax(selectedY, first, last));
      chosen.add(argmin(selectedY, first, last));
    }
    const peakIndex = argmax(selectedY, 0, n);
    const half = selectedY[peakIndex] * 0.5;
    let left = peakIndex;
    while (left && selectedY[left - 1] >= half) left--;
    let right = peakIndex;
    while (right < n - 1 && selectedY[right + 1] >= half) right++;
    for (const index of [peakIndex, left, right]) {
      for (let i = Math.max(0, index - 2); i < Math.min(n, index + 3); i++) chosen.add(i);
    }
    const indices = Array.from(chosen).sort((a, b) => a - b);
    return [fullX, fullY, indices.map((i) => selectedX[i]), indices.map((i) => selectedY[i])];
  }

  function referenceGrid(fullX, fullY, fittedX, supplied) {
    let reference, source;
    if (supplied) {
      source = Array.from(supplied);
      if (!(source.length >= 3 && source.length <= 1000000)) {
        throw new Error("reference_angles must contain 3–1,000,000 points");
      }
      if (source.length <= MAX_REFERENCE_POINTS) {
        reference = source;
      } else {
        const n = source.length;
        const chosen = new Set();
        for (const x of fittedX) {
          const right = bisectLeft(source, x);
          chosen.add(Math.min(right, n - 1));
          if (right === n || source[right] !== x) chosen.add(Math.max(0, right - 1));
        }
        const uniformCount = Math.max(2, MAX_REFERENCE_POINTS - 6 - chosen.size);
        for (let i = 0; i < uniformCount; i++) chosen.add(Math.round((i * (n - 1)) / (uniformCount - 1)));
        reference = Array.from(chosen).sort((a, b) => a - b).map((i) => source[i]);
      }
    } else if (fullX.length <= MAX_REFERENCE_POINTS) {
      reference = fullX; source = fullX;
    } else {
      const n = fullX.length;
      const chosen = new Set();
      for (let i = 0; i < 1180; i++) chosen.add(Math.round((i * (n - 1)) / 1179));
      for (const x of fittedX) chosen.add(bisectLeft(fullX, x));
      for (let bin = 0; bin < 200; bin++) {
        const first = Math.floor((bin * n) / 200);
        const last = Math.floor(((bin + 1) * n) / 200);
        if (first >= last) continue;
        chosen.add(argmax(fullY, first, last));
        chosen.add(argmin(fullY, first, last));
      }
      reference = Array.from(chosen).sort((a, b) => a - b).map((i) => fullX[i]);
      source = fullX;
    }
    if (fittedX[0] < reference[0] || fittedX[fittedX.length - 1] > reference[reference.length - 1]) {
      throw new Error("The fitting reference scan must span all measurement fit points");
    }
    return [reference, source, reference.length < source.length];
  }

  function interpolationPositions(reference, fittedX) {
    return fittedX.map((x) => {
      const right = bisectLeft(reference, x);
      if (right < reference.length && reference[right] === x) return [right, right, 0];
      if (right === 0 || right === reference.length) {
        throw new Error("The fitting reference scan must span all fit points");
      }
      const left = right - 1;
      return [left, right, (x - reference[left]) / (reference[right] - reference[left])];
    });
  }

  function normaliseBounds(raw) {
    const result = {};
    for (const [name, pair] of Object.entries(raw)) {
      if (!FITTABLE.has(name)) throw new Error(`Parameter cannot be fitted: ${name}`);
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error(`${name} bounds must have lower and upper values`);
      let [low, high] = pair.map(Number);
      if (!Number.isFinite(low) || !Number.isFinite(high)) throw new Error(`${name} bounds must be finite`);
      if (low > high) throw new Error(`${name} lower bound must not exceed upper bound`);
      if (INTEGER.has(name)) {
        if (low < 0 || high > 1000000 || Math.ceil(low) > Math.floor(high)) {
          throw new Error(`${name} bounds must contain an integer from 0 to 1,000,000`);
        }
        low = Math.ceil(low); high = Math.floor(high);
      } else if (name === "film_lattice_a" && low <= 0) {
        throw new Error("film_lattice_a bounds must be positive");
      } else if (name === "fwhm_deg" && low < 0) {
        throw new Error("fwhm_deg bounds must be nonnegative");
      } else if (name === "background" && (low < 0 || high >= 1)) {
        throw new Error("background bounds must lie in [0, 1)");
      } else if (name === "film_lattice_gradient_a" && (low < -0.2 || high > 0.2)) {
        throw new Error("film_lattice_gradient_a bounds must lie in [-0.2, 0.2] Å");
      }
      result[name] = [low, high];
    }
    return result;
  }

  const thicknessNm = (params) =>
    (params.film_planes * Core.projectedRepeat(params.film_lattice_a, Core.parseHkl(params.hkl))) / 10;

  function peakFwhm(angles, intensities) {
    if (angles.length < 3 || angles.length !== intensities.length) return null;
    const center = argmax(intensities, 0, intensities.length);
    const half = intensities[center] * 0.5;
    let left = center;
    while (left && intensities[left - 1] >= half) left--;
    let right = center;
    while (right < intensities.length - 1 && intensities[right + 1] >= half) right++;
    if (left === 0 || right === intensities.length - 1) return null;
    const leftCrossing = angles[left - 1] + (angles[left] - angles[left - 1])
      * (half - intensities[left - 1]) / (intensities[left] - intensities[left - 1]);
    const rightCrossing = angles[right] + (angles[right + 1] - angles[right])
      * (half - intensities[right]) / (intensities[right + 1] - intensities[right]);
    const width = rightCrossing - leftCrossing;
    return width > 0 ? width : null;
  }

  function fitMeasurement(measurementAngles, measurementIntensities, initial, fitRange,
                          rawBounds, maxEvaluations = 400, options = {}) {
    const {referenceAngles = null, thicknessBoundsNm = null, onProgress = null,
           shouldStop = null} = options;
    const [low, high] = fitRange;
    if (!(low > 0 && low < high && high < 180)) throw new Error("fit_range must increase within 0–180°");
    if (!Number.isInteger(maxEvaluations) || maxEvaluations < 1 || maxEvaluations > 20000) {
      throw new Error("max_evaluations must be an integer from 1 to 20,000");
    }
    const limits = normaliseBounds(rawBounds);
    let thicknessLimits = null;
    if (thicknessBoundsNm) {
      const [tLow, tHigh] = thicknessBoundsNm.map(Number);
      if (!(tLow >= 0 && tLow < tHigh)) throw new Error("thickness bounds must increase from a nonnegative value");
      thicknessLimits = [tLow, tHigh];
      const [latticeLow, latticeHigh] = limits.film_lattice_a || [initial.film_lattice_a, initial.film_lattice_a];
      const [planesLow, planesHigh] = limits.film_planes || [initial.film_planes, initial.film_planes];
      const repeatPerAngstromNm = Core.projectedRepeat(1, Core.parseHkl(initial.hkl)) / 10;
      const feasibleLow = Math.max(planesLow, Math.ceil(tLow / (latticeHigh * repeatPerAngstromNm) - 1e-10));
      const feasibleHigh = Math.min(planesHigh, Math.floor(tHigh / (latticeLow * repeatPerAngstromNm) + 1e-10));
      if (feasibleLow > feasibleHigh) {
        throw new Error("Thickness bounds cannot be reached within the lattice and repeat-count bounds");
      }
    }

    const [fullAngles, fullMeasured, angles, measured] =
      curve(measurementAngles, measurementIntensities, [low, high]);
    const [reference, sourceReference, referenceDecimated] =
      referenceGrid(fullAngles, fullMeasured, angles, referenceAngles);
    const positions = interpolationPositions(reference, angles);
    const n = angles.length;
    const measuredPeak = Math.max(...measured);
    const measuredPeakFwhm = peakFwhm(angles, measured);
    const measuredPeakAngle = angles[measured.indexOf(measuredPeak)];
    const wingExclusion = measuredPeakFwhm ? Math.max(0.25, 4 * measuredPeakFwhm) : 0.25;
    const leftWingIndices = [], rightWingIndices = [];
    angles.forEach((angle, index) => {
      if (angle < measuredPeakAngle - wingExclusion) leftWingIndices.push(index);
      if (angle > measuredPeakAngle + wingExclusion) rightWingIndices.push(index);
    });
    const measuredLogs = measured.map((y) => Math.log10(Math.max(y / measuredPeak, 1e-12)));
    const peakWeights = measured.map((y) => Math.sqrt(y / measuredPeak));
    const peakWeightTotal = peakWeights.reduce((a, b) => a + b, 0);
    const names = ORDER.filter((name) => limits[name] && limits[name][0] < limits[name][1]);

    const rng = makeRng(0x585244);
    let evaluations = 0;
    const runningBest = {score: Infinity};
    const cache = new Map();
    const keyOf = (params) => ORDER.concat(["hkl", "film_material", "substrate_material",
      "wavelength", "substrate_lattice_a", "substrate_lattice_c"])
      .map((field) => params[field]).join("|");

    function candidate(values) {
      const changes = Object.assign({}, initial);
      names.forEach((name, coord) => {
        const [lo, hi] = limits[name];
        const adjusted = Math.min(hi, Math.max(lo, values[coord]));
        changes[name] = INTEGER.has(name) ? Math.floor(adjusted + 0.5) : adjusted;
      });
      for (const [name, [lo, hi]] of Object.entries(limits)) {
        if (lo === hi) changes[name] = INTEGER.has(name) ? Math.round(lo) : lo;
      }
      if (thicknessLimits) {
        const repeat = Core.projectedRepeat(changes.film_lattice_a, Core.parseHkl(changes.hkl)) / 10;
        const planes = changes.film_planes;
        const thickness = planes * repeat;
        if (thickness < thicknessLimits[0] || thickness > thicknessLimits[1]) {
          const clamped = Math.min(thicknessLimits[1], Math.max(thicknessLimits[0], thickness));
          let target = Math.round(clamped / repeat);
          const [pLo, pHi] = limits.film_planes || [planes, planes];
          target = Math.min(pHi, Math.max(pLo, target));
          if (target * repeat < thicknessLimits[0] - 1e-12) target += 1;
          if (target * repeat > thicknessLimits[1] + 1e-12) target -= 1;
          changes.film_planes = Math.min(pHi, Math.max(pLo, target));
        }
      }
      return changes;
    }

    function score(params) {
      const key = keyOf(params);
      const hit = cache.get(key);
      if (hit) return hit[0];
      if (evaluations >= maxEvaluations) return Infinity;
      if (shouldStop && shouldStop()) { const error = new Error("Fit cancelled"); error.cancelled = true; throw error; }
      evaluations += 1;
      if (onProgress && evaluations % 4 === 0) onProgress(evaluations, runningBest.score);
      let result = Infinity, rawRmse = Infinity;
      let fittedPeakFwhm = null, peakCenterGap = null, leftWingBias = null, rightWingBias = null;
      try {
        let trialReference = reference, trialPositions = positions;
        if (referenceDecimated) {
          const added = new Set();
          for (const latticeA of [params.film_lattice_a, params.substrate_lattice_a]) {
            let peakAngle;
            try { peakAngle = Core.braggAngle(latticeA, params.hkl, params.wavelength) + params.angle_offset_deg; }
            catch (error) { continue; }
            const index = bisectLeft(sourceReference, peakAngle);
            for (const neighbour of [index - 1, index, index + 1]) {
              if (neighbour >= 0 && neighbour < sourceReference.length) added.add(sourceReference[neighbour]);
            }
          }
          if (added.size) {
            trialReference = Array.from(new Set(reference.concat(Array.from(added)))).sort((a, b) => a - b);
            trialPositions = interpolationPositions(trialReference, angles);
          }
        }
        const simulated = Core.simulate(trialReference, params);
        const fitted = trialPositions.map(([left, right, weight]) =>
          simulated[left] + weight * (simulated[right] - simulated[left]));
        const peak = Math.max(...fitted);
        if (!Number.isFinite(peak) || peak <= 0) throw new Error("No simulated peak");
        const modeledLogs = fitted.map((value) => Math.log10(Math.max(value / peak, 1e-12)));
        const logBiases = modeledLogs.map((value, index) => value - measuredLogs[index]);
        const residualsSquared = logBiases.map((value) => value * value);
        const globalMse = residualsSquared.reduce((a, b) => a + b, 0) / n;
        let weighted = 0;
        for (let i = 0; i < n; i++) weighted += peakWeights[i] * residualsSquared[i];
        const peakMse = weighted / peakWeightTotal;
        rawRmse = Math.sqrt(globalMse);
        fittedPeakFwhm = peakFwhm(angles, fitted);
        peakCenterGap = angles[fitted.indexOf(peak)] - measuredPeakAngle;
        leftWingBias = leftWingIndices.length ? median(leftWingIndices.map((i) => logBiases[i])) : null;
        rightWingBias = rightWingIndices.length ? median(rightWingIndices.map((i) => logBiases[i])) : null;
        let widthMse = 0;
        if (names.includes("fwhm_deg") && measuredPeakFwhm !== null) {
          widthMse = (fittedPeakFwhm === null || fittedPeakFwhm <= 0)
            ? 1 : Math.pow(Math.log10(fittedPeakFwhm / measuredPeakFwhm), 2);
        }
        result = Math.sqrt(0.35 * globalMse + 0.65 * peakMse + 20 * widthMse);
        if (!Number.isFinite(result) || !Number.isFinite(rawRmse)) { result = Infinity; rawRmse = Infinity; }
      } catch (error) {
        if (error.cancelled) throw error;
        result = Infinity; rawRmse = Infinity;
        fittedPeakFwhm = peakCenterGap = leftWingBias = rightWingBias = null;
      }
      cache.set(key, [result, rawRmse, fittedPeakFwhm, peakCenterGap, leftWingBias, rightWingBias]);
      return result;
    }

    const initialScore = score(initial);
    let bestParams = initial;
    let bestScore = Object.keys(limits).length ? Infinity : initialScore;

    const vector = (params) => names.map((name) => Number(params[name]));
    const clipped = (values) => values.map((value, coord) => {
      const [lo, hi] = limits[names[coord]];
      return Math.min(hi, Math.max(lo, value));
    });
    function consider(values) {
      let params;
      try { params = candidate(values); } catch (error) { return Infinity; }
      const value = score(params);
      if (value < bestScore) { bestScore = value; bestParams = params; runningBest.score = value; }
      return value;
    }

    if (names.length) {
      const seeds = [clipped(vector(initial))];
      if (names.includes("angle_offset_deg")) {
        for (const latticeA of [initial.substrate_lattice_a, initial.film_lattice_a]) {
          let offset;
          try { offset = measuredPeakAngle - Core.braggAngle(latticeA, initial.hkl, initial.wavelength); }
          catch (error) { continue; }
          const aligned = vector(initial);
          aligned[names.indexOf("angle_offset_deg")] = offset;
          seeds.push(clipped(aligned));
        }
      }
      const dimension = names.length;
      const populationSize = Math.min(Math.max(12, 8 * dimension),
                                      Math.max(4, Math.floor(maxEvaluations / 3)));
      const population = [];
      const seen = new Set();
      for (const seed of seeds) {
        const key = seed.join("|");
        if (!seen.has(key) && population.length < populationSize) { population.push(seed); seen.add(key); }
      }
      const permutations = [];
      for (let i = 0; i < dimension; i++) {
        permutations.push(rng.sample([...Array(populationSize).keys()], populationSize));
      }
      const needed = populationSize - population.length;
      for (let index = 0; index < needed; index++) {
        const trial = names.map((name, coord) => {
          const [lo, hi] = limits[name];
          const fraction = (permutations[coord][index] + rng.random()) / populationSize;
          return lo + fraction * (hi - lo);
        });
        population.push(trial);
      }
      const scores = population.map((item) => consider(item));

      const globalLimit = Math.max(evaluations, Math.floor(maxEvaluations * 0.66));
      while (evaluations < globalLimit && population.length >= 4) {
        const spentBefore = evaluations;
        let progress = false;
        const order = [...Array(population.length).keys()];
        rng.shuffle(order);
        for (const index of order) {
          if (evaluations >= globalLimit) break;
          const other = [...Array(population.length).keys()].filter((j) => j !== index);
          const [a, b, c] = rng.sample(other, 3);
          const forced = rng.randrange(dimension);
          const trial = names.map((name, coord) => {
            const [lo, hi] = limits[name];
            let value = population[a][coord] + 0.72 * (population[b][coord] - population[c][coord]);
            if (rng.random() >= 0.85 && coord !== forced) value = population[index][coord];
            return Math.min(hi, Math.max(lo, value));
          });
          const merit = consider(trial);
          if (merit <= scores[index]) {
            progress = progress || merit < scores[index];
            population[index] = trial; scores[index] = merit;
          }
        }
        if (!progress && population.length > 1) {
          const ranked = [...Array(population.length).keys()].sort((x, y) => scores[x] - scores[y]);
          const tail = ranked.slice(Math.floor(ranked.length / 2));
          tail.forEach((index, rank) => {
            if (evaluations >= globalLimit) return;
            const fraction = 0.2 * Math.pow(0.8, rank);
            const trial = names.map((name) => {
              const [lo, hi] = limits[name];
              return Math.min(hi, Math.max(lo, bestParams[name] + rng.uniform(-fraction, fraction) * (hi - lo)));
            });
            population[index] = trial; scores[index] = consider(trial);
          });
        }
        if (evaluations === spentBefore) break;
      }

      if (names.includes("film_planes") && evaluations < maxEvaluations) {
        const planeCoord = names.indexOf("film_planes");
        const center = vector(bestParams);
        for (const factor of [0.5, 2, 1 / 3, 3]) {
          if (evaluations >= maxEvaluations) break;
          const trial = center.slice();
          trial[planeCoord] *= factor;
          consider(trial);
        }
      }

      const step = {};
      for (const name of names) {
        const [lo, hi] = limits[name];
        step[name] = INTEGER.has(name) ? Math.max(1, Math.round((hi - lo) * 0.1)) : (hi - lo) * 0.1;
      }
      while (evaluations < maxEvaluations) {
        let improved = false;
        for (const name of names) {
          if (evaluations >= maxEvaluations) break;
          const amount = step[name];
          if (amount <= 0) continue;
          const center = vector(bestParams);
          const coord = names.indexOf(name);
          for (const direction of [-1, 1]) {
            if (evaluations >= maxEvaluations) break;
            const trial = center.slice();
            trial[coord] += direction * amount;
            const oldBest = bestScore;
            consider(trial);
            improved = improved || bestScore < oldBest;
          }
        }
        if (improved) continue;
        const converged = names.every((name) => {
          const [lo, hi] = limits[name];
          return step[name] <= (INTEGER.has(name) ? 1 : Math.max(1e-7, (hi - lo) * 1e-5));
        });
        if (converged) break;
        let refined = false;
        for (const name of names) {
          const newStep = INTEGER.has(name) ? Math.max(1, Math.trunc(step[name] / 2)) : step[name] * 0.5;
          refined = refined || newStep < step[name];
          step[name] = newStep;
        }
        if (!refined) break;
      }
    }

    if (!Number.isFinite(bestScore)) throw new Error("No valid simulation was found within the fit bounds");
    const boundaryHits = [];
    for (const name of names) {
      const [lo, hi] = limits[name];
      const value = bestParams[name];
      const tolerance = INTEGER.has(name) ? 0 : Math.max(1e-9, (hi - lo) * 1e-4);
      if (Math.abs(value - lo) <= tolerance) boundaryHits.push(`${name}: lower`);
      else if (Math.abs(value - hi) <= tolerance) boundaryHits.push(`${name}: upper`);
    }
    let message = boundaryHits.length
      ? `Best fit reached search bound(s) (${boundaryHits.join(", ")}). Thickness depends on the model and may be limited by the bounds.`
      : "Bounded fit search finished. Thickness depends on the model; inspect residuals.";
    if (referenceDecimated) message += " The reference scan was decimated for fitting; results are approximate.";

    const initialEntry = cache.get(keyOf(initial));
    const bestEntry = cache.get(keyOf(bestParams));
    const initialRawRmse = initialEntry ? initialEntry[1] : Infinity;
    const [, bestRawRmse, bestPeakFwhm, peakCenterGap, leftWingBias, rightWingBias] = bestEntry;
    const improvementFraction = (Number.isFinite(initialScore) && initialScore > 1e-12)
      ? (initialScore - bestScore) / initialScore : null;
    const fixedStoWingExcess = Boolean(
      !names.includes("substrate_planes") && bestParams.substrate_planes > 0
      && leftWingIndices.length >= 10 && rightWingIndices.length >= 10
      && leftWingBias !== null && leftWingBias >= 0.5
      && rightWingBias !== null && rightWingBias >= 0.5
      && peakCenterGap !== null && Math.abs(peakCenterGap) <= 0.1
      && bestRawRmse >= 0.5);
    if (names.includes("fwhm_deg") && measuredPeakFwhm !== null && bestPeakFwhm !== null
        && Math.abs(bestPeakFwhm - measuredPeakFwhm) > 0.15 * measuredPeakFwhm) {
      message += " The modeled main-peak width still differs from the measured width; instrumental FWHM may be confounded with structural broadening.";
    }
    return {
      parameters: bestParams,
      initial_log_rmse: Number.isFinite(initialRawRmse) ? initialRawRmse : null,
      best_log_rmse: bestRawRmse,
      initial_fit_merit: Number.isFinite(initialScore) ? initialScore : null,
      best_fit_merit: bestScore,
      evaluations,
      thickness_nm: thicknessNm(bestParams),
      measured_peak_fwhm_deg: measuredPeakFwhm,
      fitted_peak_fwhm_deg: bestPeakFwhm,
      fit_points: n,
      reference_decimated: referenceDecimated,
      diagnostics: {
        wing_exclusion_deg: wingExclusion,
        left_wing: {point_count: leftWingIndices.length, median_log10_model_over_measured: leftWingBias},
        right_wing: {point_count: rightWingIndices.length, median_log10_model_over_measured: rightWingBias},
        fixed_sto_wing_excess: fixedStoWingExcess,
        peak_center_gap_deg: peakCenterGap,
        fit_merit_improvement_fraction: improvementFraction,
        fit_improved_materially: improvementFraction !== null && improvementFraction >= 0.05,
      },
      message,
    };
  }

  return {useCore, fitMeasurement, peakFwhm, thicknessNm, makeRng};
})();

if (typeof module !== "undefined" && module.exports) module.exports = XRDFit;
