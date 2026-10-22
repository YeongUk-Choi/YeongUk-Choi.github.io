#!/usr/bin/env node
// Integration check using Node's built-in WebSocket and a private headless Chrome.
// No production authentication requests: local config, an allowlist server, and
// CDP interception prohibit requests outside this test's loopback origin.
// Usage: node scripts/test_xrd_gate.mjs --xrd-root ../xrd-studio-gpt [--chrome PATH]
import assert from "node:assert/strict";
import {spawn, execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {mkdtemp, readFile, writeFile, rm, mkdir} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createContext, runInContext} from "node:vm";

const siteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options = process.argv.slice(2);
function option(name, fallback) {
  const i = options.indexOf(name);
  if (i < 0) return fallback;
  if (!options[i + 1]) throw new Error(`Missing value for ${name}`);
  return options[i + 1];
}
for (let i = 0; i < options.length; i += 2) {
  assert(["--xrd-root", "--chrome", "--output", "--analysis-fixtures", "--intensity-fixture"].includes(options[i]), `Unknown argument ${options[i]}`);
  assert(options[i + 1], `Missing value for ${options[i]}`);
}
const xrdRoot = path.resolve(option("--xrd-root", path.join(siteRoot, "../xrd-studio-gpt")));
const analysisFixtures = option("--analysis-fixtures", null);
const intensityFixture = option("--intensity-fixture", null);
const chromePath = option("--chrome", process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const temp = await mkdtemp("/private/tmp/xrd-gate-test-");
const evidence = path.resolve(option("--output", path.join(temp, "evidence")));
await mkdir(evidence, {recursive: true});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const storageName = "xrd-studio-open";
const tests = [], errors = [], network = [], blocked = [], responses = [], cancelledInterceptions = [];
const record = (name, detail) => { tests.push({name, detail}); console.log(`PASS ${name}`); };
let chrome, socket, server, cdp, evaluate, screenshot;

async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(), handlers = new Map();
  let next = 0;
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      if (call) {
        clearTimeout(call.timer); pending.delete(message.id);
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
        else call.resolve(message.result);
      }
    } else {
      for (const handler of handlers.get(message.method) || []) {
        Promise.resolve(handler(message.params)).catch((error) => errors.push(`Harness event: ${error.message}`));
      }
    }
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, {once: true});
    ws.addEventListener("error", reject, {once: true});
  });
  return {socket: ws,
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(handler);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 15000);
        pending.set(id, {resolve, reject, timer, method});
        ws.send(JSON.stringify({id, method, params}));
      });
    },
  };
}

