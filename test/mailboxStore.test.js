'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MailboxStore, generateUUIDv7, DEFAULT_CHANNEL, SCHEMA_VERSION, PROXY_PROTOCOL_VERSION } = require('../src/proxy/mailbox/store');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-test-'));
}

describe('generateUUIDv7', () => {
  it('returns a valid UUID v7 format', () => {
    const id = generateUUIDv7();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) ids.add(generateUUIDv7());
    assert.equal(ids.size, 1000);
  });

  it('generates IDs with non-decreasing timestamp prefix', () => {
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(generateUUIDv7());
    for (let i = 1; i < ids.length; i++) {
      const prevTs = ids[i - 1].slice(0, 13);
      const currTs = ids[i].slice(0, 13);
      assert.ok(currTs >= prevTs, `timestamp prefix should be non-decreasing: ${prevTs} <= ${currTs}`);
    }
  });
});

describe('MailboxStore', () => {
  let store;
  let dataDir;

  before(() => {
    dataDir = tmpDataDir();
    store = new MailboxStore(dataDir);
  });

  after(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
  });

  describe('send()', () => {
    it('creates an outbound message with correct fields', () => {
      const result = store.send({ type: 'asset_submit', payload: { data: 'test' } });
      assert.ok(result.message_id);
      assert.equal(result.status, 'pending');

      const msg = store.getById(result.message_id);
      assert.equal(msg.direction, 'outbound');
      assert.equal(msg.type, 'asset_submit');
      assert.equal(msg.status, 'pending');
      assert.equal(msg.channel, DEFAULT_CHANNEL);
      assert.deepEqual(msg.payload, { data: 'test' });
      assert.equal(msg.priority, 'normal');
    });

    it('supports custom channel and priority', () => {
      const result = store.send({
        type: 'dm',
        payload: { text: 'hello' },
        channel: 'custom-channel',
        priority: 'high',
      });
      const msg = store.getById(result.message_id);
      assert.equal(msg.channel, 'custom-channel');
      assert.equal(msg.priority, 'high');
    });

    it('supports string payload', () => {
      const result = store.send({ type: 'test', payload: '{"raw": true}' });
      const msg = store.getById(result.message_id);
      assert.deepEqual(msg.payload, { raw: true });
    });
  });

  describe('writeInbound()', () => {
    it('creates an inbound message', () => {
      const id = store.writeInbound({ type: 'task_available', payload: { task_id: 't1' } });
      assert.ok(id);

      const msg = store.getById(id);
      assert.equal(msg.direction, 'inbound');
      assert.equal(msg.type, 'task_available');
      assert.equal(msg.status, 'pending');
    });

    it('accepts a custom id', () => {
      const customId = generateUUIDv7();
      const id = store.writeInbound({ id: customId, type: 'hub_event', payload: {} });
      assert.equal(id, customId);
    });

    it('ignores duplicate inbound ids', () => {
      const store2 = new MailboxStore(tmpDataDir());
      const customId = generateUUIDv7();

      store2.writeInbound({ id: customId, type: 'hub_event', payload: { n: 1 } });
      const duplicateId = store2.writeInbound({ id: customId, type: 'hub_event', payload: { n: 2 } });

      assert.equal(duplicateId, customId);
      assert.equal(store2.countPending({ direction: 'inbound' }), 1);
      assert.deepEqual(store2.poll({ type: 'hub_event' }).map(m => m.payload), [{ n: 1 }]);
      store2.close();
    });
  });

  describe('writeInboundBatch()', () => {
    it('writes multiple inbound messages', () => {
      const ids = store.writeInboundBatch([
        { type: 'dm', payload: { text: 'a' } },
        { type: 'dm', payload: { text: 'b' } },
        { type: 'dm', payload: { text: 'c' } },
      ]);
      assert.equal(ids.length, 3);
      for (const id of ids) {
        const msg = store.getById(id);
        assert.ok(msg);
        assert.equal(msg.direction, 'inbound');
      }
    });
  });

  describe('poll()', () => {
    it('returns pending inbound messages', () => {
      const store2 = new MailboxStore(tmpDataDir());
      store2.writeInbound({ type: 'task_available', payload: { id: 1 } });
      store2.writeInbound({ type: 'task_available', payload: { id: 2 } });
      store2.writeInbound({ type: 'hub_event', payload: { id: 3 } });

      const all = store2.poll();
      assert.equal(all.length, 3);

      const tasks = store2.poll({ type: 'task_available' });
      assert.equal(tasks.length, 2);

      store2.close();
    });

    it('respects limit', () => {
      const store2 = new MailboxStore(tmpDataDir());
      for (let i = 0; i < 10; i++) {
        store2.writeInbound({ type: 'test', payload: { i } });
      }
      const limited = store2.poll({ limit: 3 });
      assert.equal(limited.length, 3);
      store2.close();
    });
  });

  describe('pollOutbound()', () => {
    it('returns pending outbound messages ordered by priority', () => {
      const store2 = new MailboxStore(tmpDataDir());
      store2.send({ type: 'low', payload: {}, priority: 'low' });
      store2.send({ type: 'high', payload: {}, priority: 'high' });
      store2.send({ type: 'normal', payload: {} });

      const msgs = store2.pollOutbound();
      assert.equal(msgs[0].priority, 'high');
      store2.close();
    });
  });

  describe('ack()', () => {
    it('marks inbound messages as delivered', () => {
      const store2 = new MailboxStore(tmpDataDir());
      const id = store2.writeInbound({ type: 'test', payload: {} });

      const count = store2.ack(id);
      assert.equal(count, 1);

      const msg = store2.getById(id);
      assert.equal(msg.status, 'delivered');
      store2.close();
    });

    it('does not ack outbound messages', () => {
      const store2 = new MailboxStore(tmpDataDir());
      const { message_id } = store2.send({ type: 'test', payload: {} });

      const count = store2.ack(message_id);
      assert.equal(count, 0);

      const msg = store2.getById(message_id);
      assert.equal(msg.status, 'pending');
      store2.close();
    });
  });

  describe('updateStatus()', () => {
    it('updates status and synced_at', () => {
      const { message_id } = store.send({ type: 'status_test', payload: {} });
      store.updateStatus(message_id, 'synced');

      const msg = store.getById(message_id);
      assert.equal(msg.status, 'synced');
      assert.ok(msg.synced_at);
    });

    it('records error on failure', () => {
      const { message_id } = store.send({ type: 'fail_test', payload: {} });
      store.updateStatus(message_id, 'failed', { error: 'timeout' });

      const msg = store.getById(message_id);
      assert.equal(msg.status, 'failed');
      assert.equal(msg.error, 'timeout');
    });
  });

  describe('incrementRetry()', () => {
    it('increments retry count and records error', () => {
      const { message_id } = store.send({ type: 'retry_test', payload: {} });
      store.incrementRetry(message_id, 'first error');
      store.incrementRetry(message_id, 'second error');

      const msg = store.getById(message_id);
      assert.equal(msg.retry_count, 2);
      assert.equal(msg.error, 'second error');
    });
  });

  describe('list()', () => {
    it('lists messages by type', () => {
      const store2 = new MailboxStore(tmpDataDir());
      store2.send({ type: 'list_test', payload: { n: 1 } });
      store2.send({ type: 'list_test', payload: { n: 2 } });
      store2.send({ type: 'other', payload: {} });

      const results = store2.list({ type: 'list_test' });
      assert.equal(results.length, 2);
      store2.close();
    });

    it('requires type parameter', () => {
      assert.throws(() => store.list({}), /type is required/);
    });
  });

  describe('countPending()', () => {
    it('counts pending messages', () => {
      const store2 = new MailboxStore(tmpDataDir());
      store2.send({ type: 'a', payload: {} });
      store2.send({ type: 'b', payload: {} });
      store2.writeInbound({ type: 'c', payload: {} });

      assert.equal(store2.countPending({ direction: 'outbound' }), 2);
      assert.equal(store2.countPending({ direction: 'inbound' }), 1);
      store2.close();
    });
  });

  describe('sync cursors', () => {
    it('gets and sets cursors', () => {
      store.setCursor('evomap-hub:inbound_cursor', 'cursor_123');
      assert.equal(store.getCursor('evomap-hub:inbound_cursor'), 'cursor_123');

      store.setCursor('evomap-hub:inbound_cursor', 'cursor_456');
      assert.equal(store.getCursor('evomap-hub:inbound_cursor'), 'cursor_456');
    });

    it('returns null for missing cursor', () => {
      assert.equal(store.getCursor('nonexistent'), null);
    });
  });

  describe('local state', () => {
    it('gets and sets state', () => {
      store.setState('node_id', 'node_abc123');
      assert.equal(store.getState('node_id'), 'node_abc123');
    });

    it('overwrites existing state', () => {
      store.setState('counter', '1');
      store.setState('counter', '2');
      assert.equal(store.getState('counter'), '2');
    });
  });

  describe('persistence', () => {
    it('survives restart by re-reading JSONL', () => {
      const dir = tmpDataDir();
      const s1 = new MailboxStore(dir);
      s1.send({ type: 'persist_test', payload: { val: 42 } });
      s1.setState('my_key', 'my_val');
      s1.setCursor('test:cursor', 'c1');
      s1.close();

      const s2 = new MailboxStore(dir);
      const msgs = s2.pollOutbound();
      assert.ok(msgs.length >= 1);
      assert.equal(msgs.find(m => m.type === 'persist_test').payload.val, 42);
      assert.equal(s2.getState('my_key'), 'my_val');
      assert.equal(s2.getCursor('test:cursor'), 'c1');
      s2.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });
  });

  describe('compact()', () => {
    it('reduces file size by collapsing updates', () => {
      const dir = tmpDataDir();
      const s = new MailboxStore(dir);
      const { message_id } = s.send({ type: 'compact_test', payload: {} });
      s.updateStatus(message_id, 'synced');
      s.updateStatus(message_id, 'delivered');
      s.incrementRetry(message_id, 'err');

      const sizeBefore = fs.statSync(s._messagesFile).size;
      s.compact();
      const sizeAfter = fs.statSync(s._messagesFile).size;
      assert.ok(sizeAfter < sizeBefore, 'compaction should reduce file size');

      const msg = s.getById(message_id);
      assert.equal(msg.status, 'delivered');
      s.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });
  });

  describe('schema version and migration', () => {
    it('writes schema version to state on fresh init', () => {
      const dir = tmpDataDir();
      const s = new MailboxStore(dir);
      const stateRaw = JSON.parse(fs.readFileSync(s._stateFile, 'utf8'));
      assert.equal(stateRaw._schema_version, SCHEMA_VERSION);
      s.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });

    it('preserves schema version across restart', () => {
      const dir = tmpDataDir();
      const s1 = new MailboxStore(dir);
      s1.close();
      const s2 = new MailboxStore(dir);
      const stateRaw = JSON.parse(fs.readFileSync(s2._stateFile, 'utf8'));
      assert.equal(stateRaw._schema_version, SCHEMA_VERSION);
      s2.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });

    it('runs migrations when state has older schema version', () => {
      const dir = tmpDataDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'state.json'),
        JSON.stringify({ _schema_version: 0 }) + '\n',
        'utf8'
      );
      const s = new MailboxStore(dir);
      const stateRaw = JSON.parse(fs.readFileSync(s._stateFile, 'utf8'));
      assert.equal(stateRaw._schema_version, SCHEMA_VERSION);
      s.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });
  });

  describe('exports', () => {
    it('exports PROXY_PROTOCOL_VERSION as a semver string', () => {
      assert.match(PROXY_PROTOCOL_VERSION, /^\d+\.\d+\.\d+$/);
    });

    it('exports SCHEMA_VERSION as a positive integer', () => {
      assert.equal(typeof SCHEMA_VERSION, 'number');
      assert.ok(SCHEMA_VERSION >= 1);
    });
  });

  describe('prototype pollution hardening (GHSA-2cjr-5v3h-v2w4)', () => {
    it('strips __proto__ from update rows when rebuilding from JSONL', () => {
      const dir = tmpDataDir();
      fs.mkdirSync(dir, { recursive: true });
      const msgFile = path.join(dir, 'messages.jsonl');
      fs.writeFileSync(
        msgFile,
        JSON.stringify({
          id: 'msg-1',
          channel: DEFAULT_CHANNEL,
          direction: 'inbound',
          type: 'test',
          status: 'pending',
          payload: {},
          priority: 'normal',
          created_at: Date.now(),
        }) + '\n' +
        JSON.stringify({
          _op: 'update',
          id: 'msg-1',
          fields: {
            __proto__: { polluted: true, isAdmin: true },
            status: 'synced',
          },
        }) + '\n',
        'utf8'
      );

      const s = new MailboxStore(dir);
      const probe = {};
      assert.equal(probe.polluted, undefined, 'Object.prototype must not be polluted');
      assert.equal(probe.isAdmin, undefined, 'Object.prototype must not be polluted');
      s.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });

    it('strips constructor/prototype from raw message rows', () => {
      const dir = tmpDataDir();
      fs.mkdirSync(dir, { recursive: true });
      const msgFile = path.join(dir, 'messages.jsonl');
      fs.writeFileSync(
        msgFile,
        JSON.stringify({
          id: 'msg-1',
          channel: DEFAULT_CHANNEL,
          direction: 'inbound',
          type: 'test',
          status: 'pending',
          payload: {},
          priority: 'normal',
          created_at: Date.now(),
          constructor: { prototype: { evil: true } },
          prototype: { evil: true },
        }) + '\n',
        'utf8'
      );

      const s = new MailboxStore(dir);
      const probe = {};
      assert.equal(probe.evil, undefined, 'Object.prototype must not be polluted');
      s.close();
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    });
  });
});
