/* Local Apps Script contract tests. All codes below are synthetic fixtures.
   Run: node --test scripts/apps-script/test_xrd_auth.cjs */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'he-inventory.gs'), 'utf8');

function fixture(overrides = {}) {
  let now = 1700000000000;
  let held = false;
  let lockError = null;
  let acquisitions = 0;
  let releases = 0;
  const reads = [];
  const props = new Map(Object.entries({ EDIT_CODE: 'test-edit-code', PUSH_CODE: 'test-push-code',
    XRD_CODE: 'test-xrd-code', ...overrides }));
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
      return JSON.parse(context.doPost({ parameter: { action: 'xrdcheck', code }, ...extra }).content);
    },
    get(code = 'test-xrd-code') {
      return JSON.parse(context.doGet({ parameter: { action: 'xrdcheck', code } }).content);
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
  for (const code of ['test-xrd-code', 'test-edit-code', 'test-push-code']) {
    assert.ok(!JSON.stringify(reply).includes(code));
  }
}

test('correct POST form returns exactly ok:true with no secrets or additional properties', () => {
  const f = fixture();
  assert.deepEqual(f.post(), { ok: true });
  assert.deepEqual(f.reads, ['xrd_lockout', 'XRD_CODE']);
  f.assertUnlocked();
});

test('GET rejects the check even with a correct password and does not alter counters', () => {
  const f = fixture();
  assertDenied(f.get());
  assert.match(f.get().error, /Use POST/);
  assert.deepEqual(f.reads, []);
  assert.equal(f.props.has('xrd_fails'), false);
  f.assertUnlocked();
});

test('JSON action=xrdcheck rejects without counting a wrong collector or inventory code', () => {
  const f = fixture();
  assertDenied(f.post('test-xrd-code', { postData: {
    contents: JSON.stringify({ action: 'xrdcheck', code: 'test-xrd-code' })
  } }));
  assert.deepEqual(f.reads, []);
  assert.equal(f.cache.size, 0);
  assert.equal(f.props.has('xrd_fails'), false);
  f.assertUnlocked();
});

test('legacy collector POST ping still uses PUSH_CODE and returns its normal response', () => {
  const f = fixture();
  const reply = JSON.parse(f.context.doPost({ postData: {
    contents: JSON.stringify({ action: 'ping', key: 'test-push-code' })
  } }).content);
  assert.equal(reply.ok, true);
  assert.equal(reply.stored, 0);
  assert.equal(typeof reply.server_ts, 'string');
  assert.deepEqual(f.reads, ['PUSH_CODE']);
  assert.equal(f.props.has('xrd_fails'), false);
  f.assertUnlocked();
});

test('wrong and missing passwords reveal no secrets and use only the XRD counter', () => {
  const f = fixture();
  for (const code of ['wrong', '', null]) assertDenied(f.post(code));
  assert.ok(f.reads.every(name => ['XRD_CODE', 'xrd_fails', 'xrd_lockout'].includes(name)));
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

test('editing, collector and XRD passwords cannot be interchanged', () => {
  const f = fixture();
  assertDenied(f.post('test-edit-code'));
  assertDenied(f.post('test-push-code'));
  assert.throws(() => f.context.requireCode('test-xrd-code'), /Wrong code/);
  assert.throws(() => f.context.requirePushCode('test-xrd-code'), /Wrong push code/);
  assert.doesNotThrow(() => f.context.requireCode('test-edit-code'));
  assert.doesNotThrow(() => f.context.requirePushCode('test-push-code'));
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

test('absent XRD_CODE fails closed', () => {
  const f = fixture({ XRD_CODE: '' });
  assertDenied(f.post());
  assert.deepEqual(f.reads, ['xrd_lockout', 'XRD_CODE']);
  f.assertUnlocked();
});

test('retired xrdkey action cannot affect inventory, collector or XRD counters via GET or POST', () => {
  const f = fixture();
  const propertiesBefore = [...f.props];
  for (let i = 0; i < 6; i++) {
    for (const code of ['wrong', 'test-xrd-code', 'test-edit-code']) {
      const event = { parameter: { action: 'xrdkey', code } };
      assertDenied(JSON.parse(f.context.doGet(event).content));
      assertDenied(JSON.parse(f.context.doPost(event).content));
    }
  }
  assert.deepEqual(f.reads, []);
  assert.deepEqual([...f.props], propertiesBefore);
  assert.equal(f.cache.size, 0);
  f.assertUnlocked();
});

test('retired xrdkey JSON requests reject without any credential checks or counter changes', () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    assertDenied(f.post('test-xrd-code', { postData: {
      contents: JSON.stringify({ action: 'xrdkey', code: 'test-xrd-code', key: 'test-push-code' })
    } }));
  }
  assert.deepEqual(f.reads, []);
  assert.equal(f.cache.size, 0);
  assert.equal(f.props.has('xrd_fails'), false);
  f.assertUnlocked();
});

test('bad durable counter data fails closed and releases the script lock', () => {
  for (const counter of ['invalid JSON', 'null', '{}', '{"value":5,"expires":1800000000000}']) {
    const f = fixture();
    f.props.set('xrd_lockout', counter);
    assertDenied(f.post());
    assert.deepEqual(f.reads, ['xrd_lockout']);
    f.assertUnlocked();
  }
});

test('failure to acquire lock rejects and never releases an unheld lock', () => {
  const f = fixture();
  f.failLock('Timed out waiting for access.');
  assertDenied(f.post());
  assert.deepEqual(f.reads, []);
  f.assertUnlocked();
});
