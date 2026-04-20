'use strict';
// Domain-specific error hierarchy for Evolver.
// Enables typed catch blocks and structured error context.
// Zero external dependencies.

class EvolverError extends Error {
  constructor(message, code, context) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || 'EVOLVER_ERROR';
    this.context = context && typeof context === 'object' ? context : {};
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return { name: this.name, message: this.message, code: this.code, context: this.context };
  }
}

// Gene validation commands returned non-zero or timed out
class ValidationError extends EvolverError {
  constructor(message, context) { super(message, 'VALIDATION_FAILED', context); }
}

// Commit / publish step failed
class SolidifyError extends EvolverError {
  constructor(message, context) { super(message, 'SOLIDIFY_FAILED', context); }
}

// No gene matched the current signal set
class GeneSelectionError extends EvolverError {
  constructor(message, context) { super(message, 'GENE_NOT_FOUND', context); }
}

// Gene definition is malformed or violates constraints
class GeneError extends EvolverError {
  constructor(message, context) { super(message, 'GENE_ERROR', context); }
}

// A2A hub is unreachable or returned an error response
class HubError extends EvolverError {
  constructor(message, context) { super(message, 'HUB_ERROR', context); }
}

// Hub request timed out
class HubTimeoutError extends HubError {
  constructor(message, context) { super(message, context); this.code = 'HUB_TIMEOUT'; }
}

// Sandbox process failed to spawn or exceeded limits
class SandboxError extends EvolverError {
  constructor(message, context) { super(message, 'SANDBOX_ERROR', context); }
}

// Asset storage read/write failure
class StorageError extends EvolverError {
  constructor(message, context) { super(message, 'STORAGE_ERROR', context); }
}

// File lock could not be acquired within timeout
class LockTimeoutError extends StorageError {
  constructor(message, context) { super(message, context); this.code = 'LOCK_TIMEOUT'; }
}

// LLM signal extraction call failed
class SignalError extends EvolverError {
  constructor(message, context) { super(message, 'SIGNAL_ERROR', context); }
}

// Policy check rejected the mutation (blast radius, forbidden paths, etc.)
class PolicyError extends EvolverError {
  constructor(message, context) { super(message, 'POLICY_VIOLATION', context); }
}

const ERROR_CODES = {
  EVOLVER_ERROR:    'Generic evolver error',
  VALIDATION_FAILED:'Gene validation commands returned non-zero exit code',
  SOLIDIFY_FAILED:  'Failed to commit/publish evolution result',
  GENE_NOT_FOUND:   'No gene matched current signals',
  GENE_ERROR:       'Gene definition is malformed or violates constraints',
  HUB_ERROR:        'A2A hub is unreachable or returned error',
  HUB_TIMEOUT:      'Hub request timed out',
  SANDBOX_ERROR:    'Sandbox process failed to spawn or exceeded limits',
  STORAGE_ERROR:    'Asset storage read/write failure',
  LOCK_TIMEOUT:     'File lock acquisition timed out',
  SIGNAL_ERROR:     'Signal extraction failed',
  POLICY_VIOLATION: 'Mutation rejected by policy check',
};

module.exports = {
  EvolverError,
  ValidationError,
  SolidifyError,
  GeneSelectionError,
  GeneError,
  HubError,
  HubTimeoutError,
  SandboxError,
  StorageError,
  LockTimeoutError,
  SignalError,
  PolicyError,
  ERROR_CODES,
};
