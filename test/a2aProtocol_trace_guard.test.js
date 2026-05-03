const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.A2A_NODE_SECRET) {
  process.env.A2A_NODE_SECRET = 'a'.repeat(64);
}

const {
  buildPublish,
  buildPublishBundle,
  unwrapAssetFromMessage,
} = require('../src/gep/a2aProtocol');

// Minimal valid Gene/Capsule for buildPublishBundle. Shape mirrors what the
// hub expects (type + id); everything else is optional from the SDK's view.
function makeGene() {
  return {
    type: 'Gene',
    id: 'gene_test_trace_guard',
    summary: 'trace guard fixture',
  };
}

function makeCapsule(overrides) {
  const base = {
    type: 'Capsule',
    id: 'capsule_trace_guard_' + Date.now(),
    gene: 'gene_test_trace_guard',
    trigger: ['unit_test'],
    summary: 'trace guard fixture capsule',
    confidence: 0.9,
    blast_radius: { files: 1, lines: 10 },
    outcome: { status: 'success', score: 0.9 },
  };
  return Object.assign(base, overrides || {});
}

function extractCapsule(msg) {
  // buildPublishBundle wraps assets as [gene, capsule, (event)]
  const assets = msg.payload && msg.payload.assets;
  assert.ok(Array.isArray(assets), 'bundle must have assets array');
  return assets.find((a) => a && a.type === 'Capsule');
}

describe('buildPublishBundle: execution_trace guard', () => {
  var _origSecret;
  before(() => {
    _origSecret = process.env.A2A_NODE_SECRET;
    process.env.A2A_NODE_SECRET = 'test-secret-for-signing';
  });
  after(() => {
    if (_origSecret === undefined) delete process.env.A2A_NODE_SECRET;
    else process.env.A2A_NODE_SECRET = _origSecret;
  });

  it('synthesizes trace when capsule has no execution_trace field', () => {
    const capsule = makeCapsule({});
    assert.equal('execution_trace' in capsule, false);
    const msg = buildPublishBundle({ gene: makeGene(), capsule });
    const c = extractCapsule(msg);
    assert.ok(Array.isArray(c.execution_trace), 'execution_trace must be array');
    assert.ok(c.execution_trace.length >= 1, 'must have at least one step');
    const step = c.execution_trace[0];
    assert.equal(typeof step.step, 'number');
    assert.ok(['build', 'validate', 'canary'].includes(step.stage), 'stage must be build|validate|canary');
    assert.equal(typeof step.cmd, 'string');
    assert.equal(typeof step.exit, 'number');
  });

  it('does NOT overwrite a capsule that already has a valid execution_trace array', () => {
    const existing = [
      { step: 1, stage: 'build', cmd: 'npm install', exit: 0 },
      { step: 2, stage: 'validate', cmd: 'npm test', exit: 0 },
    ];
    const capsule = makeCapsule({ execution_trace: existing });
    const msg = buildPublishBundle({ gene: makeGene(), capsule });
    const c = extractCapsule(msg);
    assert.deepEqual(c.execution_trace, existing);
  });

  it('replaces non-array / empty execution_trace shapes ({} | null | [] | "str")', () => {
    for (const badValue of [{}, null, [], '']) {
      const capsule = makeCapsule({ execution_trace: badValue });
      const msg = buildPublishBundle({ gene: makeGene(), capsule });
      const c = extractCapsule(msg);
      assert.ok(Array.isArray(c.execution_trace),
        'expected array replacement for ' + JSON.stringify(badValue));
      assert.ok(c.execution_trace.length >= 1,
        'expected non-empty replacement for ' + JSON.stringify(badValue));
    }
  });

  it('uses caller-supplied validation results when present', () => {
    const capsule = makeCapsule({});
    const msg = buildPublishBundle({
      gene: makeGene(),
      capsule,
      validation: {
        results: [
          { cmd: 'node --test test/foo.test.js', ok: true },
          { cmd: 'npm run lint', ok: false },
        ],
      },
    });
    const c = extractCapsule(msg);
    assert.ok(c.execution_trace.length >= 2, 'should emit one step per validation cmd');
    const cmds = c.execution_trace.map((s) => s.cmd);
    assert.ok(cmds.some((x) => x.includes('node --test')), 'missing node --test step');
    assert.ok(cmds.some((x) => x.includes('npm run lint')), 'missing npm run lint step');
    const failingStep = c.execution_trace.find((s) => s.cmd.includes('npm run lint'));
    assert.equal(failingStep.exit, 1, 'failing validation must map to exit=1');
  });

  it('fallback step uses outcome.status to set exit code', () => {
    const okCapsule = makeCapsule({ outcome: { status: 'success', score: 1 } });
    delete okCapsule.blast_radius;
    const ok = extractCapsule(buildPublishBundle({ gene: makeGene(), capsule: okCapsule }));
    assert.equal(ok.execution_trace.length, 1);
    assert.equal(ok.execution_trace[0].exit, 0);

    const failCapsule = makeCapsule({ outcome: { status: 'failed', score: 0 } });
    delete failCapsule.blast_radius;
    const fail = extractCapsule(buildPublishBundle({ gene: makeGene(), capsule: failCapsule }));
    assert.equal(fail.execution_trace.length, 1);
    assert.equal(fail.execution_trace[0].exit, 1);
  });
});

describe('buildPublish: execution_trace guard (single-asset publish)', () => {
  var _origSecret;
  before(() => {
    _origSecret = process.env.A2A_NODE_SECRET;
    process.env.A2A_NODE_SECRET = 'test-secret-for-signing';
  });
  after(() => {
    if (_origSecret === undefined) delete process.env.A2A_NODE_SECRET;
    else process.env.A2A_NODE_SECRET = _origSecret;
  });

  it('synthesizes trace for trace-less Capsule on single-asset publish', () => {
    const capsule = makeCapsule({});
    const msg = buildPublish({ asset: capsule });
    const sent = unwrapAssetFromMessage(msg) || msg.payload.asset || capsule;
    assert.ok(Array.isArray(sent.execution_trace), 'execution_trace must be array');
    assert.ok(sent.execution_trace.length >= 1);
  });

  it('does not touch non-Capsule assets', () => {
    const msg = buildPublish({ asset: { type: 'Gene', id: 'gene_x' } });
    const sent = unwrapAssetFromMessage(msg) || msg.payload.asset;
    assert.equal(sent.execution_trace, undefined);
  });
});
