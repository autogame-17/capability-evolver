'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeServicePayload,
  sanitizeServiceUpdates,
} = require('../src/atp/serviceHelper');

describe('serviceHelper sanitization', () => {
  it('sanitizes and clamps publish payload fields', () => {
    const payload = sanitizeServicePayload({
      title: 'Code Review /home/alice/private',
      description: 'token=abcdefghijklmnop1234567890',
      capabilities: ['debugging', 'A2A_NODE_SECRET=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'],
      useCases: ['investigate 192.168.1.25:8080'],
      pricePerTask: 0,
      executionMode: 'weird-mode',
      maxConcurrent: 999,
      recipeId: 'recipe-secret-token=abcdefghijklmnop1234567890',
    });

    assert.ok(payload.title.includes('[REDACTED]'));
    assert.ok(payload.description.includes('[REDACTED]'));
    assert.ok(payload.capabilities[1].includes('[REDACTED]'));
    assert.ok(payload.use_cases[0].includes('[REDACTED]'));
    assert.equal(payload.price_per_task, 1);
    assert.equal(payload.execution_mode, 'exclusive');
    assert.equal(payload.max_concurrent, 50);
  });

  it('sanitizes update payload fields', () => {
    const updates = sanitizeServiceUpdates({
      title: 'New title /home/bob/private',
      description: 'postgres://user:pass123@db.internal:5432/app',
      executionMode: 'open',
      maxConcurrent: -5,
    });

    assert.ok(updates.title.includes('[REDACTED]'));
    assert.ok(updates.description.includes('[REDACTED]'));
    assert.equal(updates.execution_mode, 'open');
    assert.equal(updates.max_concurrent, 1);
  });
});
