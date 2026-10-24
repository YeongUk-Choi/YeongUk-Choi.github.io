/* COD proxy handler contracts with synthetic upstream responses and Google services.
   No production endpoint, spreadsheet, credentials, or external network is used.
   Run the complete Apps Script suite: node --test scripts/apps-script/test_*.cjs */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'he-inventory.gs'), 'utf8');
const BASE = 'https://www.crystallography.net/cod';
const row = (extra = {}) => ({ file: '1539951', formula: '- O2 V -', sg: 'P 42/m n m',
  sgNumber: '136', a: '4.5546', b: '4.5546', c: '2.8514', ...extra });
const cif = '# A synthetic fixture: preserve whitespace, UTF-8 한글, and line endings.\r\n' +
  'data_1539951\r\n_cell_length_a 4.5546\r\n_cell_length_b 4.5546\r\n_cell_length_c 2.8514\r\n' +
  '_cell_angle_alpha 90\r\n_cell_angle_beta 90\r\n_cell_angle_gamma 90\r\n';

function fixture({ body = JSON.stringify([row()]), status = 200, networkError = null,
  cacheUnavailable = false, userCacheLimit = Infinity } = {}) {
  let now = 1700000000000;
  const requests = [], cache = new Map(), scriptCache = new Map(), writes = [], forbidden = [];
  const touch = name => { forbidden.push(name); throw new Error('Unexpected service: ' + name); };
  const cacheService = {
    get(key) {
      assert.match(key, /^cod-v1:/, 'COD must not read inventory/collector/XRD counters');
      if (cacheUnavailable) throw new Error('cache unavailable');
      const hit = cache.get(key);
      return hit && hit.expires > now ? hit.value : null;
    },
    put(key, value, seconds) {
      assert.match(key, /^cod-v1:/, 'COD must not write lab counters');
      if (cacheUnavailable) throw new Error('cache unavailable');
      writes.push({ key, value, seconds });
      if (!cache.has(key) && cache.size >= userCacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expires: now + seconds * 1000 });
    },
    remove(key) { touch('cache.remove:' + key); }
  };
  const context = vm.createContext({
    CacheService: {
      getUserCache: () => cacheService,
      getScriptCache: () => touch('script-cache')
    },
    Utilities: { newBlob: text => ({ getBytes: () => Buffer.from(String(text), 'utf8') }) },
    UrlFetchApp: { fetch(url, options) {
      requests.push({ url, options: JSON.parse(JSON.stringify(options)) });
      if (networkError) throw new Error(networkError);
      return { getResponseCode: () => status, getContentText: () => body,
        getBlob: () => ({ getBytes: () => Buffer.from(body, 'utf8') }) };
    } },
    PropertiesService: { getScriptProperties: () => touch('properties') },
    SpreadsheetApp: { getActiveSpreadsheet: () => touch('spreadsheet') },
    LockService: { getScriptLock: () => touch('lock') },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: content => ({ content, mimeType: null,
        setMimeType(type) { this.mimeType = type; return this; } })
    }
  });
  vm.runInContext(source, context, { filename: 'he-inventory.gs' });
  return {
    requests, cache, scriptCache, writes, forbidden, context,
    get(params = { action: 'cod', formula: 'VO2' }) {
      return context.doGet({ parameter: params });
    },
    search(formula = 'VO2') { return decode(this.get({ action: 'cod', formula })); },
    post(event) { return decode(context.doPost(event)); },
    advance(ms) { now += ms; },
    assertIsolated() { assert.deepEqual(forbidden, []); }
  };
}

function decode(output) {
  assert.equal(output.mimeType, 'application/json');
  return JSON.parse(output.content);
}

function error(reply, code, retryable) {
  assert.equal(reply.ok, false);
  assert.equal(reply.code, code);
  assert.equal(typeof reply.error, 'string');
  assert.ok(reply.error.length > 0);
  assert.equal(reply.retryable, retryable);
  assert.equal('records' in reply, false, 'failures must not masquerade as empty results');
}

