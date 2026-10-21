"use strict";

importScripts("xrd_core.js", "xrd_fit.js");

self.onmessage = async ({data: request}) => {
  try {
    const data = await (await fetch("xrd_data.json")).json();
    XRDCore.useData(data);
    XRDFit.useCore(XRDCore);
    const result = XRDFit.fitMeasurement(
      request.measurement.angles, request.measurement.intensities,
      request.parameters, request.fit.range, request.fit.bounds,
      request.fit.max_evaluations,
      {referenceAngles: request.referenceAngles,
       thicknessBoundsNm: request.fit.thickness_bounds_nm,
       onProgress: (evaluations, best) => self.postMessage({type: "progress", evaluations, best})}
    );
    self.postMessage({type: "result", result});
  } catch (error) {
    self.postMessage({type: "error", error: error.message});
  }
};
