/**
 * Helium cylinder inventory + cryostat telemetry + work log — Apps Script web app behind ppms.html.
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
 *     Run it again after an update that adds a sheet — it only fills in what is missing.
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
var TELEMETRY_MAX = 45000;        // ~31 days at one point per minute; trimmed from the top
var TELEMETRY_TRIM = 2000;        // delete in blocks, deleting one row at a time is slow
var PUSH_MAX_POINTS = 200;        // one backlog batch; bounds this execution's runtime
var TELEMETRY_READ = 1440;        // points handed to the page by default: 24 h at one per minute
var TELEMETRY_MAX_OUT = 4000;     // ceiling for a long window; beyond this the range is thinned
var TELEMETRY_MAX_HOURS = 24 * 60;
/* Service events and the actions taken on them: two sheets, one row per thing, joined on
   the event id. An event is the headline ("pressure stuck at 1.1 psi"); the actions are
   what people did about it, each with its own time and initials. */
var EVENTS = 'events';
var EVENTS_HEADER = ['id', 'no', 'created', 'opened', 'closed', 'status', 'equipment',
                     'title', 'issue', 'reporter', 'readings', 'outcome'];
var ACTS = 'actions';
var ACTS_HEADER = ['id', 'event', 'ts', 'who', 'what', 'result'];
var SUPPLIERS = ['agas', 'ggas'];                 // must match data/ppms.js
var ACTIONS = { delivery: [+1, 0], open: [-1, +1], ret: [0, -1] };   // [full, empty] per cylinder
var MAX_QTY = 99;
var FAIL_LIMIT = 5, LOCK_MIN = 10;                // wrong-code attempts before a cool-off

function setup() {
  var sh = sheet();
  if (sh.getLastRow() === 0) sh.appendRow(HEADER);
  var tel = telemetrySheet();
  if (tel.getLastRow() === 0) tel.appendRow(TELEMETRY_HEADER);
  var ev = eventSheet();
  if (ev.getLastRow() === 0) ev.appendRow(EVENTS_HEADER);
  var ac = actionSheet();
  if (ac.getLastRow() === 0) ac.appendRow(ACTS_HEADER);
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

function eventSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(EVENTS);
  if (!sh) { sh = ss.insertSheet(EVENTS); sh.appendRow(EVENTS_HEADER); }
  return sh;
}

function actionSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(ACTS);
  if (!sh) { sh = ss.insertSheet(ACTS); sh.appendRow(ACTS_HEADER); }
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
  var sh = telemetrySheet(), last = sh.getLastRow();
  if (last < 2) return { ok: true, points: [], latest: {}, server_ts: new Date().toISOString() };

  /* `hours` is the window the chart is drawing. Without it the page could only ever see the
     last 1440 rows, which is why its 7-day and 30-day buttons drew the same day twice. */
  var hours = Math.min(Number(p.hours) || 0, TELEMETRY_MAX_HOURS);
  var cap = Math.min(Number(p.points) || (hours ? TELEMETRY_MAX_OUT : TELEMETRY_READ),
                     hours ? TELEMETRY_MAX_OUT : TELEMETRY_READ);
  var oldest = stamp(sh.getRange(2, 2).getValue());
  var first;
  if (hours) {
    /* rows are appended in time order, so the start of the window is a binary search over
       one column rather than a read of the whole sheet */
    first = firstRowAtOrAfter(sh, last, Date.now() - hours * 3600000);
  } else {
    first = Math.max(2, last - cap + 1);
  }
  var rows = last - first + 1;
  if (rows < 1) return { ok: true, points: [], latest: {}, oldest: oldest, stride: 1,
                         server_ts: new Date().toISOString() };
  /* One point per stride. The 24 h view stays at full resolution; a fortnight is thinned to
     about one point every five minutes, which still shows a spike but is a tenth the bytes. */
  var stride = Math.max(1, Math.ceil(rows / cap));
  var v = sh.getRange(first, 1, rows, TELEMETRY_HEADER.length).getValues();
  var points = [], latest = {}, i, r, ts;
  for (i = 0; i < v.length; i++) {
    r = v[i];
    ts = toIso(r[1]);
    /* Every row updates "latest" even when it is not plotted — the cards above the chart
       must show the real last reading, not the last one that survived thinning.
       Each metric keeps its own last-seen time: SCM10 and HRC are read over different links
       and fail independently, and one freshness number for both would hide a half-dead monitor. */
    if (r[2] !== '') latest.temp_k = { v: Number(r[2]), ts: ts, pc_ts: String(r[0]) };
    if (r[3] !== '') latest.psi = { v: Number(r[3]), ts: ts, pc_ts: String(r[0]) };
    if (r[4] !== '') latest.heater_w = { v: Number(r[4]), ts: ts, pc_ts: String(r[0]) };
    latest.seen = ts;                              // the collector itself was alive at this time
    latest.scm = String(r[5] || '');
    latest.hrc = String(r[6] || '');
    latest.src = String(r[7] || '');
    /* the last row is always plotted, so the right edge of the chart is the real last reading */
    if (stride > 1 && i % stride !== 0 && i !== v.length - 1) continue;
    points.push([ts, r[2] === '' ? null : Number(r[2]), r[3] === '' ? null : Number(r[3]),
                 r[4] === '' ? null : Number(r[4])]);
  }
  return { ok: true, fields: ['ts', 'temp_k', 'psi', 'heater_w'], points: points,
           latest: latest, oldest: oldest, stride: stride, kept: last - 1,
           server_ts: new Date().toISOString() };
}