test('search returns upstream records and provenance via one bounded fixed-host request', () => {
  const upstream = [row({ title: 'Synthetic title', authors: 'Test, A.', custom: 'preserved' })];
  const f = fixture({ body: JSON.stringify(upstream) });
  const result = f.search();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.formula, 'O2 V');
  assert.equal(result.query_mode, 'exact_formula');
  assert.equal(result.count, 1);
  assert.equal(result.cached, false);
  assert.deepEqual(result.records, upstream);
  assert.ok(Number.isFinite(Date.parse(result.fetched_at)));
  assert.equal(result.source_url, BASE + '/result?format=json&formula=O2%20V');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, result.source_url);
  assert.equal(f.requests[0].options.method, 'get');
  assert.equal(f.requests[0].options.followRedirects, false);
  assert.equal(f.requests[0].options.muteHttpExceptions, true);
  assert.equal(f.requests[0].options.validateHttpsCertificates, true);
  assert.equal(f.requests[0].options.timeoutSeconds, 20);
  f.assertIsolated();
});

test('formula normalization preserves composition, decimal precision, Hill order and subscripts', () => {
  const cases = [
    ['VO₂', 'O2 V'], [' O2 V ', 'O2 V'], ['V2O4', 'O4 V2'],
    ['La0.7Sr0.3MnO3', 'La0.7 Mn O3 Sr0.3'],
    ['O0.1O0.2V', 'O0.3 V'], ['CH3COOH', 'C2 H4 O2'],
    ['BrH3C', 'C H3 Br'], ['H2O', 'H2 O'], ['Og', 'Og'],
    ['Fe0.000001O', 'Fe0.000001 O']
  ];
  for (const [input, expected] of cases) {
    const f = fixture({ body: '[]' });
    assert.equal(f.search(input).formula, expected, input);
    assert.equal(new URL(f.requests[0].url).searchParams.get('formula'), expected);
    f.assertIsolated();
  }
});

test('invalid and unsupported formulas fail before any network/cache/service operation', () => {
  const cases = [undefined, null, '', ' ', 42, 'Vo2', 'Xx2', 'VO2junk', 'V1-xWxO2',
    'Ca(OH)2', 'CuSO4·5H2O', 'Fe3+', 'Fe0O', 'Fe-1O', 'O.5V', 'O1.0000001V',
    'VO2&format=html', 'https://example.com', 'H'.repeat(121), 'H10001', 'H10000H'];
  for (const formula of cases) {
    const f = fixture();
    error(decode(f.get({ action: 'cod', formula })), 'INVALID_FORMULA', false);
    assert.equal(f.requests.length, 0, String(formula));
    assert.equal(f.writes.length, 0);
    f.assertIsolated();
  }
});

test('successful searches cache for six hours and normalized equivalents share a cache entry', () => {
  const f = fixture();
  const first = f.search('VO2');
  assert.equal(f.writes[0].seconds, 21600);
  f.advance(21599000);
  const hit = f.search('V O₂');
  assert.equal(hit.cached, true);
  assert.equal(hit.fetched_at, first.fetched_at);
  assert.deepEqual(hit.records, first.records);
  assert.equal(f.requests.length, 1);
  f.advance(1000);
  assert.equal(f.search().cached, false);
  assert.equal(f.requests.length, 2);
  f.assertIsolated();
});

test('many public COD searches can evict user-cache entries without touching lab lockouts', () => {
  const f = fixture({ userCacheLimit: 1000 });
  f.scriptCache.set('lockout', { value: '1', expires: 1700000600000 });
  f.scriptCache.set('push_lockout', { value: '1', expires: 1700000600000 });
  f.scriptCache.set('fails', { value: '5', expires: 1700000600000 });
  const labBefore = JSON.stringify([...f.scriptCache]);
  for (let i = 1; i <= 1100; i++) {
    const reply = f.search('H' + i);
    assert.equal(reply.ok, true);
    assert.equal(reply.cached, false);
  }
  assert.equal(f.requests.length, 1100);
  assert.equal(f.writes.length, 1100);
  assert.equal(f.cache.size, 1000, 'synthetic user cache reached capacity and evicted entries');
  assert.equal(JSON.stringify([...f.scriptCache]), labBefore, 'lab lockout values and expiry stay intact');
  f.assertIsolated(); // Any script-cache access is recorded even when the proxy catches the exception.
});

