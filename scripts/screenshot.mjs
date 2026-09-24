#!/usr/bin/env node
// Headless-Chrome screenshot with proper device emulation (macOS headless ignores small --window-size).
// Usage: node scripts/screenshot.mjs <file.html[#hash]> <out.png> [width=1440] [height=900] [scale=2] [mobile=0] [js-before-capture]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const [page, out, w = "1440", h = "900", scale = "2", mobile = "0", pre = ""] = process.argv.slice(2);
const [file, hash] = page.split("#");
const url = "file://" + resolve(file) + (hash ? "#" + hash : "");
const CH = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/shot-prof-${port}`, "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let list; for (let i = 0; i < 20 && !list; i++) { await sleep(300); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) pending[m.id](m); };
const send = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
await new Promise(r => ws.onopen = r);
await send("Emulation.setDeviceMetricsOverride", { width: +w, height: +h, deviceScaleFactor: +scale, mobile: mobile === "1" });
await send("Page.navigate", { url });
await sleep(1200);
if (pre) { await send("Runtime.evaluate", { expression: pre, awaitPromise: true }); await sleep(500); }
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log("wrote", out);
ws.close(); chrome.kill(); process.exit(0);