try {
  execFileSync("python3", [path.join(xrdRoot, "scripts/build_web.py"), "--output", path.join(temp, "plain")]);
  const filenames = ["index.html", "en/index.html", "app.js", "en/app.js", "styles.css",
    "xrd_core.js", "xrd_fit.js", "xrd_fringes.js", "xrd_peaks.js", "xrd_intensity.js", "xrd_local.js", "xrd_worker.js", "xrd_data.json", "sample_data.dat", "favicon.svg"];
  const files = Object.fromEntries(await Promise.all(filenames.map(async (name) =>
    [name, await readFile(path.join(temp, "plain", name), "utf8")])));
  for (const filename of filenames) {
    assert.equal(await readFile(path.join(siteRoot, "assets/xrd", filename), "utf8"), files[filename],
      `Published static asset differs from current build: ${filename}`);
  }
  await writeFile(path.join(evidence,"build-manifest.json"),JSON.stringify({
    siteHead:execFileSync("git",["rev-parse","HEAD"],{cwd:siteRoot,encoding:"utf8"}).trim(),
    sourceHead:execFileSync("git",["rev-parse","HEAD"],{cwd:xrdRoot,encoding:"utf8"}).trim(),
    assets:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,{freshBuildSha256:hash(content),shippedSha256:hash(content)}]))
  },null,2));
  record("All fifteen shipped static app files match a fresh source build");
  const wrongCode = "intentionally-wrong-test-code";
  const correctCode = "local-fixture-code-1234";
  const fixture = {enabled: true};
  let authCalls = 0;
  const clock = {now: Date.now()};
  class FixtureDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const properties = new Map([["XRD_CODE", correctCode], ["EDIT_CODE", "fixture-inventory-code"], ["PUSH_CODE", "fixture-push-code"]]);
  const propertyService = {
    getProperty: (name) => properties.get(name) ?? null,
    setProperty: (name, value) => properties.set(name, String(value)),
    deleteProperty: (name) => properties.delete(name),
  };
  const cache = new Map();
  const cacheService = {
    get(name) {
      const entry = cache.get(name);
      if (!entry || entry.expires <= clock.now) { cache.delete(name); return null; }
      return entry.value;
    },
    put: (name, value, seconds) => cache.set(name, {value: String(value), expires: clock.now + seconds * 1000}),
    remove: (name) => cache.delete(name),
  };
  let held = false;
  const lock = {
    waitLock() { assert.equal(held, false, "Script lock acquired twice"); held = true; },
    releaseLock() { assert.equal(held, true, "Unheld script lock released"); held = false; },
  };
  const appsScriptSource = await readFile(path.join(siteRoot, "scripts/apps-script/he-inventory.gs"), "utf8");
  const backend = createContext({
    Date: FixtureDate,
    PropertiesService: {getScriptProperties: () => propertyService},
    CacheService: {getScriptCache: () => cacheService},
    LockService: {getScriptLock: () => lock},
    ContentService: {MimeType: {JSON: "application/json"}, createTextOutput: (value) => ({
      text: String(value), setMimeType() { return this; },
    })},
  });
  runInContext(appsScriptSource, backend, {filename: "he-inventory.gs"});
  const assets = new Map([
    ["/xrd-studio.html", "text/html"], ["/assets/js/xrd-gate.js", "text/javascript"],
    ["/assets/css/xrd-gate.css", "text/css"], ["/assets/img/software/xrd-studio-icon.svg", "image/svg+xml"],
    ["/software.html", "text/html"], ["/assets/js/software.js", "text/javascript"],
    ["/assets/js/site.js", "text/javascript"], ["/assets/css/site.css", "text/css"],
    ["/data/profile.js", "text/javascript"], ["/data/software.js", "text/javascript"],
    ["/assets/img/software/xrd-studio.jpg", "image/jpeg"], ["/assets/img/software/rietveld-auto.jpg", "image/jpeg"],
    ["/assets/img/software/rietveld-auto-icon.svg", "image/svg+xml"], ["/assets/img/qr-site.svg", "image/svg+xml"],
  ]);
  let origin;
  server = createServer(async (request, response) => {
    try {
      const route = new URL(request.url, origin).pathname;
      response.setHeader("Cache-Control", "no-store");
      if (route === "/data/xrd.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(`window.XRD_GATE=${JSON.stringify({enabled: fixture.enabled, apiUrl: `${origin}/test-auth`})};`);
      } else if (route === "/data/ppms.js") {
        response.setHeader("Content-Type", "text/javascript");
        response.end(`window.SITE={ppms:{apiUrl:${JSON.stringify(`${origin}/test-auth`)}}};`);
      } else if (route === "/test-auth") {
        authCalls++;
        assert.equal(request.method, "POST", "Authentication must use POST");
        let body = "";
        for await (const chunk of request) { body += chunk; assert(body.length < 4096); }
        const params = new URLSearchParams(body);
        assert.equal(params.get("action"), "xrdcheck");
        const result = backend.doPost({parameter: Object.fromEntries(params),
          postData: {contents: body, type: "application/x-www-form-urlencoded"}});
        const value = JSON.parse(result.text);
        assert.equal(held, false, "Authentication must release its script lock");
        assert.deepEqual(Object.keys(value).sort(), value.ok ? ["ok"] : ["error", "ok"]);
        responses.push({route, ok: value.ok, properties: Object.keys(value), error: value.error});
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      } else if (route.startsWith("/assets/xrd/")) {
        let name = route.slice("/assets/xrd/".length);
        if (!name || name.endsWith("/")) name += "index.html";
        assert(filenames.includes(name), `Unexpected app file ${name}`);
        const mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css",
          ".json": "application/json", ".svg": "image/svg+xml"}[path.extname(name)] || "text/plain";
        response.setHeader("Content-Type", mime); response.end(files[name]);
      } else if (assets.has(route)) {
        response.setHeader("Content-Type", assets.get(route)); response.end(await readFile(path.join(siteRoot, route)));
      } else if (route === "/favicon.ico") {
        response.writeHead(204); response.end();
      } else {
        errors.push(`Unexpected asset request: ${route}`);
        response.writeHead(404); response.end("Test asset not allowed");
      }
    } catch (error) {
      errors.push(`Fixture server: ${error.message}`); response.writeHead(500); response.end("Test fixture error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;

  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-default-apps",
    "--remote-debugging-port=0", `--user-data-dir=${path.join(temp, "chrome-profile")}`, "about:blank"], {stdio: "ignore"});
  let port;
  for (let attempt = 0; attempt < 80 && !port; attempt++) {
    try { port = Number((await readFile(path.join(temp, "chrome-profile/DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { await delay(100); }
  }
  assert(port, "Chrome did not expose a debugging port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  cdp = await connect(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  socket = cdp.socket;
  cdp.on("Runtime.exceptionThrown", ({exceptionDetails: detail}) => {
    errors.push(detail.exception?.description || detail.text);
  });
  cdp.on("Runtime.consoleAPICalled", ({type, args}) => {
    if (type === "error") errors.push(`console.error: ${args.map((arg) => arg.value || arg.description).join(" ")}`);
  });
  cdp.on("Network.requestWillBeSent", ({request}) => network.push({url: request.url, method: request.method}));
  cdp.on("Fetch.requestPaused", async ({requestId, request}) => {
    if (/^https?:/.test(request.url) && new URL(request.url).origin !== origin) {
      blocked.push(request.url); await cdp.send("Fetch.failRequest", {requestId, errorReason: "BlockedByClient"});
    } else {
      try { await cdp.send("Fetch.continueRequest", {requestId}); }
      catch (error) {
        // terminate() or iframe unload may cancel a paused request before CDP
        // handles continueRequest. Keep this harness race separate from app errors.
        if (error.message === "Fetch.continueRequest: Invalid InterceptionId." &&
            request.url.startsWith(`${origin}/`)) cancelledInterceptions.push(request.url);
        else throw error;
      }
    }
  });
  await Promise.all([cdp.send("Runtime.enable"), cdp.send("Page.enable"), cdp.send("Network.enable")]);
  const mainFrame = (await cdp.send("Page.getFrameTree")).frameTree.frame.id;
  const loaded = new Set();
  let loadCount = 0;
  cdp.on("Page.lifecycleEvent", ({name, frameId, loaderId}) => {
    if (name === "load" && frameId === mainFrame) { loaded.add(loaderId); loadCount++; }
  });
  await cdp.send("Page.setLifecycleEventsEnabled", {enabled: true});
  await cdp.send("Fetch.enable", {patterns: [{urlPattern: "*", requestStage: "Request"}]});
  await cdp.send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  const downloads = path.join(evidence, "downloads");
  await mkdir(downloads, {recursive: true});
  for (const name of ["xrd_simulation.csv", "xrd_studio_project.json"]) {
    await rm(path.join(downloads, name), {force: true});
  }
  await cdp.send("Browser.setDownloadBehavior", {behavior: "allow", downloadPath: downloads});
  evaluate = async (expression) => {
    const value = await cdp.send("Runtime.evaluate", {expression, returnByValue: true, awaitPromise: true, userGesture: true});
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const waitFor = async (expression, label, timeout = 15000) => {
    const end = Date.now() + timeout;
    let lastError;
    while (Date.now() < end) {
      try { if (await evaluate(expression)) return; } catch (error) { lastError = error; }
      await delay(100);
    }
    const status = await evaluate(`document.getElementById("gate-status")?.textContent`);
    throw new Error(`Timed out: ${label}; gate=${status}; ${lastError?.message || ""}`);
  };
  screenshot = async (name) => {
    const {data} = await cdp.send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(path.join(evidence, `${name}.png`), Buffer.from(data, "base64"));
  };
  const navigate = async (route) => {
    const {loaderId} = await cdp.send("Page.navigate", {url: `${origin}${route}`});
    const deadline = Date.now() + 15000;
    while (!loaded.has(loaderId) && Date.now() < deadline) await delay(50);
    assert(loaded.has(loaderId), "New page did not finish loading");
    await waitFor(`document.readyState === "complete"`, "page load");
  };
  const page = async (language = "en") => {
    await navigate(`/xrd-studio.html?lang=${language}`);
    await waitFor(`!!document.getElementById("unlock-form")`, "gate page load");
  };
  const reload = async () => {
    const previous = loadCount;
    await cdp.send("Page.reload", {ignoreCache: true});
    const deadline = Date.now() + 15000;
    while (loadCount === previous && Date.now() < deadline) await delay(50);
    assert(loadCount > previous, "Reload did not finish loading");
  };
  const submit = async (code) => {
    await evaluate(`document.getElementById("access-code").value=${JSON.stringify(code)};
      document.getElementById("unlock-form").dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}));`);
    await waitFor(`!document.getElementById("unlock-button").disabled`, "authentication completes");
  };
  const app = (expression) => `(() => {const f=document.getElementById("studio-frame");
    const d=f?.contentDocument; if (!d) return null; return (${expression});})()`;
  const appReady = () => waitFor(app(`d.getElementById("dataName")?.textContent === "sample_data.dat" &&
    /1,001/.test(d.getElementById("dataMeta")?.textContent) && !d.getElementById("runSimulation")?.disabled`), "app sample and simulation");
  const appClick = (id) => evaluate(app(`d.getElementById(${JSON.stringify(id)}).click()`));
  const sessionPresent = async () => Boolean(await evaluate(`sessionStorage.getItem(${JSON.stringify(storageName)})`));
  const assertLocked = async () => {
    assert.equal(await evaluate(`document.getElementById("workspace").hidden`), true);
    assert.equal(await evaluate(app(`Boolean(d.getElementById("settingsForm"))`)), false);
    assert.equal(await sessionPresent(), false);
  };
  const assertSessionStorage = async () => {
    const data = await evaluate(`({session:Object.entries(sessionStorage),local:Object.entries(localStorage),code:document.getElementById("access-code").value})`);
    assert.deepEqual(data.session, [[storageName, "1"]], "Only a nonsecret open marker should be stored");
    assert.equal(data.local.length, 0, "Persistent localStorage must stay empty");
    assert.equal(data.code, "", "Password input should be cleared");
  };

  fixture.enabled = false;
  await navigate("/software.html");
  await waitFor(`document.querySelectorAll(".sw-card").length === 2`, "software cards");
  assert.equal(await evaluate(`document.querySelectorAll('a[href="xrd-studio.html"]').length`), 0);
  assert.equal(await evaluate(`!!document.querySelector('img[src="assets/img/software/xrd-studio-icon.svg"]').closest("a")`), false);
  record("Disabled configuration hides Software icon launch and page launch button");
  await page("en");
  await evaluate(`document.getElementById("unlock-form").dispatchEvent(new Event("submit", {bubbles:true,cancelable:true}))`);
  await delay(150);
  assert.equal(authCalls, 0); await assertLocked();
  record("Disabled configuration does not call authentication");
  fixture.enabled = true;
  await navigate("/software.html");
  await waitFor(`document.querySelectorAll('a[href="xrd-studio.html"]').length === 2`, "enabled Software launch links");
  assert.equal(await evaluate(`!!document.querySelector('img[src="assets/img/software/xrd-studio-icon.svg"]').closest("a")`), true);
  record("Enabled configuration exposes both Software launch links");
  await page("en");
  assert.equal(await evaluate("document.documentElement.lang"), "en");
  const beforeWrong = network.length;
  await submit(wrongCode);
  assert.equal(responses.at(-1).ok, false); await assertLocked();
  assert(!network.slice(beforeWrong).some(({url}) => url.startsWith(`${origin}/assets/xrd/`)), "Wrong code must not load app");
  assert.match(await evaluate(`document.getElementById("gate-status").textContent`), /wrong|incorrect|invalid/i);
  await screenshot("wrong-code-en");
  record("Wrong password receives only an error and opens no app iframe", {responseProperties: responses.at(-1).properties});
  for (let attempt = 1; attempt < 5; attempt++) await submit(wrongCode);
  await submit(correctCode); await assertLocked();
  assert.match(responses.at(-1).error, /too many|lock/i);
  assert.match(await evaluate(`document.getElementById("gate-status").textContent`), /10/);
  backend.requireCode("fixture-inventory-code");
  backend.requirePushCode("fixture-push-code");
  clock.now += 10 * 60 * 1000 - 1;
  await submit(correctCode); await assertLocked();
  assert.match(responses.at(-1).error, /too many|lock/i);
  clock.now += 1;
  record("Actual Apps Script: five failures block correct code for ten minutes; inventory and push codes remain usable");

  await evaluate(`document.getElementById("gate-language").click()`);
  await waitFor(`document.documentElement.lang === "ko"`, "Korean gate language");
  assert.match(await evaluate(`document.getElementById("unlock-button").textContent`), /[가-힣]/);
  await screenshot("gate-ko");
  await cdp.send("Emulation.setDeviceMetricsOverride", {width: 390, height: 844, deviceScaleFactor: 1, mobile: true});
  assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "Gate must not overflow a mobile viewport");
  await screenshot("gate-ko-mobile");
  await cdp.send("Emulation.setDeviceMetricsOverride", {width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false});
  record("Gate switches between English and Korean");
  await submit(correctCode); await appReady(); await assertSessionStorage();
  assert.equal(await evaluate(app("d.documentElement.lang")), "ko");
  assert.equal(await evaluate(`new URL(document.getElementById("studio-frame").src).pathname`), "/assets/xrd/");
  assert.equal(await evaluate(`document.getElementById("studio-frame").hasAttribute("srcdoc")`), false);
  record("After ten-minute expiry, correct code opens Korean app with 1,001 points and stores only a nonsecret session marker");

  async function fitFlow(language) {
    const before = await evaluate(app(`["film_lattice_a","film_thickness_nm","angle_offset_deg"].map(id=>d.getElementById(id).value)`));
    await appClick("runFit");
    await waitFor(app(`!d.getElementById("cancelFit").hidden && /[1-9][0-9]*\\/400/.test(d.getElementById("fitProgress").textContent)`), `${language} fit progress`, 30000);
    const progress = await evaluate(app(`d.getElementById("fitProgress").textContent`));
    await appClick("cancelFit");
    await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled`), `${language} cancellation`);
    assert.deepEqual(await evaluate(app(`["film_lattice_a","film_thickness_nm","angle_offset_deg"].map(id=>d.getElementById(id).value)`)), before);
    const cancelled = await evaluate(app(`d.getElementById("fitProgress").textContent`));
    assert.match(cancelled, language === "ko" ? /중단/ : /cancel|stop/i);
    await appClick("runFit");
    await waitFor(app(`!d.getElementById("fitResult").hidden && d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled`), `${language} completed refit`, 60000);
    const details = await evaluate(app(`d.getElementById("fitResultDetails").textContent`));
    assert.match(details, /400/);
    if (language === "en") assert(!/[가-힣]/.test(details));
    await screenshot(`fit-${language}`);
    record(`${language}: progress, cancel without parameter changes, complete 400 evaluation refit`, {progress, details});
  }
  await fitFlow("ko");
  async function downloadText(name) {
    const target = path.join(downloads, name);
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { return {target, text: await readFile(target, "utf8")}; } catch { await delay(100); }
    }
    throw new Error(`Download did not finish: ${name}`);
  }
  const newModelDefaults = {film_interface_width:0, film_thickness_sigma:0, film_intensity_scale:1, background_slope:0,
    resolution_halo_fraction:0, resolution_halo_width:3};
  const newModelKeys = Object.keys(newModelDefaults);
  const expectedModes = ["none", "synchrotron_vertical", "synchrotron_horizontal", "lab_unpolarized",
    "synchrotron_vertical_footprint", "synchrotron_horizontal_footprint", "lab_unpolarized_footprint"];
  async function saveCurrentProject(name) {
    await rm(path.join(downloads, "xrd_studio_project.json"), {force: true});
    await appClick("saveProject");
    const download = await downloadText("xrd_studio_project.json");
    const value = JSON.parse(download.text);
    await writeFile(path.join(evidence, `${name}.json`), download.text);
    return value;
  }
  async function loadProjectFixture(value, name, {pending=false}={}) {
    const target = path.join(evidence, `${name}.json`);
    await writeFile(target, JSON.stringify(value, null, 2));
    const input = await cdp.send("Runtime.evaluate", {expression:
      `document.getElementById("studio-frame").contentDocument.getElementById("projectFile")`});
    await cdp.send("DOM.setFileInputFiles", {objectId: input.result.objectId, files: [target]});
    if (pending) {
      await waitFor(app(`f.contentWindow.eval("state.measurementSource?.filename") === ${JSON.stringify(value.measurement_name)} &&
        f.contentWindow.eval("state.intensityPending") && !d.getElementById("runSimulation").disabled &&
        d.getElementById("intensityStatus").classList.contains("error")`), `load pending ${name}`, 30000);
      return;
    }
    await waitFor(app(`d.getElementById("status").textContent.includes(${JSON.stringify(`${name}.json`)}) &&
      !d.getElementById("runSimulation").disabled`), `load ${name}`, 30000);
    assert(!await evaluate(app(`d.getElementById("status").classList.contains("error")`)), `Could not load ${name}`);
  }
  const readNewControls = () => evaluate(app(`({
    values:Object.fromEntries(${JSON.stringify(newModelKeys)}.map(key=>[key,Number(d.getElementById(key).value)])),
    mode:d.getElementById("lp_mode").value,
    enabled:Object.fromEntries(${JSON.stringify(newModelKeys)}.map(key=>[key,d.getElementById("fit_enable_"+key).checked]))
  })`));
  async function cardScreenshot(id, name, mobile=false) {
    if(mobile)await cdp.send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:1,mobile:true});
    const size=await evaluate(app(`(async () => {
      d.documentElement.style.scrollBehavior="auto";
      d.getElementById(${JSON.stringify(id)}).scrollIntoView({block:"start",behavior:"instant"});
      await new Promise(resolve=>f.contentWindow.requestAnimationFrame(resolve));
      return {viewport:f.contentWindow.innerWidth,document:d.documentElement.scrollWidth,top:d.getElementById(${JSON.stringify(id)}).getBoundingClientRect().top};
    })()`));
    assert(size.document<=size.viewport+1,`${id} must not overflow the page horizontally`);
    assert(size.top>=-1&&size.top<100,`${id} must be in the screenshot viewport, top=${size.top}`);
    await screenshot(name);
    if(mobile)await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate(app(`(() => {f.contentWindow.scrollTo(0,0);return true;})()`));
  }
  async function rutileFlow(language, baseline) {
    assert.equal(baseline.model_revision, "rutile-fringe-v1");
    const labels = await evaluate(app(`(() => {
      const material=d.getElementById("film_material"); material.value="VO2";
      material.dispatchEvent(new Event("change",{bubbles:true}));
      const substrate=d.getElementById("substrate_material"); substrate.value="TiO2";
      substrate.dispatchEvent(new Event("change",{bubbles:true}));
      return {parameters:f.contentWindow.eval("readForm")().parameters,
        cVisible:!d.getElementById("filmCField").hidden,
        aDisabled:d.getElementById("fit_enable_film_lattice_a").disabled,
        aChecked:d.getElementById("fit_enable_film_lattice_a").checked,
        cChecked:d.getElementById("fit_enable_film_lattice_c").checked,
        text:d.getElementById("filmNote").textContent+d.getElementById("filmGradientNote").textContent,
        quick:Array.from(d.querySelectorAll("#hklQuick button"),b=>b.textContent),
        thickness:Number(d.getElementById("film_thickness_nm").value)};
    })()`));
    assert.equal(labels.parameters.film_system,"tetragonal");
    assert.equal(labels.parameters.film_basis,"rutile");
    assert.equal(labels.parameters.film_lattice_a,4.5546);
    assert.equal(labels.parameters.film_lattice_c,2.8514);
    assert.equal(labels.parameters.substrate_lattice_a,4.5937);
    assert.equal(labels.parameters.substrate_lattice_c,2.9587);
    assert.equal(labels.parameters.hkl,"002");
    assert(labels.cVisible && labels.aDisabled && !labels.aChecked && labels.cChecked);
    assert.deepEqual(labels.quick,["002","004","110","220"]);
    assert(Math.abs(labels.thickness-labels.parameters.film_planes*2.8514/10)<1e-7);
    assert.match(labels.text,/M1/); assert.match(labels.text,/R/);
    assert.match(labels.text,language==="ko"?/구별할 수 없습니다/:/cannot distinguish/);
    if(language==="en") assert(!/[가-힣]/.test(labels.text));
    await screenshot(`rutile-controls-${language}`);
    record(`${language}: VO2/TiO2 presets select rutile tetragonal geometry, c-only 002 fit and phase caveat`,labels);

    const rules = await evaluate(app(`(() => {
      const set=(value)=>{d.getElementById("hkl").value=value;d.getElementById("hkl").dispatchEvent(new Event("input",{bubbles:true}));};
      set("001"); const absentText=d.getElementById("filmNote").textContent+d.getElementById("substrateNote").textContent;
      set("111"); const allowedText=d.getElementById("filmNote").textContent+d.getElementById("substrateNote").textContent;
      const mixed={a:d.getElementById("fit_enable_film_lattice_a").checked,c:d.getElementById("fit_enable_film_lattice_c").checked};
      set("110"); const hk0={a:d.getElementById("fit_enable_film_lattice_a").checked,c:d.getElementById("fit_enable_film_lattice_c").checked,cDisabled:d.getElementById("fit_enable_film_lattice_c").disabled};
      const repeat=f.contentWindow.eval("filmRepeatNm")({...f.contentWindow.eval("readForm")().parameters,hkl:"1 -1 2"});
      set("002");
      return {absentText,allowedText,mixed,hk0,repeat};
    })()`));
    const absentPattern=language==="ko"?/계통 소멸|격자 소광/:/systematically absent/;
    assert.match(rules.absentText,absentPattern);
    assert(!absentPattern.test(rules.allowedText),"Rutile 111 must not be rejected by a spurious hhl rule");
    assert.deepEqual(rules.mixed,{a:true,c:false});
    assert.deepEqual(rules.hk0,{a:true,c:false,cDisabled:true});
    const expectedRepeat=1/Math.sqrt(2/(4.5546**2)+4/(2.8514**2))/10;
    assert(Math.abs(rules.repeat-expectedRepeat)<1e-14);
    record(`${language}: rutile 001 warns, 111 is allowed, hk0 disables c, and signed mixed hkl uses full metric`);

    const synthetic = await evaluate(app(`(() => {
      const core=f.contentWindow.eval("XRDCore");
      const parameters={...core.DEFAULTS,film_material:"VO2",film_system:"tetragonal",film_basis:"rutile",
        substrate_material:"TiO2",film_lattice_a:4.5546,film_lattice_c:2.8514,
        substrate_lattice_a:4.5937,substrate_lattice_c:2.9587,hkl:"002",wavelength:1.11197,
        film_planes:30,substrate_planes:0,fwhm_deg:0,background:0.001};
      const angles=Array.from({length:161},(_,i)=>44+i*0.025);
      const intensity=core.simulate(angles,parameters); parameters.film_lattice_c=2.88;
      const variables=Object.fromEntries(Array.from(d.querySelectorAll('[data-fit-key]'),row=>{
        const key=row.dataset.fitKey;return [key,{enabled:key==="film_lattice_c",low:key==="film_lattice_c"?2.82:d.getElementById("fit_low_"+key).value,high:key==="film_lattice_c"?2.91:d.getElementById("fit_high_"+key).value}];
      }));
      return {format:"xrd-studio-project-v1",parameters,scan:{xmin:44,xmax:48,step:0.025},
        measurement_name:"synthetic-rutile-c.dat",measurement:{two_theta_deg:angles,intensity_raw:intensity},
        fit_settings:{range:[44,48],variables,thickness_unit:"nm",max_evaluations:400}};
    })()`));
    await loadProjectFixture(synthetic,`rutile-${language}-c-input`);
    await appClick("runFit");
    await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled && !d.getElementById("fitResult").hidden`),`${language} rutile c fit`,60000);
    const fit=await saveCurrentProject(`rutile-${language}-c-fit`);
    assert.deepEqual(Object.keys(fit.fit_result.bounds),["film_lattice_c"]);
    assert.equal(fit.parameters.film_lattice_a,4.5546);
    assert(Math.abs(fit.parameters.film_lattice_c-2.8514)<0.0001);
    assert(Math.abs(fit.fit_result.thickness_nm-fit.parameters.film_planes*fit.parameters.film_lattice_c/10)<1e-10);
    const fitText=await evaluate(app(`d.getElementById("fitLatticeLabel").textContent+d.getElementById("fitGradientLabel").textContent+d.getElementById("fitResult").textContent`));
    assert.match(fitText,/Δc/);if(language==="en")assert(!/[가-힣]/.test(fitText));
    await loadProjectFixture(fit,`rutile-${language}-c-roundtrip`);
    const roundtrip=await saveCurrentProject(`rutile-${language}-c-resaved`);
    assert.deepEqual(roundtrip.parameters,fit.parameters);
    assert.deepEqual(roundtrip.fit_settings.variables.film_lattice_c,fit.fit_settings.variables.film_lattice_c);
    assert.equal(await evaluate(app(`d.getElementById("fitResult").hidden`)),false);
    record(`${language}: browser Worker recovers c with a fixed, uses c for thickness and restores current rutile fit`,{c:fit.parameters.film_lattice_c});

    const geometry = await evaluate(app(`(async () => {
      const p={...f.contentWindow.eval("readForm")().parameters,film_planes:10,substrate_planes:50,fwhm_deg:0,hkl:"1 -1 2",angle_offset_deg:0};
      const expected=2*Math.asin(p.wavelength*Math.sqrt(2/(p.substrate_lattice_a**2)+4/(p.substrate_lattice_c**2))/2)*180/Math.PI;
      const angles=Array.from({length:101},(_,i)=>expected-1+i*0.02);
      const intensities=angles.map(x=>1+Math.exp(-(((x-expected-0.04)/0.08)**2)));
      f.contentWindow.eval("applyConfig")({parameters:p,scan:{xmin:angles[0],xmax:angles.at(-1),step:0.02}});
      f.contentWindow.eval("setMeasurement")({angles,intensities,filename:"alignment.dat"},{adjustScan:false});
      await f.contentWindow.eval("alignObservedAsSto")();
      const offset=Number(d.getElementById("angle_offset_deg").value);
      const observedMarker=f.contentWindow.eval("state.simulation.substratePeak");
      d.getElementById("hkl").value="001";d.getElementById("hkl").dispatchEvent(new Event("input",{bubbles:true}));
      await f.contentWindow.eval("alignObservedAsSto")();
      return {offset,expected,observedMarker,rejected:d.getElementById("status").classList.contains("error"),message:d.getElementById("status").textContent};
    })()`));
    assert(Math.abs(geometry.offset-0.04)<1e-5);
    assert(Math.abs(geometry.observedMarker-(geometry.expected+0.04))<1e-5);
    assert(geometry.rejected); assert.match(geometry.message,language==="ko"?/계통 소멸/:/systematically absent/);
    if(language==="en")assert(!/[가-힣]/.test(geometry.message));
    record(`${language}: TiO2 signed-hkl marker and alignment use tetragonal metric; forbidden 001 cannot align`,geometry);

    const legacy=structuredClone(baseline);delete legacy.fit_result;
    for(const key of ["film_system","film_basis","film_lattice_c"])delete legacy.parameters[key];
    delete legacy.fit_settings.variables.film_lattice_c;
    await loadProjectFixture(legacy,`rutile-${language}-legacy-cubic`);
    const migrated=await saveCurrentProject(`rutile-${language}-legacy-resaved`);
    assert.equal(migrated.parameters.film_system,"cubic");assert.equal(migrated.parameters.film_basis,"perovskite");assert.equal(migrated.parameters.film_lattice_c,0);
    assert.equal(await evaluate(app(`d.getElementById("filmCField").hidden`)),true);
    const oldSelection=await evaluate(app(`(() => {d.getElementById("film_lattice_a").value="4.017";d.getElementById("film_material").value="BaTiO3";d.getElementById("film_material").dispatchEvent(new Event("change",{bubbles:true}));return Number(d.getElementById("film_lattice_a").value);})()`));
    assert.equal(oldSelection,4.017,"Old cubic material choices must not overwrite a with a computational default");
    const zeroC=structuredClone(fit);delete zeroC.fit_result;zeroC.parameters.film_lattice_c=0;zeroC.parameters.hkl="110";
    await loadProjectFixture(zeroC,`rutile-${language}-zero-c`);
    const zeroSaved=await saveCurrentProject(`rutile-${language}-zero-c-resaved`);
    assert.equal(zeroSaved.parameters.film_lattice_c,0);
    record(`${language}: legacy metadata normalizes to cubic, old material selection preserves a, and explicit c=0 round-trips`);
    await loadProjectFixture(baseline,`rutile-${language}-baseline-restore`);
  }


  async function fringeFlow(language, baseline) {
    const fixture = await evaluate(app(`(() => {
      const core=f.contentWindow.eval("XRDCore"), wavelength=1.11197;
      const angles=Array.from({length:401},(_,i)=>40+i*0.01);
      const q=x=>4*Math.PI/wavelength*Math.sin(x*Math.PI/360);
      const origin=q(40.2), intensities=angles.map(x=>1+0.4*Math.cos((q(x)-origin)*500));
      const peaks=Array.from({length:10},(_,i)=>2*Math.asin((origin+i*2*Math.PI/500)*wavelength/(4*Math.PI))*180/Math.PI);
      return {project:{format:"xrd-studio-project-v1",parameters:{...core.DEFAULTS,
        film_lattice_a:4,film_planes:125,substrate_planes:0,fwhm_deg:0,wavelength,hkl:"002"},
        scan:{xmin:40,xmax:44,step:0.01},measurement_name:"synthetic-fringes.dat",
        measurement:{two_theta_deg:angles,intensity_raw:intensities}},peaks};
    })()`));
    await loadProjectFixture(fixture.project,`fringes-${language}-input`);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    assert.match(await evaluate(app(`d.getElementById("fringeStatus").textContent`)),language==="ko"?/아직 추정하지/:/not estimated/i);
    await appClick("fringeUseVisible");
    assert.deepEqual(await evaluate(app(`[Number(d.getElementById("fringe_min").value),Number(d.getElementById("fringe_max").value)]`)),[40,44]);
    await appClick("estimateFringes");
    await waitFor(app(`!d.getElementById("estimateFringes").disabled`),`${language} automatic fringe estimate`);
    const auto=await evaluate(app(`f.contentWindow.eval("state.fringe")`));
    assert.equal(auto?.method,"automatic");assert(Math.abs(auto.thickness_nm-50)<0.5);
    assert(auto.peak_angles.length>=4);assert(auto.relative_scatter<0.12);
    assert.equal(await evaluate(app(`d.getElementById("fringeWarning").hidden`)),true);
    record(`${language}: fringes start unestimated; explicit ROI action estimates synthetic consecutive fringes`,{thickness:auto.thickness_nm,peaks:auto.peak_angles.length,scatter:auto.relative_scatter});
    await setIntensityControls({intensity_decades:9});
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden && !f.contentWindow.eval("state.fringe")`)),true);
    await setIntensityControls({intensity_decades:8});await applyIntensityControls();
    record(`${language}: editing input intensity settings invalidates an existing measured-fringe result until explicit reapplication`);

    const setManual=async peaks=>evaluate(app(`(() => {const input=d.getElementById("fringe_manual_peaks");input.value=${JSON.stringify(peaks.map(v=>v.toFixed(10)).join(", "))};input.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
    const estimate=async()=>{await appClick("estimateFringes");await waitFor(app(`!d.getElementById("estimateFringes").disabled`),`${language} manual fringe estimate`);};
    await setManual(fixture.peaks);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    await estimate();
    const manual=await evaluate(app(`f.contentWindow.eval("state.fringe")`));
    assert.equal(manual.method,"manual");assert(Math.abs(manual.thickness_nm-50)<1e-6);
    assert.deepEqual(manual.orders,Array.from({length:10},(_,i)=>i));assert(manual.angular_residual_rms_deg<1e-8);
    assert.equal(await evaluate(app(`d.querySelector("#fringePeaks tr:nth-child(2) td").textContent`)),"n=0");
    assert.equal(await evaluate(app(`d.getElementById("fringeWarning").hidden`)),true);
    assert.match(await evaluate(app(`d.getElementById("fringeModelLabel").textContent`)),language==="ko"?/환산값/:/converted/i);
    await evaluate(app(`(() => {const t=d.getElementById("film_thickness_nm");t.value="60";t.dispatchEvent(new Event("change",{bubbles:true}));return true;})()`));
    assert.equal(await evaluate(app(`d.getElementById("fringeWarning").hidden`)),false);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),false,"Model-only edits preserve measured fringe estimate");
    const warning=await evaluate(app(`d.getElementById("fringeWarning").textContent`));
    assert.match(warning,/5%/);assert.match(warning,language==="ko"?/신뢰 구간이 아닙니다/:/not a statistical confidence interval/i);
    if(language==="en")assert(!/[가-힣]/.test(await evaluate(app(`d.getElementById("fringeCard").textContent`))));
    await cardScreenshot("fringeCard",`fringes-warning-${language}`);
    record(`${language}: manual q-order thickness is 50 nm, model-only edits keep it, and >5% difference warns without claiming uncertainty`);

    const project=await saveCurrentProject(`fringes-${language}-saved`);
    assert(project.fringe_settings?.manual_peaks);assert.deepEqual(project.fringe_settings.roi,["40","44"]);
    assert.equal(project.fringe_result,undefined);assert.equal(project.fringe_diagnostic,undefined);
    await loadProjectFixture(project,`fringes-${language}-roundtrip`);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true,"Project load must not reuse an old fringe result");
    assert.equal(await evaluate(app(`d.getElementById("fringe_manual_peaks").value`)),project.fringe_settings.manual_peaks);
    await estimate();
    for(const [key,value] of [["wavelength","1.112"],["angle_offset_deg","0.001"],["fringe_min","40.01"]]){
      await evaluate(app(`(() => {const n=d.getElementById(${JSON.stringify(key)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
      assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true,`${key} must invalidate fringe diagnostic`);
      await estimate();
      assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),false);
    }
    record(`${language}: projects preserve only fringe inputs; wavelength, zero offset and ROI edits invalidate and require explicit reevaluation`);

    await setManual([fixture.peaks[0],fixture.peaks[1],fixture.peaks[2],fixture.peaks[5],fixture.peaks[6]]);
    await estimate();
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),false,"Rejected indexing must retain residual and order evidence");
    assert.equal(await evaluate(app(`f.contentWindow.eval("state.fringe")`)),null);
    assert.match(await evaluate(app(`d.getElementById("fringeThickness").textContent`)),language==="ko"?/추정 불가/:/not estimated/i);
    assert.match(await evaluate(app(`d.getElementById("fringeStatus").textContent`)),language==="ko"?/품질 조건/:/quality checks/i);
    assert.match(await evaluate(app(`d.getElementById("fringeAngleResidual").textContent`)),/°/);
    assert.equal(await evaluate(app(`d.getElementById("fringeWarning").hidden`)),true);
    await evaluate(app(`(() => {const n=d.getElementById("fringe_manual_orders");n.value="0, 1, 2, 5, 6";n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
    await estimate();
    const indexed=await evaluate(app(`f.contentWindow.eval("state.fringe")`));
    assert.deepEqual(indexed.orders,[0,1,2,5,6]);assert(Math.abs(indexed.thickness_nm-50)<.02);assert(indexed.angular_residual_rms_deg<.0001);
    const indexedProject=await saveCurrentProject(`fringes-${language}-indexed-saved`);
    assert.equal(indexedProject.fringe_settings.manual_orders,"0, 1, 2, 5, 6");
    await loadProjectFixture(indexedProject,`fringes-${language}-indexed-roundtrip`);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    assert.equal(await evaluate(app(`d.getElementById("fringe_manual_orders").value`)),"0, 1, 2, 5, 6");
    await estimate();assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),false);
    record(`${language}: explicit integer orders recover skipped fringes, report angular RMS and survive input-only save/load`);
    await evaluate(app(`(() => {const n=d.getElementById("fringe_manual_orders");n.value="0, 1, 2.5, 5, 6";n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
    await estimate();assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    assert.equal(await evaluate(app(`d.getElementById("fringeStatus").classList.contains("error")`)),true);
    await evaluate(app(`(() => {const n=d.getElementById("fringe_manual_orders");n.value="";n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
    await setManual(fixture.peaks.slice(0,3));await estimate();
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    assert.equal(await evaluate(app(`d.getElementById("fringeStatus").classList.contains("error")`)),true);
    await evaluate(app(`(() => {
      const angles=Array.from({length:401},(_,i)=>40+i*.01);
      f.contentWindow.eval("setMeasurement")({angles,intensities:angles.map(()=>1),filename:"flat.dat"},{adjustScan:false});return true;
    })()`));
    assert.deepEqual(await evaluate(app(`[d.getElementById("fringe_min").value,d.getElementById("fringe_max").value,d.getElementById("fringe_manual_peaks").value,d.getElementById("fringe_manual_orders").value]`)),["","","",""]);
    await appClick("fringeUseVisible");await estimate();
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden`)),true);
    assert.match(await evaluate(app(`d.getElementById("fringeStatus").textContent`)),language==="ko"?/추정 불가/:/not estimated/i);
    record(`${language}: skipped orders, fewer than four peaks and flat measured data produce no false thickness; new measurement resets inputs`);
    await loadProjectFixture(baseline,`fringes-${language}-baseline-restore`);
  }


  async function peakFlow(language, baseline) {
    const fixture=await evaluate(app(`(() => {
      const core=f.contentWindow.eval("XRDCore");
      const angles=Array.from({length:251},(_,i)=>42+i*.01);
      const profile=(x,c,w,eta)=>(1-eta)*Math.sqrt(4*Math.log(2)/Math.PI)/w*Math.exp(-4*Math.log(2)*((x-c)/w)**2)+eta*2/(Math.PI*w)/(1+4*((x-c)/w)**2);
      const intensities=angles.map(x=>3+2*(x-42)/2.5+80*profile(x,43,.12,.2)+8*profile(x,43.38,.18,.3));
      return {format:"xrd-studio-project-v1",parameters:{...core.DEFAULTS,hkl:"002",wavelength:1.11197,film_planes:20,substrate_planes:0,fwhm_deg:0},scan:{xmin:42,xmax:44.5,step:.01},measurement_name:"synthetic-peak-shapes.dat",measurement:{two_theta_deg:angles,intensity_raw:intensities}};
    })()`));
    await loadProjectFixture(fixture,`peaks-${language}-input`);
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);
    assert.match(await evaluate(app(`d.getElementById("peakStatus").textContent`)),language==="ko"?/아직 분석하지/:/not analyzed/i);
    await appClick("peakUseVisible");
    assert.deepEqual(await evaluate(app(`[Number(d.getElementById("peak_min").value),Number(d.getElementById("peak_max").value)]`)),[42,44.5]);
    const before=await evaluate(app(`f.contentWindow.eval("readForm")()`));
    const fit=async()=>{await appClick("fitPeaks");await waitFor(app(`!d.getElementById("fitPeaks").disabled`),`${language} descriptive peaks`,60000);assert(!await evaluate(app(`d.getElementById("peakStatus").classList.contains("error")`)));};
    await fit();
    const result=await evaluate(app(`f.contentWindow.eval("state.peakAnalysis")`));
    assert.equal(result.soft_log.loss,"soft_log");assert.equal(result.linear.loss,"linear");
    for(const item of [result.soft_log,result.linear]) {
      assert.equal(item.peak_count,2);assert.deepEqual(item.roi,[42,44.5]);assert(item.evaluations>0&&item.evaluations<=2000);
      for(const [i,target] of [43,43.38].entries())assert(Math.abs(item.components[i].center_deg-target)<.02);
      assert(item.components[1].area_fraction<.15);
      for(const c of item.components)assert(Math.abs(c.c_00l_angstrom-2*c.d_angstrom)<1e-12);
    }
    assert.deepEqual(await evaluate(app(`f.contentWindow.eval("readForm")()`)),before,"Descriptive analysis must not transfer values to physical simulation");
    assert.equal(await evaluate(app(`d.querySelectorAll("#peakPlot path").length`)),3);
    assert.equal(await evaluate(app(`d.querySelectorAll("#peakComparison tr").length`)),2);
    const text=await evaluate(app(`d.getElementById("peakCard").textContent`));
    assert.match(text,language==="ko"?/약하게 결정된 성분/:/weakly determined component/i);
    assert(!text.includes(language==="ko"?"검출됨":"Detected ·"));
    if(language==="en")assert(!/[가-힣]/.test(text));
    await cardScreenshot("peakCard",`peak-decomposition-${language}`);
    await cardScreenshot("peakCard",`peak-decomposition-${language}-mobile`,true);
    record(`${language}: explicit two-profile ROI fits both losses, compares centers/areas, previews both curves and leaves physical simulation unchanged`,{soft:result.soft_log.components,linear:result.linear.components});
    await setIntensityControls({negative_policy:"clip"});
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden && !f.contentWindow.eval("state.peakAnalysis")`)),true);
    await setIntensityControls({negative_policy:"reject"});await applyIntensityControls();
    record(`${language}: editing input intensity settings invalidates existing descriptive peak fits until explicit reapplication`);

    await evaluate(app(`(() => {for(const [id,value] of [["peak_reference_center","44"],["peak_reference_d","1.48"]]){const n=d.getElementById(id);n.value=value;n.dispatchEvent(new Event("input",{bubbles:true}));}return true;})()`));
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);await fit();
    const reference=await evaluate(app(`f.contentWindow.eval("state.peakAnalysis.soft_log")`));
    for(const c of reference.components){const expected=1.48*Math.sin(44*Math.PI/360)/Math.sin(c.center_deg*Math.PI/360);assert(Math.abs(c.d_reference_angstrom-expected)<1e-12);assert(Math.abs(c.c_00l_reference_angstrom-2*expected)<1e-12);}
    assert.equal(await evaluate(app(`d.getElementById("peakReferenceDHeader").hidden`)),false);
    const saved=await saveCurrentProject(`peaks-${language}-saved`);
    assert.equal(saved.peak_settings.reference_center,"44");assert.equal(saved.peak_settings.reference_d,"1.48");assert.equal(saved.peak_result,undefined);assert.equal(saved.peak_analysis,undefined);
    await loadProjectFixture(saved,`peaks-${language}-roundtrip`);
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);
    assert.equal(await evaluate(app(`d.getElementById("peak_reference_center").value`)),"44");
    record(`${language}: optional verified-reference conversion is separate; project saves only diagnostic inputs`);

    await evaluate(app(`(() => {const n=d.getElementById("peak_count");n.value="1";n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));await fit();
    const single=await evaluate(app(`f.contentWindow.eval("state.peakAnalysis")`));
    assert.equal(single.soft_log.components.length,1);assert.equal(single.linear.components.length,1);
    assert(single.soft_log.soft_log_rmse>result.soft_log.soft_log_rmse);
    await evaluate(app(`(() => {const n=d.getElementById("hkl");n.value="110";n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);await fit();
    const mixed=await evaluate(app(`f.contentWindow.eval("state.peakAnalysis.soft_log.components")`));assert.equal(mixed[0].c_00l_angstrom,null);assert.equal(mixed[0].c_00l_reference_angstrom,null);
    for(const [key,value] of [["wavelength","1.112"],["angle_offset_deg","0.001"],["peak_min","42.01"]]) {
      await evaluate(app(`(() => {const n=d.getElementById(${JSON.stringify(key)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event("input",{bubbles:true}));return true;})()`));
      assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);await fit();
    }
    await evaluate(app(`(() => {const m=f.contentWindow.eval("state.measurement");f.contentWindow.eval("setMeasurement")(m,{adjustScan:false});return true;})()`));
    assert.equal(await evaluate(app(`d.getElementById("peakResult").hidden`)),true);
    assert.deepEqual(await evaluate(app(`[d.getElementById("peak_min").value,d.getElementById("peak_max").value,d.getElementById("peak_reference_center").value,d.getElementById("peak_reference_d").value,d.getElementById("peak_count").value]`)),["","","","","2"]);
    record(`${language}: one-profile comparison works; non-00l omits c, and calibration, ROI, indexing and new data invalidate peak results`);
    await loadProjectFixture(baseline,`peaks-${language}-baseline-restore`);
  }

  async function setIntensityControls(settings) {
    await evaluate(app(`(() => {for(const [id,value] of Object.entries(${JSON.stringify(settings)})) {
      const node=d.getElementById(id);node.value=String(value);node.dispatchEvent(new Event("input",{bubbles:true}));
    }return true;})()`));
  }
  async function applyIntensityControls({valid=true}={}) {
    await appClick("applyIntensity");
    await waitFor(app(valid ? `!!f.contentWindow.eval("state.measurement") && !d.getElementById("runSimulation").disabled` :
      `!f.contentWindow.eval("state.measurement") && d.getElementById("intensityStatus").classList.contains("error")`),
      `intensity conversion ${valid ? "accepted" : "rejected"}`,30000);
  }
  async function uploadIntensityFile(text,name,{valid=true}={}) {
    const target=path.join(evidence,name);await writeFile(target,text);
    const input=await cdp.send("Runtime.evaluate",{expression:`document.getElementById("studio-frame").contentDocument.getElementById("dataFile")`});
    await cdp.send("DOM.setFileInputFiles",{objectId:input.result.objectId,files:[target]});
    await waitFor(app(`f.contentWindow.eval("state.measurementSource?.filename")===${JSON.stringify(name)} &&
      ${valid ? `!!f.contentWindow.eval("state.measurement") && !d.getElementById("runSimulation").disabled` :
      `!f.contentWindow.eval("state.measurement") && d.getElementById("intensityStatus").classList.contains("error")`}`),`upload ${name}`,30000);
  }
  async function intensitySnapshot() {
    return evaluate(app(`({source:f.contentWindow.eval("state.measurementSource"),measurement:f.contentWindow.eval("state.measurement"),
      pending:f.contentWindow.eval("state.intensityPending"),settings:f.contentWindow.eval("readIntensitySettings")(),
      summary:d.getElementById("intensitySummary").textContent,hint:!d.getElementById("intensityHint").hidden,
      disabled:["runFit","estimateFringes","fitPeaks"].map(id=>d.getElementById(id).disabled),
      resultHidden:["fitResult","fringeResult","peakResult"].map(id=>d.getElementById(id).hidden)})`));
  }
  function assertArrayClose(actual,expected,label) {
    assert.equal(actual.length,expected.length,label);
    actual.forEach((value,i)=>assert(Number.isFinite(value)&&Math.abs(value-expected[i])<=1e-12*Math.max(1,Math.abs(expected[i])),`${label} at ${i}: ${value} vs ${expected[i]}`));
  }
  async function intensityFlow(language,baseline) {
    const defaults={intensity_scale:"linear",intensity_decades:8,negative_policy:"reject"};
    assert.deepEqual((await intensitySnapshot()).settings,defaults);
    const labels=await evaluate(app(`d.getElementById("intensity_scale").closest("section").textContent`));
    assert.match(labels,language==="ko"?/원본/:/original|raw/i);
    if(language==="en")assert(!/[가-힣]/.test(labels),"English intensity controls must be translated");
    const angles=Array.from({length:41},(_,i)=>28+i*.05),raw=angles.map((_,i)=>(i-20)/20);
    const text=raw.map((y,i)=>`${angles[i]} ${y}`).join("\n");
    await uploadIntensityFile(text,`intensity-${language}-signed.dat`,{valid:false});
    let state=await intensitySnapshot();
    assert.deepEqual(state.source.intensities,raw);assert.equal(state.measurement,null);assert(state.pending);
    assert.deepEqual(state.disabled,[true,true,true]);assert.deepEqual(state.resultHidden,[true,true,true]);
    assert.equal(state.settings.intensity_scale,"linear");assert.equal(state.hint,true,"Exact max=1 signed fixture should suggest checking log encoding");
    assert.match(state.summary,language==="ko"?/대기/:/pending/i);
    record(`${language}: signed raw upload remains pending, blocks all analyses and suggests checking log encoding without selecting it`);
    const pending=await saveCurrentProject(`intensity-${language}-pending-saved`);
    assert.equal(pending.measurement,undefined);assert.deepEqual(pending.measurement_source.intensity_raw,raw);
    assert.deepEqual(pending.intensity_settings,defaults);assert.equal(pending.fit_result,undefined);
    await setIntensityControls({negative_policy:"clip"});await applyIntensityControls();
    await loadProjectFixture(pending,`intensity-${language}-pending-roundtrip`,{pending:true});
    assert.deepEqual((await intensitySnapshot()).source.intensities,raw);
    for(const policy of ["clip","shift"]) {
      await setIntensityControls({negative_policy:policy});await applyIntensityControls();state=await intensitySnapshot();
      assertArrayClose(state.measurement.intensities,raw.map(y=>policy==="clip"?Math.max(0,y):y+1),policy);
      assert.deepEqual(state.source.intensities,raw);assert.equal(state.measurement.intensity_transform.shift,policy==="clip"?0:1);
      assert.equal(state.measurement.intensity_transform.negative_count,20);assert(!state.pending);
      assert.match(state.summary,new RegExp(policy));
    }
    record(`${language}: pending project preserves signed raw values; explicit clip and shift use the original source and record their provenance`);
    for(const mode of ["log10","log10_normalized"]) {
      await setIntensityControls({intensity_scale:mode,intensity_decades:8,negative_policy:"clip"});
      assert.equal((await intensitySnapshot()).measurement,null,"Editing conversion settings must invalidate prior linear data");
      await applyIntensityControls();state=await intensitySnapshot();
      const expected=raw.map(y=>10**(y*(mode==="log10"?1:8)));
      assertArrayClose(state.measurement.intensities,expected,mode);assert.deepEqual(state.source.intensities,raw);
      assert.equal(state.measurement.intensity_transform.shift,0,"Log modes must not clip signed exponents");
      const saved=await saveCurrentProject(`intensity-${language}-${mode}-saved`);
      assert.deepEqual(saved.measurement_source.intensity_raw,raw);assertArrayClose(saved.measurement.intensity_raw,expected,"saved linear");
      assert.equal(saved.intensity_settings.intensity_scale,mode);
      await loadProjectFixture(saved,`intensity-${language}-${mode}-roundtrip`);
      assertArrayClose((await intensitySnapshot()).measurement.intensities,expected,"single conversion on reopen");
      const resaved=await saveCurrentProject(`intensity-${language}-${mode}-resaved`);
      assert.deepEqual(resaved.measurement,saved.measurement);assert.deepEqual(resaved.measurement_source,saved.measurement_source);
    }
    assert.equal(await evaluate(app(`d.getElementById("intensityDecadesField").hidden`)),false);
    const modeBefore=(await intensitySnapshot()).settings;
    for(const id of ["linearScale","logScale"]) {await appClick(id);assert.equal(await evaluate(app(`d.getElementById(${JSON.stringify(id)}).getAttribute("aria-pressed")`)),"true");}
    assert.deepEqual((await intensitySnapshot()).settings,modeBefore,"Display scale must not change input conversion");
    await cardScreenshot("data-title",`intensity-${language}-normalized`);
    await cardScreenshot("data-title",`intensity-${language}-normalized-mobile`,true);
    record(`${language}: log10 and normalized log invert exactly once, saved raw/settings round-trip, and display log/linear controls remain independent`);
    for(const decades of ["",0,21]) {
      await setIntensityControls({intensity_decades:decades});await applyIntensityControls({valid:false});
      const rejected=await evaluate(app(`({measurement:f.contentWindow.eval("state.measurement"),disabled:d.getElementById("runFit").disabled,text:d.getElementById("intensityStatus").textContent})`));
      assert.equal(rejected.measurement,null);assert(rejected.disabled);if(language==="en")assert(!/[가-힣]/.test(rejected.text));
    }
    await setIntensityControls({intensity_scale:"log10",intensity_decades:8});
    for(const exponent of [400,-400]) {
      await uploadIntensityFile(angles.map((x,i)=>`${x} ${exponent+i/100}`).join("\n"),`intensity-${language}-${exponent}.dat`,{valid:false});
      assert.deepEqual((await intensitySnapshot()).disabled,[true,true,true]);
    }
    record(`${language}: missing/out-of-range decades and exponential overflow/underflow retain raw data but reject analysis`);
    const legacy=structuredClone(baseline);delete legacy.measurement_source;delete legacy.intensity_settings;delete legacy.intensity_transform;
    await loadProjectFixture(legacy,`intensity-${language}-legacy`);state=await intensitySnapshot();
    assert.deepEqual(state.settings,defaults);assert.deepEqual(state.measurement.intensities,baseline.measurement.intensity_raw);
    assert.deepEqual(state.source.intensities,baseline.measurement.intensity_raw);
    assert.equal(await evaluate(app(`d.getElementById("fitResult").hidden`)),false,"Legacy linear fit remains valid");
    await setIntensityControls({negative_policy:"clip"});
    assert.equal(await evaluate(app(`d.getElementById("fitResult").hidden && !f.contentWindow.eval("state.fitResult")`)),true);
    await loadProjectFixture(legacy,`intensity-${language}-legacy-restored`);
    record(`${language}: legacy projects without intensity metadata load unchanged as linear and retain matching fit scores`);
    // Delay one conversion to reproduce an older project import completing
    // after a newer upload. The production File reader and import path run;
    // only the conversion response timing is controlled by this local test.
    const delayed=structuredClone(baseline);
    delayed.measurement_name=`stale-${language}.dat`;
    delayed.fringe_settings={roi:["28","29"],manual_peaks:"28.1,28.2,28.3,28.4",manual_orders:"0,1,2,3"};
    delayed.peak_settings={roi:["28","29"],peak_count:1,reference_center:"28.5",reference_d:"2"};
    await evaluate(app(`(() => {
      f.contentWindow.__raceOriginal=f.contentWindow.eval("getJson");f.contentWindow.__raceCaptured=false;
      f.contentWindow.eval('getJson=async function(url,options){if(url==="/api/intensity"&&!window.__raceCaptured){window.__raceCaptured=true;await new Promise(resolve=>window.__raceRelease=resolve);}return window.__raceOriginal(url,options);}');
      const file=new f.contentWindow.File([${JSON.stringify(JSON.stringify(delayed))}],"delayed-project.json",{type:"application/json"});
      f.contentWindow.__raceLoad=f.contentWindow.eval("loadProject")(file);
      return true;
    })()`));
    await waitFor(app(`typeof f.contentWindow.__raceRelease==="function"`),`${language} delayed intensity conversion`);
    const replacement=raw.map(y=>y+2);
    await uploadIntensityFile(replacement.map((y,i)=>`${angles[i]} ${y}`).join("\n"),`intensity-${language}-newer.dat`);
    await evaluate(app(`(async()=>{f.contentWindow.__raceRelease();await f.contentWindow.__raceLoad;
      f.contentWindow.eval("getJson=window.__raceOriginal");delete f.contentWindow.__raceOriginal;delete f.contentWindow.__raceRelease;delete f.contentWindow.__raceLoad;return true;})()`));
    state=await intensitySnapshot();assert.deepEqual(state.measurement.intensities,replacement);
    assert.equal(state.source.filename,`intensity-${language}-newer.dat`);assert.deepEqual(state.resultHidden,[true,true,true]);
    assert.deepEqual(await evaluate(app(`["fringe_min","fringe_max","fringe_manual_peaks","peak_min","peak_max","peak_reference_center"].map(id=>d.getElementById(id).value)`)),["","","","","",""]);
    record(`${language}: delayed old project conversion cannot replace a newer upload or restore obsolete diagnostic inputs and fit scores`);
    await loadProjectFixture(legacy,`intensity-${language}-after-race`);
    const beforeInvalid=await intensitySnapshot();
    for(const settings of [null,{...defaults,intensity_scale:null},{...defaults,negative_policy:null},
      {...defaults,intensity_scale:"log10_normalized",intensity_decades:null}]) {
      const invalid={...baseline,intensity_settings:settings};
      await evaluate(app(`(async()=>{const file=new f.contentWindow.File([${JSON.stringify(JSON.stringify(invalid))}],"invalid-intensity-settings.json",{type:"application/json"});
        await f.contentWindow.eval("loadProject")(file);return true;})()`));
      assert.equal(await evaluate(app(`d.getElementById("status").classList.contains("error")`)),true,"Explicit null intensity settings must be rejected, not defaulted");
      const unchanged=await intensitySnapshot();assert.deepEqual(unchanged.settings,beforeInvalid.settings);
      assert.deepEqual(unchanged.measurement,beforeInvalid.measurement);
      const message=await evaluate(app(`d.getElementById("status").textContent`));
      if(language==="en")assert(!/[가-힣]/.test(message));
    }
    record(`${language}: explicit null project settings, scale, policy and normalized-log decades are rejected without inventing defaults or replacing current data`);
    if(intensityFixture&&language==="ko") {
      const fileText=await readFile(path.resolve(intensityFixture),"utf8");
      await uploadIntensityFile(fileText,"actual-629-signed.txt",{valid:false});state=await intensitySnapshot();
      const source=state.source.intensities;
      assert.equal(source.filter(y=>y<0).length,68);assert.equal(state.hint,true,"Actual maximum 1.00003 is inside the 1e-3 hint tolerance");
      assert.deepEqual(state.disabled,[true,true,true]);assert.equal(state.settings.intensity_scale,"linear");
      await setIntensityControls({intensity_scale:"log10_normalized",intensity_decades:8});await applyIntensityControls();
      state=await intensitySnapshot();assertArrayClose(state.measurement.intensities,source.map(y=>10**(8*y)),"conditional actual 629 conversion");
      assert.deepEqual(state.source.intensities,source);
      await writeFile(path.join(evidence,"actual-629-intensity-browser.json"),JSON.stringify({assumption:"User-selected normalized log, D=8 is a conditional test, not inferred file metadata",points:source.length,negativeCount:68,rawMaximum:Math.max(...source),transform:state.measurement.intensity_transform,summary:state.summary},null,2));
      await cardScreenshot("data-title","actual-629-intensity-mobile",true);
      record("Actual #629: 68 negative raw values remain pending; conditional explicit D8 conversion is finite and leaves source unchanged",{points:source.length,max:Math.max(...source)});
    }
    await loadProjectFixture(baseline,`intensity-${language}-baseline-restore`);
  }

  async function refinementFlow(language, baseline) {
    await intensityFlow(language,baseline);
    await rutileFlow(language, baseline);
    await fringeFlow(language, baseline);
    await peakFlow(language, baseline);
    const labels = await evaluate(app(`({
      modes:Array.from(d.getElementById("lp_mode").options, option=>({value:option.value,label:option.textContent})),
      fields:${JSON.stringify(newModelKeys)}.map(key=>({key,value:d.getElementById(key).value,
        label:d.getElementById(key).closest("label").textContent,
        fitLabel:d.querySelector('[data-fit-key="'+key+'"]').textContent})),
      advanced:{open:d.getElementById("advancedFitVariables").open,
        text:d.getElementById("advancedFitVariables").textContent,
        taperInside:!!d.getElementById("fit_enable_film_interface_width").closest("#advancedFitVariables"),
        taperEnabled:d.getElementById("fit_enable_film_interface_width").checked},
      haloNote:d.getElementById("resolution_halo_fraction").closest("fieldset").textContent
    })`));
    assert.deepEqual(labels.modes.map(({value})=>value).sort(), [...expectedModes].sort());
    for (const field of labels.fields) {
      assert(Number.isFinite(Number(field.value)), `Missing/invalid ${field.key}`);
      assert(field.label.trim() && field.fitLabel.trim(), `Missing labels for ${field.key}`);
    }
    if (language === "en") {
      assert(!/[가-힣]/.test(JSON.stringify(labels)), "New English fields, fit rows and mode options must be translated");
    } else assert(/[가-힣]/.test(JSON.stringify(labels)), "Korean control labels must render");
    assert.equal(labels.advanced.open, false, "Advanced taper options should start collapsed");
    assert.equal(labels.advanced.taperInside, true, "Taper fitting belongs in advanced controls");
    assert.equal(labels.advanced.taperEnabled, false, "Taper fitting must be opt-in");
    assert.match(labels.advanced.text, /SRO\/STO 002/);
    assert.match(labels.haloNote, language === "ko" ? /측정된 기구 함수가 아닙니다/ : /not a measured instrument function/i);
    assert.deepEqual((await readNewControls()).values, newModelDefaults, "New model controls must have neutral defaults");
    for (const [key, min, max] of [["resolution_halo_fraction",0,0.2],["resolution_halo_width",1,20]]) {
      assert.deepEqual(await evaluate(app(`(() => {const n=d.getElementById(${JSON.stringify(key)});return [Number(n.min),Number(n.max)];})()`)), [min,max]);
    }
    record(`${language}: refinement and halo controls have translated labels, neutral defaults and opt-in advanced taper`, labels);

    const convolutionErrors = [
      "Resolution convolution is too large; reduce halo width, FWHM, coherence repeats, or scan points",
      "Resolution halo convolution is too large; reduce halo width, FWHM, coherence repeats, or scan points",
    ];
    const localizedErrors = await evaluate(app(`(() => {
      const explain=f.contentWindow.eval("explainModelError");
      return ${JSON.stringify(convolutionErrors)}.map(message=>explain(new Error(message)));
    })()`));
    localizedErrors.forEach((message, index) => {
      assert.notEqual(message, convolutionErrors[index], "Convolution budget errors must reach the UI explanation");
      assert.match(message, language === "ko" ? /줄이세요/ : /reduce/i);
      if (language === "en") assert(!/[가-힣]/.test(message));
      else assert(/[가-힣]/.test(message));
    });
    record(`${language}: generic and legacy resolution convolution limits show translated recovery guidance`);

    // A broad footprint kernel must not sample the 1/sin(theta) singularity
    // through a clamp and then display a spurious low-angle peak.
    const previousCurve = await evaluate(app(`f.contentWindow.eval("state.simulation.intensities")`));
    await evaluate(app(`(() => {
      const core=f.contentWindow.eval("XRDCore");
      f.contentWindow.eval("applyConfig")({parameters:{...core.DEFAULTS,hkl:"002",wavelength:1.11197,
        film_lattice_a:3.93,film_planes:12,substrate_planes:350,fwhm_deg:1,
        resolution_halo_fraction:0.005,resolution_halo_width:20,
        lp_mode:"synchrotron_horizontal_footprint"},scan:{xmin:28,xmax:38,step:0.01}});
      return true;
    })()`));
    await appClick("runSimulation");
    await waitFor(app(`!d.getElementById("runSimulation").disabled &&
      d.getElementById("status").classList.contains("error")`), `${language} zero-incidence footprint rejection`);
    const footprintMessage = await evaluate(app(`d.getElementById("status").textContent`));
    assert.match(footprintMessage, /2θ=0°/);
    assert.match(footprintMessage, language === "ko" ? /조사 길이.*끄세요/ : /turn off the footprint correction/i);
    if (language === "en") assert(!/[가-힣]/.test(footprintMessage));
    assert.deepEqual(await evaluate(app(`f.contentWindow.eval("state.simulation.intensities")`)), previousCurve,
      "Rejected zero-incidence calculation must not replace the displayed curve");
    record(`${language}: broad footprint reaching zero incidence is rejected with translated guidance and preserves the previous curve`);

    // The 4.5σ -> 10σ correction changes the calculated curve even at f=0.
    // A legacy fit score must not be restored beside that corrected curve.
    assert.equal(typeof baseline.model_revision, "string");
    assert(baseline.model_revision.length > 0, "Saved projects must identify the numerical model revision");
    assert(baseline.fit_result, "Revision regression needs a saved fit result");
    for (const revision of [null, "historical-gaussian-4.5sigma"]) {
      const oldResult = structuredClone(baseline);
      if (revision === null) delete oldResult.model_revision;
      else oldResult.model_revision = revision;
      const name = `refinement-${language}-${revision === null ? "unversioned" : "outdated"}-fit`;
      await loadProjectFixture(oldResult, name);
      assert.equal(await evaluate(app(`d.getElementById("fitResult").hidden`)), true,
        "A saved fit from a different or unknown model must require refitting");
      const message = await evaluate(app(`d.getElementById("fitProgress").textContent`));
      assert.match(message, language === "ko" ? /피팅/ : /refit|fit again/i);
      if (language === "en") assert(!/[가-힣]/.test(message));
      const migrated = await saveCurrentProject(`${name}-resaved`);
      assert.deepEqual(migrated.parameters, baseline.parameters, "Legacy model parameters must remain usable");
      assert.deepEqual(migrated.measurement, baseline.measurement, "Legacy measured data must remain usable");
      assert.equal(migrated.model_revision, baseline.model_revision);
      assert.equal(migrated.fit_result, undefined, "Outdated fit metrics must not be resaved as current");
    }
    await loadProjectFixture(baseline, `refinement-${language}-current-model-fit`);
    assert.equal(await evaluate(app(`d.getElementById("fitResult").hidden`)), false,
      "Matching model revision must restore saved fit metrics");
    assert.equal(await evaluate(app(`d.getElementById("fitError").textContent`)),
      `${baseline.fit_result.initial_log_rmse === null ? "—" : baseline.fit_result.initial_log_rmse.toFixed(3)} → ${baseline.fit_result.best_log_rmse.toFixed(3)}`);
    record(`${language}: legacy or outdated model fits require refitting while matching revisions restore scores and all projects retain data`);

    const chosen = {film_interface_width: 2.25, film_thickness_sigma: 1.5, film_intensity_scale:0.6, background_slope: -0.04,
      resolution_halo_fraction:0.0075, resolution_halo_width:4.5};
    await evaluate(app(`(() => {
      // Round-trip every extension together on a modest integration grid.
      // The separate cancellation case still exercises the expensive model.
      d.getElementById("substrate_planes").value="400";
      d.getElementById("substrate_planes").dispatchEvent(new Event("input",{bubbles:true}));
      for (const [key,value] of Object.entries(${JSON.stringify(chosen)})) {
        d.getElementById(key).value=String(value);
        d.getElementById(key).dispatchEvent(new Event("input",{bubbles:true}));
        d.getElementById("fit_enable_"+key).checked=true;
        d.getElementById("fit_enable_"+key).dispatchEvent(new Event("change",{bubbles:true}));
      }
      d.getElementById("lp_mode").value="synchrotron_horizontal_footprint";
      d.getElementById("lp_mode").dispatchEvent(new Event("change",{bubbles:true}));
      return true;
    })()`));
    const refined = await saveCurrentProject(`refinement-${language}-saved`);
    for (const key of newModelKeys) {
      assert.equal(refined.parameters[key], chosen[key]);
      assert.equal(refined.fit_settings.variables[key].enabled, true);
    }
    assert.equal(refined.parameters.lp_mode, "synchrotron_horizontal_footprint");

    const legacy = structuredClone(baseline);
    for (const key of [...newModelKeys, "lp_mode"]) delete legacy.parameters[key];
    for (const key of newModelKeys) delete legacy.fit_settings.variables[key];
    delete legacy.fit_result;
    await loadProjectFixture(legacy, `refinement-${language}-legacy`);
    const expectedDefaults = {values:newModelDefaults,mode:"none",
      enabled:Object.fromEntries(newModelKeys.map(key=>[key,false]))};
    assert.deepEqual(await readNewControls(), expectedDefaults, "Legacy project must clear previous new values and checked fit controls");
    await loadProjectFixture(refined, `refinement-${language}-roundtrip`);
    assert.deepEqual(await readNewControls(), {values:chosen,mode:"synchrotron_horizontal_footprint",
      enabled:Object.fromEntries(newModelKeys.map(key=>[key,true]))});
    const legacyWithoutFit = structuredClone(legacy);
    delete legacyWithoutFit.fit_settings;
    await loadProjectFixture(legacyWithoutFit, `refinement-${language}-legacy-no-fit-settings`);
    assert.deepEqual(await readNewControls(), expectedDefaults, "Legacy project without fit settings must also clear new controls");
    await loadProjectFixture(refined, `refinement-${language}-roundtrip-again`);
    const resaved = await saveCurrentProject(`refinement-${language}-resaved`);
    for (const key of newModelKeys) {
      assert.equal(resaved.parameters[key], chosen[key]);
      assert.deepEqual(resaved.fit_settings.variables[key], refined.fit_settings.variables[key]);
    }
    assert.equal(resaved.parameters.lp_mode, refined.parameters.lp_mode);
    await screenshot(`refinement-controls-${language}`);
    record(`${language}: new model and fit settings survive save/open; old projects reset all new state with or without fit settings`);

    // Exercise the UI/Worker/serializer path for each opt-in fit variable. These
    // synthetic inputs establish plumbing, not the physics of the user's sample.
    let haloRefitFixture;
    for (const [key, target, bounds, initial] of [
      ["film_interface_width", 1.4, [0,3], 0.3],
      ["film_thickness_sigma", 1.5, [0,3], 0.4],
      ["background_slope", 0.08, [-0.15,0.15], -0.03],
      ["film_intensity_scale", 1.8, [0.1,3], 0.4],
      ["resolution_halo_fraction", 0.015, [0.001,0.03], 0.003],
      ["resolution_halo_width", 3.8, [1.2,6], 1.8],
    ]) {
      const halo = key.startsWith("resolution_halo_");
      const synthetic = await evaluate(app(`(() => {
        const core=f.contentWindow.eval("XRDCore");
        const parameters={...core.DEFAULTS,hkl:"002",wavelength:1.11197,
          film_lattice_a:3.93,film_planes:30,substrate_planes:0,fwhm_deg:0,
          film_lattice_gradient_a:0,film_interface_width:0,film_thickness_sigma:0,
          background:0.001,background_slope:0,lp_mode:"none"};
        if (${halo || key === "film_intensity_scale"}) Object.assign(parameters,{substrate_planes:300,fwhm_deg:0.04,
          background:1e-6,resolution_halo_fraction:0.015,resolution_halo_width:3.8});
        const angles=Array.from({length:201},(_,i)=>31+i*0.02);
        const intensity=core.simulate(angles,{...parameters,[${JSON.stringify(key)}]:${target}});
        parameters[${JSON.stringify(key)}]=${initial};
        const variables=Object.fromEntries(Array.from(d.querySelectorAll('[data-fit-key]'),row=>{
          const name=row.dataset.fitKey;
          return [name,{enabled:name===${JSON.stringify(key)},
            low:name===${JSON.stringify(key)}?${bounds[0]}:d.getElementById("fit_low_"+name).value,
            high:name===${JSON.stringify(key)}?${bounds[1]}:d.getElementById("fit_high_"+name).value}];
        }));
        return {format:"xrd-studio-project-v1",parameters,scan:{xmin:31,xmax:35,step:0.02},
          measurement_name:"synthetic-${key}.dat",measurement:{two_theta_deg:angles,intensity_raw:intensity},
          fit_settings:{range:[31,35],variables,thickness_unit:"nm",max_evaluations:400}};
      })()`));
      if (halo) haloRefitFixture = synthetic;
      await loadProjectFixture(synthetic, `refinement-${language}-${key}-input`);
      await appClick("runFit");
      await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled &&
        !d.getElementById("fitResult").hidden`),
      `${language} ${key} independent fit`, 60000);
      const result = await saveCurrentProject(`refinement-${language}-${key}-fit`);
      assert(result.fit_result, `${key}: fit result must be saved`);
      assert.deepEqual(Object.keys(result.fit_result.bounds), [key], `${key}: only selected fit control should be searched`);
      assert(result.fit_result.evaluations > 0 && result.fit_result.evaluations <= 400);
      assert(Number.isFinite(result.parameters[key]) && result.parameters[key]>=bounds[0] && result.parameters[key]<=bounds[1]);
      assert(Math.abs(result.parameters[key]-initial)>(key === "resolution_halo_fraction" ? 0.005 : 0.02), `${key}: optimizer must update enabled variable`);
      if (key === "film_intensity_scale") assert(Math.abs(result.parameters[key]-target) < 0.02, "Browser Worker must recover synthetic film intensity scale");
      if (halo) assert(Math.abs(result.parameters[key]-target) < (key === "resolution_halo_fraction" ? 0.001 : 0.1),
        `${key}: browser Worker must recover the synthetic target`);
      assert(result.fit_result.best_fit_merit <= result.fit_result.initial_fit_merit + 1e-12);
      if (language === "en") assert(!/[가-힣]/.test(await evaluate(app(`d.getElementById("fitProgress").textContent + d.getElementById("fitResult").textContent`))));
      record(`${language}: ${key} alone completes a browser Worker fit and saves its result`,
        {target,initial,result:result.parameters[key],evaluations:result.fit_result.evaluations,
          initialMerit:result.fit_result.initial_fit_merit,bestMerit:result.fit_result.best_fit_merit});
    }

    await loadProjectFixture(refined, `refinement-${language}-expensive-cancel-input`);
    await evaluate(app(`(() => {
      d.getElementById("film_lattice_gradient_a").value="0.06";
      d.getElementById("film_thickness_sigma").value="6";
      d.getElementById("film_interface_width").value="5";
      d.getElementById("film_thickness_nm").value="150";
      d.getElementById("film_thickness_nm").dispatchEvent(new Event("change",{bubbles:true}));
      d.getElementById("fit_evaluations").value="6000";
      return true;
    })()`));
    assert.equal(await evaluate(app(`d.getElementById("fit_evaluations").value`)), "6000");
    const cancelledValues = await evaluate(app(`Array.from(d.querySelectorAll("#settingsForm input,#settingsForm select"),node=>[node.id,node.value,node.checked])`));
    await appClick("runFit");
    await waitFor(app(`!d.getElementById("cancelFit").hidden`), `${language} expensive fit begins`);
    const cancelStart=Date.now();
    await appClick("cancelFit");
    await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled`), `${language} expensive fit cancels`, 10000);
    assert.deepEqual(await evaluate(app(`Array.from(d.querySelectorAll("#settingsForm input,#settingsForm select"),node=>[node.id,node.value,node.checked])`)), cancelledValues);
    assert.match(await evaluate(app(`d.getElementById("fitProgress").textContent`)), language === "ko" ? /중단/ : /cancel|stop/i);
    record(`${language}: 6,000-evaluation gradient, taper, thickness distribution and halo fit starts and cancels without changing inputs`, {elapsedMs:Date.now()-cancelStart});
    await loadProjectFixture(haloRefitFixture, `refinement-${language}-halo-after-cancel`);
    await appClick("runFit");
    await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled &&
      !d.getElementById("fitResult").hidden`), `${language} halo refit after cancellation`, 60000);
    const haloRefit = await saveCurrentProject(`refinement-${language}-halo-after-cancel-fit`);
    assert.deepEqual(Object.keys(haloRefit.fit_result.bounds), ["resolution_halo_width"]);
    assert(Math.abs(haloRefit.parameters.resolution_halo_width - 3.8) < 0.1);
    record(`${language}: fresh worker refits and recovers halo width after cancelling the extended model`);
    await loadProjectFixture(baseline, `refinement-${language}-baseline-restore`);
  }
  await appClick("exportCsv");
  const csv = await downloadText("xrd_simulation.csv");
  assert.equal(csv.text.trim().split(/\r?\n/).length, 1002);
  assert.match(csv.text, /two_theta_deg,simulation_relative,measurement_raw,measurement_relative/);
  await appClick("saveProject");
  const project = await downloadText("xrd_studio_project.json");
  const saved = JSON.parse(project.text);
  assert.equal(saved.format, "xrd-studio-project-v1");
  assert.equal(saved.measurement.two_theta_deg.length, 1001);
  assert.equal(saved.fit_result.evaluations, 400);
  await evaluate(app(`(() => { const input=d.getElementById("film_lattice_a"); input.value="4.05";
    input.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`));
  const fileInput = await cdp.send("Runtime.evaluate", {expression:
    `document.getElementById("studio-frame").contentDocument.getElementById("projectFile")`});
  await cdp.send("DOM.setFileInputFiles", {objectId: fileInput.result.objectId, files: [project.target]});
  await waitFor(app(`Number(d.getElementById("film_lattice_a").value) === ${saved.parameters.film_lattice_a} &&
    !d.getElementById("fitResult").hidden && /복원/.test(d.getElementById("fitProgress").textContent)`), "saved settings and fit restore");
  record("CSV download contains 1,001 curve rows; settings download and file input restore parameters, sample, and fit result");
  await refinementFlow("ko", saved);
  // Local private evidence only: these scans are not copied into public assets.
  if (analysisFixtures) for (const sample of ["626","631"]) {
    const candidatePath=path.resolve(analysisFixtures,`DESCRIPTIVE_PROJECT_${sample}_2026_10_22.json`);
    const candidate=JSON.parse(await readFile(candidatePath,"utf8"));
    // Independently regress the exact saved calibration and indexed maxima.
    // Rounded-angle, zero-offset audit values describe a different request.
    const parseList=text=>text.trim().split(/[\s,;]+/).filter(Boolean).map(Number);
    const maxima=parseList(candidate.fringe_settings.manual_peaks), orders=parseList(candidate.fringe_settings.manual_orders);
    const {wavelength,angle_offset_deg}=candidate.parameters;
    const q=maxima.map(a=>4*Math.PI/wavelength*Math.sin((a-angle_offset_deg)*Math.PI/360));
    const average=a=>a.reduce((sum,v)=>sum+v,0)/a.length, meanQ=average(q), meanOrder=average(orders);
    const slope=q.reduce((sum,v,i)=>sum+(orders[i]-meanOrder)*(v-meanQ),0)/orders.reduce((sum,v)=>sum+(v-meanOrder)**2,0);
    const expectedThickness=2*Math.PI/slope/10;
    const expectedRms=Math.sqrt(average(maxima.map((a,i)=>(a-(angle_offset_deg+360/Math.PI*Math.asin((meanQ+slope*(orders[i]-meanOrder))*wavelength/(4*Math.PI))))**2)));
    await loadProjectFixture(candidate,`actual-${sample}-diagnostic-input`);
    assert.equal(await evaluate(app(`f.contentWindow.eval("state.measurement.angles.length")`)),2002);
    assert.equal(await evaluate(app(`d.getElementById("fringeResult").hidden && d.getElementById("peakResult").hidden`)),true);
    await appClick("estimateFringes");await waitFor(app(`!d.getElementById("estimateFringes").disabled`),`${sample} indexed measured fringes`);
    const fringe=await evaluate(app(`f.contentWindow.eval("state.fringe")`));
    assert(fringe);assert(Math.abs(fringe.thickness_nm-expectedThickness)<.0001);assert(Math.abs(fringe.angular_residual_rms_deg-expectedRms)<.000002);
    assert.equal(await evaluate(app(`d.querySelectorAll("#fringePeaks tr").length`)),fringe.orders.length+1);
    await appClick("fitPeaks");await waitFor(app(`!d.getElementById("fitPeaks").disabled`),`${sample} descriptive double-method peaks`,60000);
    assert.equal(await evaluate(app(`d.getElementById("peakStatus").classList.contains("error")`)),false);
    const peak=await evaluate(app(`f.contentWindow.eval("state.peakAnalysis")`));
    assert(peak);for(const item of [peak.soft_log,peak.linear]){assert.equal(item.components.length,2);assert.deepEqual(item.roi,[45.45,46.75]);assert(item.components.every(c=>Number.isFinite(c.c_00l_reference_angstrom)));}
    await writeFile(path.join(evidence,`actual-${sample}-browser-diagnostics.json`),JSON.stringify({fringe,peak},null,2));
    await evaluate(app(`(() => {d.querySelector("#fringeResult details").open=true;return true;})()`));
    await cardScreenshot("fringeCard",`actual-${sample}-indexed-fringes`);
    await cardScreenshot("peakCard",`actual-${sample}-peak-decomposition`);
    record(`Actual #${sample}: 2,002-point candidate imports; indexed fringe residuals and both descriptive fits run from explicit saved inputs`,{thickness:fringe.thickness_nm,angularRms:fringe.angular_residual_rms_deg,soft:peak.soft_log.components,linear:peak.linear.components});
  }
  await loadProjectFixture(saved,"actual-diagnostics-baseline-restore");

  const beforeReload = authCalls;
  await reload(); await appReady();
  assert.equal(authCalls, beforeReload, "Reload must restore using tab session, without a password request");
  await assertSessionStorage();
  record("Reload restores app from tab session without another authentication request");

  await appClick("runFit");
  await waitFor(app(`!d.getElementById("cancelFit").hidden`), "active fit before lock");
  await evaluate(`document.getElementById("lock-button").click()`);
  await waitFor(`document.getElementById("workspace").hidden`, "lock operation");
  await delay(100); await assertLocked();
  assert.equal(await evaluate(`document.getElementById("studio-frame").hasAttribute("srcdoc")`), false);
  record("Close during active fit removes session and unloads the application iframe");
  await reload();
  await waitFor(`document.readyState === "complete" && !!document.getElementById("unlock-form")`, "locked reload");
  await assertLocked(); assert.equal(authCalls, beforeReload);
  record("Reload after lock stays locked");

  await page("en"); await submit(correctCode); await appReady();
  assert.equal(await evaluate(app("d.documentElement.lang")), "en");
  assert.equal(await evaluate(`new URL(document.getElementById("studio-frame").src).pathname`), "/assets/xrd/en/");
  await fitFlow("en");
  const englishBaseline = await saveCurrentProject("refinement-en-baseline");
  await refinementFlow("en", englishBaseline);
  await assertSessionStorage();
  const beforeSwitch = authCalls;
  await appClick("langSwitch");
  await waitFor(`${app(`d.documentElement.lang === "ko"`)} && document.documentElement.lang === "ko" &&
    new URL(location.href).searchParams.get("lang") === "ko"`, "inner Korean switch syncs parent");
  await appReady();
  await appClick("langSwitch");
  await waitFor(`${app(`d.documentElement.lang === "en"`)} && document.documentElement.lang === "en" &&
    new URL(location.href).searchParams.get("lang") === "en"`, "inner English switch syncs parent");
  await appReady();
  await reload(); await appReady();
  assert.equal(await evaluate(app("d.documentElement.lang")), "en");
  assert.equal(await evaluate(`new URL(location.href).searchParams.get("lang")`), "en");
  assert.equal(authCalls, beforeSwitch);
  record("Inner language switches update parent language/query; reload retains English without another code check");
  await evaluate(`document.getElementById("studio-frame").src="/software.html"`);
  await waitFor(`document.getElementById("workspace").hidden &&
    /could not be loaded/.test(document.getElementById("gate-status").textContent)`, "later iframe load failure shows app error");
  await waitFor(app(`!d.getElementById("settingsForm")`), "failed iframe unload");
  await assertLocked();
  assert.equal(await evaluate(`document.getElementById("studio-frame").src`), "about:blank");
  await screenshot("later-app-load-error-en");
  record("Later iframe navigation without settingsForm returns to gate with app error, clears marker, and unloads iframe");
  const beforeDirect = authCalls;
  for (const [route, language] of [["/assets/xrd/", "ko"], ["/assets/xrd/en/", "en"]]) {
    await navigate(route);
    await waitFor(`document.getElementById("dataName")?.textContent === "sample_data.dat" &&
      /1,001/.test(document.getElementById("dataMeta")?.textContent) && !document.getElementById("runSimulation")?.disabled`, "direct app load");
    assert.equal(await evaluate("document.documentElement.lang"), language);
    assert.match(await evaluate(`document.querySelector('meta[name="robots"]')?.content || ""`), /noindex/);
    assert.equal(await sessionPresent(), false);
  }
  assert.equal(authCalls, beforeDirect);
  record("Both direct static app addresses intentionally work without authentication and include noindex");
  assert.equal(await evaluate("localStorage.length"), 0);
  assert(!network.some(({url}) => /xrd-app\.(?:enc|manifest)|xrdkey/.test(url)), "Retired encrypted-app paths must not be requested");
  assert(network.some(({url}) => url === `${origin}/assets/xrd/xrd_worker.js`), "Fitting must load the static worker");
  assert.deepEqual(blocked, [], "App must not try to contact external services");
  assert.deepEqual(errors, [], "No JavaScript errors or missing assets");
  record("Static worker runs; no persistent password, retired encrypted-app request, external request, console error, or 404", {requests: network.length});
  await writeFile(path.join(evidence, "report.json"), JSON.stringify({passed: true, tests,
    source: {siteHead: execFileSync("git", ["rev-parse", "HEAD"], {cwd: siteRoot, encoding: "utf8"}).trim(),
      gateSha256: hash(await readFile(path.join(siteRoot, "assets/js/xrd-gate.js"))),
      backendSha256: hash(appsScriptSource), appSha256: hash(JSON.stringify(files)),
      assetSha256:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,hash(content)])),
      xrdHead: execFileSync("git", ["rev-parse", "HEAD"], {cwd: xrdRoot, encoding: "utf8"}).trim()},
    network, responses, errors, blocked, cancelledInterceptions}, null, 2));
  console.log(`Evidence: ${evidence}`);
} catch (error) {
  process.exitCode = 1;
  if (screenshot) { try { await screenshot("failure"); } catch {} }
  await writeFile(path.join(evidence, "report.json"), JSON.stringify({passed: false, failure: error.message,
    tests, network, responses, errors, blocked, cancelledInterceptions}, null, 2));
  console.error(error.stack);
  console.error(`Evidence: ${evidence}`);
} finally {
  if (socket) socket.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill();
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), delay(2000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(path.join(temp, "plain"), {recursive: true, force: true});
  await rm(path.join(temp, "chrome-profile"), {recursive: true, force: true});
}