test('valid empty searches are explicit and expire after five minutes', () => {
  const f = fixture({ body: '[]' });
  const first = f.search();
  assert.equal(first.ok, true);
  assert.equal(first.status, 'empty');
  assert.equal(first.count, 0);
  assert.deepEqual(first.records, []);
  assert.equal(f.writes[0].seconds, 300);
  f.advance(299999);
  assert.equal(f.search().cached, true);
  f.advance(1);
  assert.equal(f.search().cached, false);
  assert.equal(f.requests.length, 2);
  f.assertIsolated();
});

test('cache corruption, eviction, and unavailable cache do not lose valid upstream results', () => {
  const f = fixture();
  f.search();
  const key = f.writes[0].key;
  f.cache.set(key, { value: '{broken', expires: Infinity });
  assert.equal(f.search().ok, true);
  f.cache.clear();
  assert.equal(f.search().ok, true);
  assert.equal(f.requests.length, 3);
  const unavailable = fixture({ cacheUnavailable: true });
  assert.equal(unavailable.search().ok, true);
  assert.equal(unavailable.search().ok, true);
  assert.equal(unavailable.requests.length, 2);
  f.assertIsolated();
  unavailable.assertIsolated();
});

test('cache limit counts UTF-8 bytes without rejecting an otherwise valid search', () => {
  const small = fixture({ body: JSON.stringify([row({ title: 'a'.repeat(40000) })]) });
  assert.equal(small.search().ok, true);
  assert.equal(small.writes.length, 1);
  const large = fixture({ body: JSON.stringify([row({ title: '한'.repeat(40000) })]) });
  assert.equal(large.search().ok, true);
  assert.equal(large.writes.length, 0);
  assert.equal(large.search().cached, false);
  assert.equal(large.requests.length, 2);
  large.assertIsolated();
});

test('upstream network and HTTP failures stay errors, are not cached, and do not expose internals', () => {
  const offline = fixture({ networkError: 'private internal credential test-secret' });
  error(offline.search(), 'UPSTREAM_NETWORK', true);
  assert.ok(!JSON.stringify(offline.search()).includes('test-secret'));
  assert.equal(offline.requests.length, 2);
  assert.equal(offline.writes.length, 0);
  for (const [status, retryable] of [[301, false], [403, false], [404, false], [429, true], [503, true]]) {
    const f = fixture({ status, body: '<html>upstream error</html>' });
    const result = f.search();
    error(result, 'UPSTREAM_HTTP', retryable);
    assert.equal(result.upstream_status, status);
    assert.equal(f.requests.length, 1, 'no hidden retries or redirects');
    assert.equal(f.writes.length, 0);
    f.assertIsolated();
  }
  offline.assertIsolated();
});

test('malformed and unexpected upstream search payloads cannot become empty successes', () => {
  const bodies = ['', '[', '<html>maintenance</html>', '{}', 'null', '[null]', '["x"]',
    JSON.stringify([{ file: '1539951' }]), JSON.stringify([row({ file: '../bad' })])];
  for (const body of bodies) {
    const f = fixture({ body });
    error(f.search(), 'UPSTREAM_INVALID', true);
    assert.equal(f.writes.length, 0);
    f.assertIsolated();
  }
});

