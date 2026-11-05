/* A worker owns each immutable request. The UI terminates an obsolete worker
   before replacing it, so an older calculation cannot overwrite a newer CIF. */
importScripts('phase-core.js','rsm-factors.js','rsm-core.js');
self.onmessage = function (event) {
  const {id,state} = event.data;
  try {
    const start = performance.now(), result = RsmCore.simulate(state);
    result.elapsedMs = performance.now() - start;
    self.postMessage({id,result}, [result.total.buffer,result.substrate.buffer,result.film.buffer]);
  } catch (error) { self.postMessage({id,error:error.message || String(error)}); }
};