function stamp(v) { return v ? toIso(v) : ''; }

/* First data row whose server_ts is at or after `ms`. Rows are appended in order, so a
   binary search over the timestamp column beats reading every row. */
function firstRowAtOrAfter(sh, last, ms) {
  var lo = 2, hi = last, at = last + 1;
  while (lo <= hi) {
    var mid = Math.floor((lo + hi) / 2);
    var v = sh.getRange(mid, 2).getValue();
    var t = (v instanceof Date) ? v.getTime() : new Date(String(v)).getTime();
    if (isNaN(t) || t < ms) { lo = mid + 1; } else { at = mid; hi = mid - 1; }
  }
  return Math.min(at, last);
}

function handle(p) {
  try {
    if (p.action === 'list' || !p.action) return json({ ok: true, events: readAll() });
    /* Note the two meanings of "events" in this file: the cylinder ledger calls its rows
       events (action=list), and the service log is action=events. Separate calls, separate sheets. */
    if (p.action === 'events') return json(eventsRead());
    requireCode(p.code);
    var lock = LockService.getScriptLock(); lock.waitLock(10000);
    try {
      /* Every event write answers with the whole log, so one round trip leaves the page
         holding exactly what the sheet holds. */
      if (p.action.indexOf('ev_') === 0 || p.action.indexOf('act_') === 0) {
        if (p.action === 'ev_add') evAdd(p);
        else if (p.action === 'ev_edit') evEdit(p);
        else if (p.action === 'ev_close') evClose(p);
        else if (p.action === 'ev_reopen') evReopen(p);
        else if (p.action === 'ev_del') evDel(p.id);
        else if (p.action === 'act_add') actAdd(p);
        else if (p.action === 'act_del') actDel(p.id);
        else throw new Error('Unknown action.');
        return json(eventsRead());
      }
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

/* ---- service events ----
   `equipment` and `who` are stored as free text. The cylinder actions are validated because
   they move a count; these are labels, and a list kept in two files drifts the first time
   someone adds one on the page and not here. Initials, not names: the page is public. */

var EV_MAX_TEXT = 2000, EV_MAX_LINE = 160, EV_MAX_ACTION = 600;

function eventsRead() {
  var ev = eventSheet().getDataRange().getValues();
  var ac = actionSheet().getDataRange().getValues();
  var events = ev.length < 2 ? [] : ev.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), no: String(r[1]), created: toIso(r[2]), opened: toIso(r[3]),
             closed: r[4] === '' || r[4] == null ? '' : toIso(r[4]), status: String(r[5] || 'open'),
             equipment: String(r[6] || ''), title: String(r[7] || ''), issue: String(r[8] || ''),
             reporter: String(r[9] || ''), readings: String(r[10] || ''), outcome: String(r[11] || '') };
  });
  var actions = ac.length < 2 ? [] : ac.slice(1).filter(function (r) { return r[0]; }).map(function (r) {
    return { id: String(r[0]), event: String(r[1]), ts: toIso(r[2]), who: String(r[3] || ''),
             what: String(r[4] || ''), result: String(r[5] || '') };
  });
  return { ok: true, events: events, actions: actions, server_ts: new Date().toISOString() };
}

/* A date the browser sent. Anything unparseable is refused rather than quietly stored as
   "now": an action logged at the wrong hour is worse than one the page made you re-enter. */
function when(v, what) {
  var d = new Date(String(v || ''));
  if (isNaN(d.getTime())) throw new Error('Enter a valid ' + what + '.');
  if (d.getTime() > Date.now() + 86400000) throw new Error('That ' + what + ' is in the future.');
  return d;
}

function text(v, limit, what) {
  var t = String(v == null ? '' : v).trim();
  if (limit && t.length > limit) throw new Error(what + ' is too long (max ' + limit + ' characters).');
  return t;
}

/* PPMS-<year>-<serial>. The serial counts only that year's rows, so it stays short and a
   report number read off paper still finds its row. */