test('search enforces byte and record ceilings without silently truncating valid results', () => {
  const tooLarge = fixture({ body: JSON.stringify([row({ title: '한'.repeat(350000) })]) });
  error(tooLarge.search(), 'UPSTREAM_TOO_LARGE', false);
  assert.equal(tooLarge.writes.length, 0);
  const rows = Array.from({ length: 500 }, (_, i) => row({ file: String(1000000 + i) }));
  const atLimit = fixture({ body: JSON.stringify(rows) });
  assert.equal(atLimit.search().count, 500);
  const overLimit = fixture({ body: JSON.stringify(rows.concat(row({ file: '2000000' }))) });
  error(overLimit.search(), 'TOO_MANY_RESULTS', false);
  assert.equal(overLimit.writes.length, 0);
  tooLarge.assertIsolated();
  atLimit.assertIsolated();
  overLimit.assertIsolated();
});

test('CIF returns unchanged UTF-8 text and uses a separate six-hour cache', () => {
  const f = fixture({ body: cif });
  const first = f.get({ action: 'cif', id: '1539951' });
  assert.equal(first.mimeType, 'text/plain');
  assert.equal(first.content, cif);
  assert.equal(f.requests[0].url, BASE + '/1539951.cif');
  assert.equal(f.writes[0].seconds, 21600);
  f.advance(21599999);
  assert.equal(f.get({ action: 'cif', id: '1539951' }).content, cif);
  assert.equal(f.requests.length, 1);
  f.advance(1);
  assert.equal(f.get({ action: 'cif', id: '1539951' }).content, cif);
  assert.equal(f.requests.length, 2);
  f.assertIsolated();
});

test('CIF IDs reject paths, URLs, wrong lengths, and leading zero without a fetch', () => {
  for (const id of [undefined, '', '0153995', '153995', '15399511', '1539951.cif',
    '../1539951', 'https://example.com/1539951', '1539951?x=1', '1539951\n']) {
    const f = fixture({ body: cif });
    error(decode(f.get({ action: 'cif', id })), 'INVALID_ID', false);
    assert.equal(f.requests.length, 0, String(id));
    f.assertIsolated();
  }
});

test('CIF rejects missing tags, wrong data block, HTML and oversized UTF-8 bodies', () => {
  for (const body of [cif.replace('data_1539951', 'data_1539952'),
    cif.replace('_cell_angle_gamma 90\r\n', ''), '<html>' + cif + '</html>', '']) {
    const f = fixture({ body });
    error(decode(f.get({ action: 'cif', id: '1539951' })), 'UPSTREAM_INVALID', true);
    assert.equal(f.writes.length, 0);
    f.assertIsolated();
  }
  const tooLarge = fixture({ body: cif + '# ' + '한'.repeat(175000) });
  error(decode(tooLarge.get({ action: 'cif', id: '1539951' })), 'UPSTREAM_TOO_LARGE', false);
  assert.equal(tooLarge.writes.length, 0);
  const uncached = fixture({ body: cif + '# ' + '한'.repeat(40000) });
  assert.equal(uncached.get({ action: 'cif', id: '1539951' }).mimeType, 'text/plain');
  assert.equal(uncached.writes.length, 0);
  tooLarge.assertIsolated();
  uncached.assertIsolated();
});

test('COD/CIF form and JSON POSTs reject before touching lab services or counters', () => {
  for (const action of ['cod', 'cif']) {
    for (const event of [
      { parameter: { action, formula: 'VO2', id: '1539951' } },
      { postData: { contents: JSON.stringify({ action, formula: 'VO2', id: '1539951' }) } },
      { parameter: { action }, postData: { contents: '{malformed' } }
    ]) {
      const f = fixture();
      error(f.post(event), 'METHOD_NOT_ALLOWED', false);
      assert.equal(f.requests.length, 0);
      assert.equal(f.writes.length, 0);
      f.assertIsolated();
    }
  }
});

test('valid JSON POST with leading whitespace rejects before inventory authentication', () => {
  for (const action of ['cod', 'cif']) {
    const f = fixture();
    error(f.post({ postData: { contents: ' \r\n\t' + JSON.stringify({ action }) } }),
      'METHOD_NOT_ALLOWED', false);
    assert.equal(f.requests.length, 0);
    f.assertIsolated();
  }
});
