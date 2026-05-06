// Regression guard for Issue #19 (cross-repo cycle hard timeout).
//
// The daemon main loop in index.js must wrap evolve.run() with a
// Promise.race-based hard timeout so a hung internal call (unclosed
// socket, stuck LLM, etc.) cannot freeze the process for days. See
// the cross-repo timeout plan for context.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const indexPath = path.resolve(__dirname, '..', 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

describe('CycleTimeoutError class', () => {
  const { CycleTimeoutError } = require('..');

  it('exports a real Error subclass with the right code/name', () => {
    const err = new CycleTimeoutError(2700000, 'evolve.run', 5372);
    assert.ok(err instanceof Error, 'should extend Error');
    assert.equal(err.name, 'CycleTimeoutError');
    assert.equal(err.code, 'CYCLE_TIMEOUT');
    assert.equal(err.timeoutMs, 2700000);
    assert.equal(err.phase, 'evolve.run');
    assert.equal(err.cycleNum, 5372);
    assert.match(err.message, /Cycle hard-timeout exceeded after 2700000ms/);
    assert.match(err.message, /cycle=5372/);
    assert.match(err.message, /phase=evolve\.run/);
  });
});

describe('parseBoolEnv helper', () => {
  const { parseBoolEnv } = require('..');

  it('returns fallback for null / undefined / empty / whitespace', () => {
    assert.equal(parseBoolEnv(undefined, true), true);
    assert.equal(parseBoolEnv(null, false), false);
    assert.equal(parseBoolEnv('', true), true);
    assert.equal(parseBoolEnv('   ', false), false);
  });

  it('treats common truthy/falsy strings consistently', () => {
    for (const v of ['true', 'TRUE', '1', 'on', 'yes', ' Yes ']) {
      assert.equal(parseBoolEnv(v, false), true, 'should be truthy: ' + v);
    }
    for (const v of ['false', 'FALSE', '0', 'off', 'no', ' No ']) {
      assert.equal(parseBoolEnv(v, true), false, 'should be falsy: ' + v);
    }
  });

  it('falls back to default for unknown strings (does not throw)', () => {
    assert.equal(parseBoolEnv('maybe', true), true);
    assert.equal(parseBoolEnv('maybe', false), false);
  });
});

describe('index.js daemon loop hard-timeout structure', () => {
  it('wraps evolve.run() with Promise.race against a CycleTimeoutError', () => {
    assert.match(
      source,
      /Promise\.race\(\[evolvePromise,\s*timeoutPromise\]\)/,
      'expected Promise.race([evolvePromise, timeoutPromise]) in main loop'
    );
    assert.match(
      source,
      /new CycleTimeoutError\(\s*cycleTimeoutMs,/,
      'expected CycleTimeoutError to be constructed with cycleTimeoutMs'
    );
  });

  it('honors EVOLVER_CYCLE_TIMEOUT_ENABLED env (default ON)', () => {
    assert.match(
      source,
      /parseBoolEnv\(process\.env\.EVOLVER_CYCLE_TIMEOUT_ENABLED,\s*true\)/,
      'EVOLVER_CYCLE_TIMEOUT_ENABLED must default to true'
    );
  });

  it('honors EVOLVER_CYCLE_TIMEOUT_MS env with 45 min default', () => {
    assert.match(
      source,
      /parseMs\(process\.env\.EVOLVER_CYCLE_TIMEOUT_MS,\s*2700000\)/,
      'EVOLVER_CYCLE_TIMEOUT_MS must default to 2700000 (45 min)'
    );
  });

  it('writes cycle_progress.json on cycle start with phase evolve.run', () => {
    assert.match(
      source,
      /writeCycleProgressAtomic\(cycleProgressPath,\s*\{[\s\S]*?phase:\s*'evolve\.run'/,
      'expected progress write at cycle start'
    );
  });

  it('refreshes progress periodically while evolve.run is in flight', () => {
    assert.match(
      source,
      /progressTicker = setInterval\(/,
      'expected setInterval-based progress ticker'
    );
    assert.match(
      source,
      /progressUpdateMs/,
      'progressUpdateMs constant must exist'
    );
  });

  it('clears the timer + ticker in finally (no leaked handles)', () => {
    assert.match(
      source,
      /finally\s*\{[\s\S]*?clearInterval\(progressTicker\)[\s\S]*?clearTimeout\(cycleTimeoutHandle\)/,
      'finally block must clear both progressTicker and cycleTimeoutHandle'
    );
  });

  it('on CYCLE_TIMEOUT, force-respawns + exits with code 1', () => {
    // v1.79.1: the inline spawn was extracted into spawnReplacementProcess()
    // so the CYCLE_TIMEOUT branch can share the Windows-aware policy used
    // elsewhere. The branch must still call the helper and then exit(1).
    assert.match(
      source,
      /error\.code === 'CYCLE_TIMEOUT'[\s\S]*?spawnReplacementProcess\(\{[\s\S]*?reason: 'cycle_hard_timeout'[\s\S]*?process\.exit\(1\)/,
      'CYCLE_TIMEOUT branch must call spawnReplacementProcess and exit(1)'
    );
  });
});
