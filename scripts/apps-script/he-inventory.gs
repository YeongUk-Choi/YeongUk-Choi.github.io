/**
 * Helium cylinder inventory + cryostat telemetry — Apps Script web app behind ppms.html.
 *
 * The site is a static page on GitHub Pages: it cannot keep a secret and it cannot write a file.
 * This script is the one piece that can do both — it holds the edit code in Script Properties
 * (never shipped to the browser) and appends movements to a sheet.
 *
 * SETUP
 *  1. Google Drive → new Google Sheet, name it e.g. "He cylinders".
 *  2. Extensions → Apps Script. Paste this file over Code.gs and Save.
 *  3. Project Settings → Script properties → add  EDIT_CODE = <the code>  (8+ chars, letters + digits)
 *     and  PUSH_CODE = <a different code>  used only by the lab PC collector. Two codes, because
 *     the collector's copy lives on a shared Windows machine: leaking it must not let anyone
 *     rewrite the cylinder ledger.
 *  4. Run the function `setup` once and accept the permission prompt. It writes the header rows.
 *  5. Deploy → New deployment → type "Web app".
 *       Execute as: Me          Who has access: Anyone
 *     Copy the /exec URL into data/ppms.js → apiUrl.
 *  After editing this file you must Deploy → Manage deployments → edit → New version, or the
 *  old code keeps running.
 */

var SHEET = 'movements';
var HEADER = ['id', 'ts', 'supplier', 'action', 'qty', 'note'];
var TELEMETRY = 'telemetry';
/* pc_ts is the lab PC's clock and may be wrong; server_ts is this server's and is what the
   page ages a reading against. A monitor whose clock drifted must still look stale. */
var TELEMETRY_HEADER = ['pc_ts', 'server_ts', 'temp_k', 'psi', 'heater_w', 'scm', 'hrc', 'src'];
var TELEMETRY_MAX = 20000;        // ~2 weeks at one point per minute; trimmed from the top
var TELEMETRY_TRIM = 2000;        // delete in blocks, deleting one row at a time is slow
var PUSH_MAX_POINTS = 200;        // one backlog batch; bounds this execution's runtime
var TELEMETRY_READ = 1440;        // points handed to the page: 24 h at one per minute
var SUPPLIERS = ['agas', 'ggas'];                 // must match data/ppms.js
var ACTIONS = { delivery: [+1, 0], open: [-1, +1], ret: [0, -1] };   // [full, empty] per cylinder
var MAX_QTY = 99;
var FAIL_LIMIT = 5, LOCK_MIN = 10;                // wrong-code attempts before a cool-off

function setup() {
  var sh = sheet();
  if (sh.getLastRow() === 0) sh.appendRow(HEADER);
  var tel = telemetrySheet();
  if (tel.getLastRow() === 0) tel.appendRow(TELEMETRY_HEADER);
  return 'ready';
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
}

function telemetrySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(TELEMETRY);
  if (!sh) { sh = ss.insertSheet(TELEMETRY); sh.appendRow(TELEMETRY_HEADER); }
  return sh;
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === 'telemetry') return json(telemetryRead(p));
  return handle(p);
}

/* The collector posts a JSON body rather than form fields, so a batch of backlog points is
   one request. Browser form posts from ppms.html still arrive as e.parameter. */
function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents;
    if (raw && raw.charAt(0) === '{') return json(handlePush(JSON.parse(raw)));
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
  return handle((e && e.parameter) || {});
}

/* ---- telemetry from the lab PC ---- */

function handlePush(body) {
  var stamp = new Date();
  requirePushCode(body.key);
  if (body.action === 'ping') return { ok: true, server_ts: stamp.toISOString(), stored: 0 };
  if (body.action !== 'push') throw new Error('Unknown action.');
  var points = body.points;
  if (!points || !points.length) return { ok: true, stored: 0, server_ts: stamp.toISOString() };
  if (points.length > PUSH_MAX_POINTS) throw new Error('Too many points in one request.');

  var rows = [], i;
  for (i = 0; i < points.length; i++) {
    var pt = points[i] || {};
    rows.push([String(pt.t || '').slice(0, 40), stamp,
               cell(pt.temp_k), cell(pt.psi), cell(pt.heater_w),
               String(pt.scm || '').slice(0, 20), String(pt.hrc || '').slice(0, 20),
               String(pt.src || body.src || '').slice(0, 10)]);
  }
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var sh = telemetrySheet();
    if (sh.getLastRow() === 0) sh.appendRow(TELEMETRY_HEADER);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, TELEMETRY_HEADER.length).setValues(rows);
    trimTelemetry(sh);
  } finally { lock.releaseLock(); }
  return { ok: true, stored: rows.length, server_ts: stamp.toISOString() };
}

/* A number or an empty cell. A missing reading must stay missing: writing 0 would draw a
   cold tip at absolute zero, and the chart cannot tell that apart from a real measurement. */
function cell(v) {
  if (v === null || v === undefined || v === '') return '';
  var n = Number(v);
  return isFinite(n) ? n : '';
}

function trimTelemetry(sh) {
  var rows = sh.getLastRow() - 1;
  if (rows <= TELEMETRY_MAX) return;
  sh.deleteRows(2, Math.max(TELEMETRY_TRIM, rows - TELEMETRY_MAX));
}

/* The push code has its own counter: a collector with a stale key must not lock the person
   standing at the cylinders out of the inventory. */
