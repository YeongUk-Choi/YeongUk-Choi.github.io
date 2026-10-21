/* Local Apps Script contract tests. All codes and keys below are synthetic fixtures.
   Run: node --test scripts/apps-script/test_xrd_auth.cjs */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'he-inventory.gs'), 'utf8');
const KEY = Buffer.alloc(32, 7).toString('base64');
const BUILD = 'a'.repeat(64);

function fixture(overrides = {}) {
  let now = 1700000000000;
  let held = false;
  let lockError = null;
  let acquisitions = 0;
  let releases = 0;
  const reads = [];
  const props = new Map(Object.entries({ EDIT_CODE: 'test-edit-code', PUSH_CODE: 'test-push-code',
    XRD_CODE: 'test-xrd-code', XRD_APP_KEY: KEY, XRD_APP_VERSION: BUILD, ...overrides }));
  const cache = new Map();
  const properties = {
    getProperty(name) { reads.push(name); return props.get(name) ?? null; },
    setProperty(name, value) {
      assert.ok(held, 'XRD counter mutation needs the script lock');
      props.set(name, value);
    },
    deleteProperty(name) {
      assert.ok(held, 'XRD counter deletion needs the script lock');
      props.delete(name);
    }
  };
  const cacheService = {
    get(name) {
      const hit = cache.get(name);
      if (!hit || now >= hit.expires) return null;
      return hit.value;
    },
    put(name, value, ttl) { cache.set(name, { value, expires: now + ttl * 1000 }); },
    remove(name) { cache.delete(name); }
  };
  class MockDate extends Date { static now() { return now; } }
  const context = vm.createContext({
    Date: MockDate,
    PropertiesService: { getScriptProperties: () => properties },
    CacheService: { getScriptCache: () => cacheService },
    LockService: { getScriptLock: () => ({
      waitLock(timeout) {
        assert.equal(timeout, 10000);
        assert.equal(held, false, 'script locks must not be nested');
        if (lockError) throw new Error(lockError);
        held = true; acquisitions++;
      },
      releaseLock() {
        assert.equal(held, true, 'release only an acquired lock');
        held = false; releases++;
      }
    }) },
    Utilities: {
      base64Decode: value => Array.from(Buffer.from(value, 'base64')),
      base64Encode: bytes => Buffer.from(bytes).toString('base64')
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({ content,
        setMimeType(type) { assert.equal(type, 'application/json'); return this; } })
    }
  });
  vm.runInContext(source, context, { filename: 'he-inventory.gs' });
  return {
    context, props, cache, reads,
    post(code = 'test-xrd-code', extra = {}) {
      return JSON.parse(context.doPost({ parameter: { action: 'xrdkey', code }, ...extra }).content);
    },
    get(code = 'test-xrd-code') {
      return JSON.parse(context.doGet({ parameter: { action: 'xrdkey', code } }).content);
    },
    advance(ms) { now += ms; },
    failLock(message) { lockError = message; },
    assertUnlocked() { assert.equal(held, false); assert.equal(acquisitions, releases); }
  };
}

function assertDenied(reply) {
  assert.equal(reply.ok, false);
  assert.equal(typeof reply.error, 'string');
  assert.deepEqual(Object.keys(reply).sort(), ['error', 'ok']);
  assert.ok(!JSON.stringify(reply).includes(KEY));
  assert.ok(!JSON.stringify(reply).includes(BUILD));
}

test('correct POST form returns only key, protocol version and build', () => {
  const f = fixture();
  assert.deepEqual(f.post(), { ok: true, key: KEY, version: 1, build: BUILD });
  f.assertUnlocked();
});

test('GET cannot disclose a key, even with a correct password; it does not alter counters', () => {
  const f = fixture();
  assertDenied(f.get());
  assert.match(f.get().error, /Use POST/);
  assert.deepEqual(f.reads, []);
  assert.equal(f.props.has('xrd_fails'), false);
  f.assertUnlocked();
});

test('JSON action=xrdkey cannot reach the POST form key route', () => {
  const f = fixture();
  assertDenied(f.post('test-xrd-code', { postData: {
    contents: JSON.stringify({ action: 'xrdkey', code: 'test-xrd-code' })
  } }));
  assert.equal(f.reads.includes('XRD_APP_KEY'), false);
  f.assertUnlocked();
});

test('wrong and missing passwords reveal neither key nor build and do not read either property', () => {
  const f = fixture();
  for (const code of ['wrong', '', null]) assertDenied(f.post(code));
  assert.equal(f.reads.includes('XRD_APP_KEY'), false);
  assert.equal(f.reads.includes('XRD_APP_VERSION'), false);
  assert.equal(JSON.parse(f.props.get('xrd_fails')).value, '3');
  assert.equal(f.cache.size, 0);
  f.assertUnlocked();
});

test('the fifth wrong password locks XRD for ten minutes, including correct passwords', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) assert.equal(f.post('wrong').error, 'Wrong code.');
  assert.ok(f.props.has('xrd_lockout'));
  assert.match(f.post().error, /Too many wrong codes/);
  f.advance(599999);
  assert.match(f.post().error, /Too many wrong codes/);
  f.advance(1);
  assert.equal(f.post().ok, true);
  assert.equal(f.props.has('xrd_fails'), false);
  assert.equal(f.props.has('xrd_lockout'), false);
  f.assertUnlocked();
});

