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
  assert(["--xrd-root", "--chrome", "--output"].includes(options[i]), `Unknown argument ${options[i]}`);
  assert(options[i + 1], `Missing value for ${options[i]}`);
}
const xrdRoot = path.resolve(option("--xrd-root", path.join(siteRoot, "../xrd-studio-gpt")));
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
    "xrd_core.js", "xrd_fit.js", "xrd_local.js", "xrd_worker.js", "xrd_data.json", "sample_data.dat", "favicon.svg"];
  const files = Object.fromEntries(await Promise.all(filenames.map(async (name) =>
    [name, await readFile(path.join(temp, "plain", name), "utf8")])));
  for (const filename of filenames) {
    assert.equal(await readFile(path.join(siteRoot, "assets/xrd", filename), "utf8"), files[filename],
      `Published static asset differs from current build: ${filename}`);
  }
  record("All twelve shipped static app files match a fresh source build");
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
  const newModelDefaults = {film_interface_width:0, film_thickness_sigma:0, background_slope:0,
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
  async function loadProjectFixture(value, name) {
    const target = path.join(evidence, `${name}.json`);
    await writeFile(target, JSON.stringify(value, null, 2));
    const input = await cdp.send("Runtime.evaluate", {expression:
      `document.getElementById("studio-frame").contentDocument.getElementById("projectFile")`});
    await cdp.send("DOM.setFileInputFiles", {objectId: input.result.objectId, files: [target]});
    await waitFor(app(`d.getElementById("status").textContent.includes(${JSON.stringify(`${name}.json`)}) &&
      !d.getElementById("runSimulation").disabled`), `load ${name}`, 30000);
    assert(!await evaluate(app(`d.getElementById("status").classList.contains("error")`)), `Could not load ${name}`);
  }
  const readNewControls = () => evaluate(app(`({
    values:Object.fromEntries(${JSON.stringify(newModelKeys)}.map(key=>[key,Number(d.getElementById(key).value)])),
    mode:d.getElementById("lp_mode").value,
    enabled:Object.fromEntries(${JSON.stringify(newModelKeys)}.map(key=>[key,d.getElementById("fit_enable_"+key).checked]))
  })`));
  async function refinementFlow(language, baseline) {
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

    const chosen = {film_interface_width: 2.25, film_thickness_sigma: 1.5, background_slope: -0.04,
      resolution_halo_fraction:0.0075, resolution_halo_width:4.5};
    await evaluate(app(`(() => {
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
        if (${halo}) Object.assign(parameters,{substrate_planes:300,fwhm_deg:0.04,
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
      d.getElementById("fit_evaluations").value="1200";
      return true;
    })()`));
    const cancelledValues = await evaluate(app(`Array.from(d.querySelectorAll("#settingsForm input,#settingsForm select"),node=>[node.id,node.value,node.checked])`));
    await appClick("runFit");
    await waitFor(app(`!d.getElementById("cancelFit").hidden`), `${language} expensive fit begins`);
    const cancelStart=Date.now();
    await appClick("cancelFit");
    await waitFor(app(`d.getElementById("cancelFit").hidden && !d.getElementById("runFit").disabled`), `${language} expensive fit cancels`, 10000);
    assert.deepEqual(await evaluate(app(`Array.from(d.querySelectorAll("#settingsForm input,#settingsForm select"),node=>[node.id,node.value,node.checked])`)), cancelledValues);
    assert.match(await evaluate(app(`d.getElementById("fitProgress").textContent`)), language === "ko" ? /중단/ : /cancel|stop/i);
    record(`${language}: gradient, taper, thickness distribution and halo fit cancels without changing inputs`, {elapsedMs:Date.now()-cancelStart});
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