function requirePushCode(code) {
  var cache = CacheService.getScriptCache();
  if (cache.get('push_lockout')) throw new Error('Too many wrong push codes. Try again later.');
  var want = PropertiesService.getScriptProperties().getProperty('PUSH_CODE');
  if (!want) throw new Error('PUSH_CODE is not set on the server.');
  if (String(code || '') === want) { cache.remove('push_fails'); return; }
  var n = (Number(cache.get('push_fails')) || 0) + 1;
  cache.put('push_fails', String(n), LOCK_MIN * 60);
  if (n >= FAIL_LIMIT) cache.put('push_lockout', '1', LOCK_MIN * 60);
  throw new Error('Wrong push code.');
}

/* Read side is public, like the inventory list: a fridge temperature is not a secret, and a
   key in page JavaScript would not be one either. */
function telemetryRead(p) {
  var want = Math.min(Number(p.points) || TELEMETRY_READ, TELEMETRY_READ);
  var sh = telemetrySheet(), last = sh.getLastRow();
  if (last < 2) return { ok: true, points: [], latest: {}, server_ts: new Date().toISOString() };
  var first = Math.max(2, last - want + 1);
  var v = sh.getRange(first, 1, last - first + 1, TELEMETRY_HEADER.length).getValues();
  var points = [], latest = {}, i, r;
  for (i = 0; i < v.length; i++) {
    r = v[i];
    var ts = toIso(r[1]);
    points.push([ts, r[2] === '' ? null : Number(r[2]), r[3] === '' ? null : Number(r[3]),
                 r[4] === '' ? null : Number(r[4])]);
    /* Each metric keeps its own last-seen time. SCM10 and HRC are read over different links
       and fail independently; one freshness number for both would hide a half-dead monitor. */
    if (r[2] !== '') latest.temp_k = { v: Number(r[2]), ts: ts, pc_ts: String(r[0]) };
    if (r[3] !== '') latest.psi = { v: Number(r[3]), ts: ts, pc_ts: String(r[0]) };
    if (r[4] !== '') latest.heater_w = { v: Number(r[4]), ts: ts, pc_ts: String(r[0]) };
    latest.seen = ts;                              // the collector itself was alive at this time
    latest.scm = String(r[5] || '');
    latest.hrc = String(r[6] || '');
    latest.src = String(r[7] || '');
  }
  return { ok: true, fields: ['ts', 'temp_k', 'psi', 'heater_w'], points: points,
           latest: latest, server_ts: new Date().toISOString() };
}

function handle(p) {
  try {
    if (p.action === 'list' || !p.action) return json({ ok: true, events: readAll() });
    requireCode(p.code);
    var lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      if (p.action === 'add') add(p);
      else if (p.action === 'undo') undo(p.id);
      else throw new Error('Unknown action.');
      return json({ ok: true, events: readAll() });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return json({ ok: false, error: String(err.message || err) });
  }
}

/* ---- code check with a shared cool-off. Apps Script sees no client IP, so the counter is
   global: five wrong tries lock everyone out for ten minutes. That is acceptable here —
   one person edits this — and it is what makes a short code safe to brute force. ---- */
function requireCode(code) {
  var cache = CacheService.getScriptCache();
  if (cache.get('lockout')) throw new Error('Too many wrong codes. Try again in a few minutes.');
  var want = PropertiesService.getScriptProperties().getProperty('EDIT_CODE');
  if (!want) throw new Error('EDIT_CODE is not set on the server.');
  if (String(code || '') === want) { cache.remove('fails'); return; }
  var n = (Number(cache.get('fails')) || 0) + 1;
  cache.put('fails', String(n), LOCK_MIN * 60);
  if (n >= FAIL_LIMIT) cache.put('lockout', '1', LOCK_MIN * 60);
  throw new Error('Wrong code.');
}

function readAll() {
  var v = sheet().getDataRange().getValues();
  if (v.length < 2) return [];
  return v.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), ts: toIso(r[1]), supplier: String(r[2]), action: String(r[3]), qty: Number(r[4]), note: String(r[5] || '') };
  });
}

function toIso(v) { return (v instanceof Date) ? v.toISOString() : String(v); }

function add(p) {
  var supplier = String(p.supplier || ''), kind = String(p.kind || ''), qty = Math.floor(Number(p.qty));
  if (SUPPLIERS.indexOf(supplier) < 0) throw new Error('Unknown supplier.');
  if (!ACTIONS[kind]) throw new Error('Unknown movement.');
  if (!(qty >= 1 && qty <= MAX_QTY)) throw new Error('Quantity must be 1–' + MAX_QTY + '.');
  var note = String(p.note || '').slice(0, 120);

  /* the browser checks this too, but the browser is not the guard */
  var after = totals(readAll().concat([{ supplier: supplier, action: kind, qty: qty }]))[supplier];
  if (after.full < 0) throw new Error('That would leave ' + after.full + ' full cylinders.');
  if (after.empty < 0) throw new Error('That would leave ' + after.empty + ' empty cylinders.');

  sheet().appendRow([Utilities.getUuid().slice(0, 8), new Date(), supplier, kind, qty, note]);
}

function undo(id) {
  id = String(id || '');
  var sh = sheet(), v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === id) { sh.deleteRow(i + 1); return; }
  throw new Error('That line is already gone.');
}

function totals(events) {
  var t = {}; SUPPLIERS.forEach(function (s) { t[s] = { full: 0, empty: 0 }; });
  events.forEach(function (e) {
    var a = ACTIONS[e.action], s = t[e.supplier];
    if (!a || !s) return;
    s.full += a[0] * Number(e.qty); s.empty += a[1] * Number(e.qty);
  });
  return t;
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
