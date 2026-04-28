'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MailboxStore } = require('../src/proxy/mailbox/store');
const { SkillUpdater } = require('../src/proxy/extensions/skillUpdater');
const { DmHandler } = require('../src/proxy/extensions/dmHandler');
const { SessionHandler } = require('../src/proxy/extensions/sessionHandler');

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'extensions-test-'));
}

describe('SkillUpdater', () => {
  let store, dataDir, skillDir;

  before(() => {
    dataDir = tmpDataDir();
    skillDir = tmpDataDir();
    store = new MailboxStore(dataDir);
  });

  after(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
    try { fs.rmSync(skillDir, { recursive: true }); } catch {}
  });

  function withHash(content, version) {
    return {
      content,
      version,
      sha256: require('crypto').createHash('sha256').update(content, 'utf8').digest('hex'),
    };
  }

  it('updates skill.md from inbound message', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    const updater = new SkillUpdater({
      store,
      skillPath,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    const result = updater.processSkillUpdate({
      payload: withHash('# Updated Skill\nNew content here.', '1.1.0'),
    });
    assert.equal(result, true);
    assert.equal(fs.readFileSync(skillPath, 'utf8'), '# Updated Skill\nNew content here.');
    assert.equal(store.getState('skill_version'), '1.1.0');
  });

  it('creates backup before overwriting', () => {
    const skillPath = path.join(skillDir, 'SKILL2.md');
    fs.writeFileSync(skillPath, 'original content', 'utf8');

    const updater = new SkillUpdater({
      store,
      skillPath,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    updater.processSkillUpdate({
      payload: withHash('updated content', '2.0'),
    });
    assert.equal(fs.readFileSync(skillPath, 'utf8'), 'updated content');
    assert.equal(fs.readFileSync(skillPath + '.bak', 'utf8'), 'original content');
  });

  it('returns false without skill path', () => {
    const updater = new SkillUpdater({
      store,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.equal(updater.processSkillUpdate({ payload: { content: 'x' } }), false);
  });

  it('returns false without content', () => {
    const updater = new SkillUpdater({
      store,
      skillPath: path.join(skillDir, 'noop.md'),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.equal(updater.processSkillUpdate({ payload: {} }), false);
  });

  it('returns false without a payload hash by default', () => {
    const updater = new SkillUpdater({
      store,
      skillPath: path.join(skillDir, 'unsigned.md'),
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    assert.equal(
      updater.processSkillUpdate({ payload: { content: 'unsigned content', version: '0.1.0' } }),
      false,
    );
  });

  it('pollAndApply processes pending skill_update messages', () => {
    const dir2 = tmpDataDir();
    const s2 = new MailboxStore(dir2);
    const sp = path.join(skillDir, 'polled.md');

    s2.writeInbound({
      type: 'skill_update',
      payload: withHash('# Polled skill', '3.0'),
    });

    const updater = new SkillUpdater({
      store: s2,
      skillPath: sp,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    const applied = updater.pollAndApply();
    assert.equal(applied, 1);
    assert.equal(fs.readFileSync(sp, 'utf8'), '# Polled skill');
    s2.close();
    try { fs.rmSync(dir2, { recursive: true }); } catch {}
  });
});

describe('DmHandler', () => {
  let store, handler, dataDir;

  before(() => {
    dataDir = tmpDataDir();
    store = new MailboxStore(dataDir);
    handler = new DmHandler({ store });
  });

  after(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
  });

  it('sends a DM and creates outbound message', () => {
    const result = handler.send({
      recipientNodeId: 'node_abc',
      content: 'Hello there',
    });
    assert.ok(result.message_id);
    assert.equal(result.status, 'pending');

    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'dm');
    assert.equal(msg.direction, 'outbound');
    assert.equal(msg.payload.recipient_node_id, 'node_abc');
    assert.equal(msg.payload.content, 'Hello there');
  });

  it('throws on missing recipientNodeId', () => {
    assert.throws(() => handler.send({ content: 'x' }), /recipientNodeId/);
  });

  it('throws on missing content', () => {
    assert.throws(() => handler.send({ recipientNodeId: 'n' }), /content/);
  });

  it('polls inbound DMs', () => {
    store.writeInbound({ type: 'dm', payload: { content: 'incoming dm' } });
    const msgs = handler.poll();
    assert.ok(msgs.length >= 1);
    assert.equal(msgs[0].type, 'dm');
  });

  it('acks DM messages', () => {
    const id = store.writeInbound({ type: 'dm', payload: { content: 'to ack' } });
    const count = handler.ack(id);
    assert.equal(count, 1);
    const msg = store.getById(id);
    assert.equal(msg.status, 'delivered');
  });

  it('lists DM history', () => {
    const msgs = handler.list();
    assert.ok(Array.isArray(msgs));
  });
});

describe('SessionHandler', () => {
  let store, handler, dataDir;

  before(() => {
    dataDir = tmpDataDir();
    store = new MailboxStore(dataDir);
    handler = new SessionHandler({ store });
  });

  after(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true }); } catch {}
  });

  it('creates a session and stores outbound message', () => {
    const result = handler.createSession({
      title: 'Test Session',
      description: 'A test collaboration session',
      inviteNodeIds: ['node_a', 'node_b'],
    });
    assert.ok(result.message_id);
    assert.equal(result.status, 'pending');

    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_create');
    assert.equal(msg.direction, 'outbound');
    assert.equal(msg.payload.title, 'Test Session');
    assert.deepEqual(msg.payload.invite_node_ids, ['node_a', 'node_b']);
  });

  it('throws on missing title', () => {
    assert.throws(() => handler.createSession({}), /title/);
  });

  it('joins a session', () => {
    const result = handler.joinSession({ sessionId: 'sess_123' });
    assert.ok(result.message_id);
    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_join');
    assert.equal(msg.payload.session_id, 'sess_123');
  });

  it('throws on join without sessionId', () => {
    assert.throws(() => handler.joinSession({}), /sessionId/);
  });

  it('leaves a session', () => {
    const result = handler.leaveSession({ sessionId: 'sess_456' });
    assert.ok(result.message_id);
    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_leave');
  });

  it('sends a message to a session', () => {
    const result = handler.sendMessage({
      sessionId: 'sess_789',
      toNodeId: 'node_c',
      msgType: 'context_update',
      payload: { key: 'value' },
    });
    assert.ok(result.message_id);
    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_message');
    assert.equal(msg.payload.session_id, 'sess_789');
    assert.equal(msg.payload.to_node_id, 'node_c');
  });

  it('throws on send message with oversized payload', () => {
    const bigPayload = { data: 'x'.repeat(17000) };
    assert.throws(() => handler.sendMessage({
      sessionId: 'sess_big',
      payload: bigPayload,
    }), /too large/);
  });

  it('delegates a subtask', () => {
    const result = handler.delegateSubtask({
      sessionId: 'sess_del',
      toNodeId: 'node_worker',
      title: 'Implement feature X',
      role: 'builder',
    });
    assert.ok(result.message_id);
    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_delegate');
    assert.equal(msg.payload.role, 'builder');
    assert.equal(msg.payload.title, 'Implement feature X');
  });

  it('normalizes invalid role to builder', () => {
    const result = handler.delegateSubtask({
      sessionId: 'sess_role',
      title: 'Fix bug',
      role: 'invalid_role',
    });
    const msg = store.getById(result.message_id);
    assert.equal(msg.payload.role, 'builder');
  });

  it('submits a result', () => {
    const result = handler.submitResult({
      sessionId: 'sess_sub',
      taskId: 'task_1',
      resultAssetId: 'asset_1',
      summary: 'Completed the implementation',
    });
    assert.ok(result.message_id);
    const msg = store.getById(result.message_id);
    assert.equal(msg.type, 'session_submit');
    assert.equal(msg.payload.task_id, 'task_1');
  });

  it('polls session invites', () => {
    store.writeInbound({ type: 'collaboration_invite', payload: { session_id: 's1' } });
    const msgs = handler.pollInvites();
    assert.ok(msgs.length >= 1);
  });

  it('lists active sessions', () => {
    const sessions = handler.listActiveSessions();
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length > 0);
  });
});
