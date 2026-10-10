/**
 * Helium cylinder inventory — Google Apps Script web app behind ppms.html.
 *
 * The site is a static page on GitHub Pages: it cannot keep a secret and it cannot write a file.
 * This script is the one piece that can do both — it holds the edit code in Script Properties
 * (never shipped to the browser) and appends movements to a sheet.
 *
 * SETUP
 *  1. Google Drive → new Google Sheet, name it e.g. "He cylinders".
 *  2. Extensions → Apps Script. Paste this file over Code.gs and Save.
 *  3. Project Settings → Script properties → add  EDIT_CODE = <the code>  (8+ chars, letters + digits).
 *  4. Run the function `setup` once and accept the permission prompt. It writes the header row.
 *  5. Deploy → New deployment → type "Web app".
 *       Execute as: Me          Who has access: Anyone
 *     Copy the /exec URL into data/ppms.js → apiUrl.
 *  After editing this file you must Deploy → Manage deployments → edit → New version, or the
 *  old code keeps running.
 */

var SHEET = 'movements';
var HEADER = ['id', 'ts', 'supplier', 'action', 'qty', 'note'];
var SUPPLIERS = ['agas', 'ggas'];                 // must match data/ppms.js
var ACTIONS = { delivery: [+1, 0], open: [-1, +1], ret: [0, -1] };   // [full, empty] per cylinder
var MAX_QTY = 99;
var FAIL_LIMIT = 5, LOCK_MIN = 10;                // wrong-code attempts before a cool-off

function setup() {
  var sh = sheet();
  if (sh.getLastRow() === 0) sh.appendRow(HEADER);
  return 'ready';
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET) || ss.insertSheet(SHEET);
}

function doGet(e) { return handle(e.parameter || {}); }
function doPost(e) { return handle((e && e.parameter) || {}); }

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
