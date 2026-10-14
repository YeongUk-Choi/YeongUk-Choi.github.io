#!/usr/bin/env node
// cv.html → assets/cv/YeongUk-Choi-CV.pdf
// Chrome의 --print-to-pdf 는 배경색을 빼고 그리기 때문에 CDP Page.printToPDF(printBackground:true)를 씁니다.
// 쓰는 법:  node scripts/make_cv.mjs            (저장소 루트에서)
//           node scripts/make_cv.mjs cv.html assets/cv/YeongUk-Choi-CV.pdf
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const [src = "cv.html", out = "assets/cv/YeongUk-Choi-CV.pdf"] = process.argv.slice(2);
const url = /^https?:\/\//.test(src) ? src : "file://" + resolve(src);
const CH = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9400 + Math.floor(Math.random() * 400);
const chrome = spawn(CH, ["--headless=new", "--disable-gpu", "--hide-scrollbars",
  `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/cv-prof-${port}`, "about:blank"], { stdio: "ignore" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let list; for (let i = 0; i < 20 && !list; i++) { await sleep(300); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch {} }
const ws = new WebSocket(list.find(t => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = {};
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) pending[m.id](m); };
const send = (method, params = {}) => new Promise(r => { pending[++id] = r; ws.send(JSON.stringify({ id, method, params })); });
await new Promise(r => ws.onopen = r);

await send("Page.navigate", { url });
await sleep(1500);                                   // data/*.js 와 사진이 올라올 시간

const pdf = await send("Page.printToPDF", {
  printBackground: true,                             // 보라→주황 띠와 구분선이 살아 있어야 합니다
  preferCSSPageSize: true,                           // @page { size: A4; margin: … } 를 따릅니다
  displayHeaderFooter: false,
  scale: 1
});
if (!pdf.result) { console.error("printToPDF failed:", JSON.stringify(pdf)); process.exit(1); }
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.from(pdf.result.data, "base64"));
console.log("wrote", out);
ws.close(); chrome.kill(); process.exit(0);
