const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { _buildGene, _buildCapsule } = require('../src/atp/atpExecute');

describe('atpExecute._buildGene', () => {
  it('produces a valid Gene with deterministic asset_id for same caps', () => {
    const a = _buildGene(['code_evolution', 'debugging'], ['log_error']);
    const b = _buildGene(['debugging', 'code_evolution'], ['log_error']);
    assert.equal(a.type, 'Gene');
    assert.equal(typeof a.id, 'string');
    assert.ok(Array.isArray(a.strategy) && a.strategy.length >= 2);
    assert.ok(Array.isArray(a.validation) && a.validation.length >= 1);
    assert.equal(typeof a.asset_id, 'string');
    assert.ok(a.asset_id.startsWith('sha256:'));
    // Capability order should not affect the gene id -- we sort caps before building the id.
    assert.equal(a.asset_id, b.asset_id);
  });

  it('falls back to a default capability when none provided', () => {
    const g = _buildGene([], []);
    assert.equal(g.type, 'Gene');
    assert.ok(g.id.length > 0);
  });

  it('clamps capability and signal arrays', () => {
    const manyCaps = Array.from({ length: 30 }, function (_, i) { return 'cap_' + i; });
    const manySigs = Array.from({ length: 30 }, function (_, i) { return 'sig_' + i; });
    const g = _buildGene(manyCaps, manySigs);
    assert.ok(g.signals_match.length <= 8, 'signals_match should be clamped');
  });

  it('sanitizes capability and signal metadata', () => {
    const g = _buildGene(
      ['code_evolution', 'A2A_NODE_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'],
      ['task_for /home/alice/private']
    );
    assert.ok(!g.id.includes('A2A_NODE_SECRET'));
    assert.ok(g.signals_match[0].includes('[REDACTED]'));
  });
});

describe('atpExecute._buildCapsule', () => {
  it('produces a Capsule referencing its Gene and carrying the answer', () => {
    const gene = _buildGene(['documentation'], ['user_feature_request']);
    const capsule = _buildCapsule({
      gene: gene,
      answer: 'Here is a concrete outline: 1. install 2. configure 3. run',
      summary: 'Answer for documentation question',
      orderId: 'proof_abc123',
      taskId: 'task_xyz789',
      capabilities: ['documentation'],
      signals: ['user_feature_request'],
    });
    assert.equal(capsule.type, 'Capsule');
    assert.equal(capsule.gene, gene.id);
    assert.equal(capsule.content.slice(0, 15), 'Here is a concr');
    assert.equal(capsule.outcome.status, 'success');
    assert.equal(capsule.atp.order_id, 'proof_abc123');
    assert.equal(capsule.atp.task_id, 'task_xyz789');
    assert.ok(capsule.asset_id.startsWith('sha256:'));
  });

  it('redacts secrets and local paths from capsule content and summary', () => {
    const gene = _buildGene(['general'], []);
    const capsule = _buildCapsule({
      gene: gene,
      answer: 'token=abcdefghijklmnop1234567890 and /home/alice/private',
      summary: 'A2A_NODE_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      orderId: 'proof_secret',
    });
    assert.ok(capsule.content.includes('[REDACTED]'));
    assert.ok(!capsule.content.includes('/home/alice/private'));
    assert.ok(capsule.summary.includes('[REDACTED]'));
  });

  it('defaults capsule summary when caller does not provide one', () => {
    const gene = _buildGene(['general'], []);
    const capsule = _buildCapsule({
      gene: gene,
      answer: 'short answer',
      orderId: 'proof_default',
    });
    assert.ok(capsule.summary.length > 0);
  });

  it('different answers yield different capsule asset_ids', () => {
    const gene = _buildGene(['general'], []);
    const c1 = _buildCapsule({ gene: gene, answer: 'answer one', orderId: 'p1' });
    const c2 = _buildCapsule({ gene: gene, answer: 'answer two', orderId: 'p1' });
    assert.notEqual(c1.asset_id, c2.asset_id);
  });
});

describe('atpExecute CLI-shape invariants', () => {
  // Smoke test for the input-validation branch -- does not require a live Hub.
  it('rejects missing required params', async () => {
    const { completeAtpTask } = require('../src/atp/atpExecute');
    const r1 = await completeAtpTask({});
    assert.equal(r1.ok, false);
    assert.equal(r1.stage, 'input');
    const r2 = await completeAtpTask({ taskId: 't', orderId: 'o' });
    assert.equal(r2.ok, false);
    assert.equal(r2.stage, 'input');
  });

  it('reports read_answer stage when answer file is missing', async () => {
    const { completeAtpTask } = require('../src/atp/atpExecute');
    const missing = path.join(os.tmpdir(), 'atp-missing-' + Date.now() + '.md');
    const r = await completeAtpTask({
      taskId: 't1', orderId: 'o1', answerFile: missing,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'read_answer');
  });

  it('reports read_answer stage when answer file is empty', async () => {
    const { completeAtpTask } = require('../src/atp/atpExecute');
    const emptyFile = fs.mkdtempSync(path.join(os.tmpdir(), 'atp-exec-')) + '/empty.md';
    fs.writeFileSync(emptyFile, '');
    const r = await completeAtpTask({
      taskId: 't1', orderId: 'o1', answerFile: emptyFile,
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'read_answer');
  });
});