function nextNo(sh, year) {
  var v = sh.getDataRange().getValues(), prefix = 'PPMS-' + year + '-', n = 0;
  for (var i = 1; i < v.length; i++) {
    var no = String(v[i][1] || '');
    if (no.indexOf(prefix) === 0) {
      var k = parseInt(no.slice(prefix.length), 10);
      if (k > n) n = k;
    }
  }
  n += 1;
  return prefix + (n < 10 ? '00' : n < 100 ? '0' : '') + n;
}

function evRow(sh, id) {
  var v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === String(id)) return { row: i + 1, v: v[i] };
  return null;
}

function evAdd(p) {
  var opened = when(p.opened, 'start time');
  var title = text(p.title, EV_MAX_LINE, 'Title');
  if (!title) throw new Error('Give the event a title.');
  var equipment = text(p.equipment, EV_MAX_LINE, 'Equipment');
  if (!equipment) throw new Error('Pick the equipment.');
  var reporter = text(p.reporter, EV_MAX_LINE, 'Initials');
  if (!reporter) throw new Error('Enter the initials of whoever is reporting this.');
  var sh = eventSheet();
  if (sh.getLastRow() === 0) sh.appendRow(EVENTS_HEADER);
  sh.appendRow([Utilities.getUuid().slice(0, 8), nextNo(sh, opened.getFullYear()), new Date(),
                opened, '', 'open', equipment, title, text(p.issue, EV_MAX_TEXT, 'Issue'),
                reporter, text(p.readings, 400, 'Readings'), '']);
}

function evEdit(p) {
  var sh = eventSheet(), hit = evRow(sh, p.id);
  if (!hit) throw new Error('That event is already gone.');
  /* Only the fields the form sent are touched, so editing the title cannot blank the issue. */
  if (p.opened != null && p.opened !== '') sh.getRange(hit.row, 4).setValue(when(p.opened, 'start time'));
  if (p.equipment != null) sh.getRange(hit.row, 7).setValue(text(p.equipment, EV_MAX_LINE, 'Equipment'));
  if (p.title != null) sh.getRange(hit.row, 8).setValue(text(p.title, EV_MAX_LINE, 'Title'));
  if (p.issue != null) sh.getRange(hit.row, 9).setValue(text(p.issue, EV_MAX_TEXT, 'Issue'));
  if (p.reporter != null) sh.getRange(hit.row, 10).setValue(text(p.reporter, EV_MAX_LINE, 'Initials'));
  if (p.outcome != null) sh.getRange(hit.row, 12).setValue(text(p.outcome, EV_MAX_TEXT, 'Outcome'));
}

function evClose(p) {
  var sh = eventSheet(), hit = evRow(sh, p.id);
  if (!hit) throw new Error('That event is already gone.');
  var closed = String(p.closed || '') ? when(p.closed, 'end time') : new Date();
  var opened = new Date(toIso(hit.v[3]));
  if (closed.getTime() < opened.getTime()) throw new Error('The event cannot close before it started.');
  sh.getRange(hit.row, 5).setValue(closed);
  sh.getRange(hit.row, 6).setValue('resolved');
  if (p.outcome != null) sh.getRange(hit.row, 12).setValue(text(p.outcome, EV_MAX_TEXT, 'Outcome'));
}

function evReopen(p) {
  var sh = eventSheet(), hit = evRow(sh, p.id);
  if (!hit) throw new Error('That event is already gone.');
  sh.getRange(hit.row, 5).setValue('');
  sh.getRange(hit.row, 6).setValue('open');
}

/* Deleting an event takes its actions with it — an orphan action belongs to nothing and
   would never be seen again, but would still be counted. */
function evDel(id) {
  id = String(id || '');
  var sh = eventSheet(), hit = evRow(sh, id);
  if (!hit) throw new Error('That event is already gone.');
  sh.deleteRow(hit.row);
  var ash = actionSheet(), v = ash.getDataRange().getValues();
  for (var i = v.length - 1; i >= 1; i--) if (String(v[i][1]) === id) ash.deleteRow(i + 1);
}

function actAdd(p) {
  var sh = eventSheet();
  if (!evRow(sh, p.event)) throw new Error('That event is already gone.');
  var what = text(p.what, EV_MAX_ACTION, 'Action');
  if (!what) throw new Error('Write what was done.');
  var who = text(p.who, EV_MAX_LINE, 'Initials');
  if (!who) throw new Error('Enter the initials of whoever did it.');
  var ash = actionSheet();
  if (ash.getLastRow() === 0) ash.appendRow(ACTS_HEADER);
  ash.appendRow([Utilities.getUuid().slice(0, 8), String(p.event), when(p.ts, 'time'), who,
                 what, text(p.result, EV_MAX_ACTION, 'Result')]);
}

function actDel(id) {
  id = String(id || '');
  var sh = actionSheet(), v = sh.getDataRange().getValues();
  for (var i = 1; i < v.length; i++) if (String(v[i][0]) === id) { sh.deleteRow(i + 1); return; }
  throw new Error('That line is already gone.');
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