test('XRD lockout survives cache eviction', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.post('wrong');
  f.cache.clear();
  assert.match(f.post().error, /Too many wrong codes/);
  f.assertUnlocked();
});

test('successful password resets the XRD failure streak', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.post('wrong');
  assert.equal(f.post().ok, true);
  assert.equal(f.props.has('xrd_fails'), false);
  f.post('wrong');
  assert.equal(JSON.parse(f.props.get('xrd_fails')).value, '1');
  assert.equal(f.props.has('xrd_lockout'), false);
  f.assertUnlocked();
});

test('failure streak expires after ten quiet minutes and each failure renews that window', () => {
  const f = fixture();
  f.post('wrong');
  f.advance(599999);
  f.post('wrong');
  assert.equal(JSON.parse(f.props.get('xrd_fails')).value, '2');
  f.advance(600000);
  f.post('wrong');
  assert.equal(JSON.parse(f.props.get('xrd_fails')).value, '1');
  f.assertUnlocked();
});

test('editing and XRD passwords cannot be interchanged', () => {
  const f = fixture();
  assertDenied(f.post('test-edit-code'));
  assert.throws(() => f.context.requireCode('test-xrd-code'), /Wrong code/);
  assert.doesNotThrow(() => f.context.requireCode('test-edit-code'));
  assert.equal(f.post().ok, true);
  f.assertUnlocked();
});

test('XRD lockout does not block inventory or collector, nor alter their counters', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.post('wrong');
  assert.doesNotThrow(() => f.context.requireCode('test-edit-code'));
  assert.doesNotThrow(() => f.context.requirePushCode('test-push-code'));
  assert.equal(f.cache.size, 0);
  f.assertUnlocked();
});

test('legacy inventory and collector lockouts do not block XRD', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    assert.throws(() => f.context.requireCode('wrong'), /Wrong code/);
    assert.throws(() => f.context.requirePushCode('wrong'), /Wrong push code/);
  }
  assert.throws(() => f.context.requireCode('test-edit-code'), /Too many wrong codes/);
  assert.throws(() => f.context.requirePushCode('test-push-code'), /Too many wrong push codes/);
  assert.equal(f.post().ok, true);
  assert.equal(f.props.has('xrd_lockout'), false);
  f.assertUnlocked();
});

test('legacy EDIT_CODE success/reset/expiry semantics stay unchanged', () => {
  const f = fixture();
  assert.throws(() => f.context.requireCode('wrong'), /Wrong code/);
  assert.ok(f.cache.has('fails'));
  f.context.requireCode('test-edit-code');
  assert.equal(f.cache.has('fails'), false);
  for (let i = 0; i < 5; i++) assert.throws(() => f.context.requireCode('wrong'), /Wrong code/);
  f.advance(600000);
  assert.doesNotThrow(() => f.context.requireCode('test-edit-code'));
  assert.throws(() => fixture({ EDIT_CODE: '' }).context.requireCode('anything'), /EDIT_CODE is not set/);
  f.assertUnlocked();
});

test('absent XRD_CODE fails closed without touching key/version', () => {
  const f = fixture({ XRD_CODE: '' });
  assertDenied(f.post());
  assert.equal(f.reads.includes('XRD_APP_KEY'), false);
  assert.equal(f.reads.includes('XRD_APP_VERSION'), false);
  f.assertUnlocked();
});

test('malformed or missing key configuration fails closed after password validation', () => {
  const invalidKeys = [null, '', ' ', KEY + '\n', KEY.slice(0, -1),
    Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'),
    KEY.slice(0, -2) + 'd=', '-'.repeat(43) + '='];
  for (const key of invalidKeys) {
    const f = fixture({ XRD_APP_KEY: key });
    assertDenied(f.post('wrong'));
    assert.equal(f.reads.includes('XRD_APP_KEY'), false);
    const reply = f.post();
    assertDenied(reply);
    assert.equal(reply.error, 'XRD app is not configured on the server.');
    f.assertUnlocked();
  }
});

test('malformed or missing build configuration fails closed after password validation', () => {
  for (const build of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), BUILD + '\n']) {
    const f = fixture({ XRD_APP_VERSION: build });
    assertDenied(f.post('wrong'));
    assert.equal(f.reads.includes('XRD_APP_VERSION'), false);
    const reply = f.post();
    assertDenied(reply);
    assert.equal(reply.error, 'XRD app is not configured on the server.');
    f.assertUnlocked();
  }
});

test('bad durable counter data fails closed and releases the script lock', () => {
  for (const counter of ['invalid JSON', 'null', '{}', '{"value":5,"expires":1800000000000}']) {
    const f = fixture();
    f.props.set('xrd_lockout', counter);
    assertDenied(f.post());
    assert.equal(f.reads.includes('XRD_APP_KEY'), false);
    f.assertUnlocked();
  }
});

test('failure to acquire lock returns no key and never releases an unheld lock', () => {
  const f = fixture();
  f.failLock('Timed out waiting for access.');
  assertDenied(f.post());
  assert.deepEqual(f.reads, []);
  f.assertUnlocked();
});
