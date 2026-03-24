// Evolution Strategy Presets (v1.1)
// Controls the balance between repair, optimize, and innovate intents.
//
// Usage: set EVOLVE_STRATEGY env var to one of: balanced, innovate, harden, repair-only,
//        early-stabilize, steady-state, or "auto" for adaptive selection.
// Default: balanced (or auto-detected based on cycle count / saturation signals)
//
// Each strategy defines:
//   repair/optimize/innovate  - target allocation ratios (inform the LLM prompt)
//   repairLoopThreshold       - repair ratio in last 8 cycles that triggers forced innovation
//   label                     - human-readable name injected into the GEP prompt

var fs = require('fs');
var path = require('path');

var STRATEGIES = {
  'balanced': {
    repair: 0.20,
    optimize: 0.30,
    innovate: 0.50,
    repairLoopThreshold: 0.50,
    label: 'Balanced',
    description: 'Normal operation. Steady growth with stability.',
  },
  'innovate': {
    repair: 0.05,
    optimize: 0.15,
    innovate: 0.80,
    repairLoopThreshold: 0.30,
    label: 'Innovation Focus',
    description: 'System is stable. Maximize new features and capabilities.',
  },
  'harden': {
    repair: 0.40,
    optimize: 0.40,
    innovate: 0.20,
    repairLoopThreshold: 0.70,
    label: 'Hardening',
    description: 'After a big change. Focus on stability and robustness.',
  },
  'repair-only': {
    repair: 0.80,
    optimize: 0.20,
    innovate: 0.00,
    repairLoopThreshold: 1.00,
    label: 'Repair Only',
    description: 'Emergency. Fix everything before doing anything else.',
  },
  'early-stabilize': {
    repair: 0.60,
    optimize: 0.25,
    innovate: 0.15,
    repairLoopThreshold: 0.80,
    label: 'Early Stabilization',
    description: 'First cycles. Prioritize fixing existing issues before innovating.',
  },
  'steady-state': {
    repair: 0.60,
    optimize: 0.30,
    innovate: 0.10,
    repairLoopThreshold: 0.90,
    label: 'Steady State',
    description: 'Evolution saturated. Maintain existing capabilities. Minimal innovation.',
  },
};

// Read evolution_state.json to get the current cycle count for auto-detection.
function _readCycleCount() {
  try {
    // evolver/memory/evolution_state.json (local to the skill)
    var localPath = path.resolve(__dirname, '..', '..', 'memory', 'evolution_state.json');
    // workspace/memory/evolution/evolution_state.json (canonical path used by evolve.js)
    var workspacePath = path.resolve(__dirname, '..', '..', '..', '..', 'memory', 'evolution', 'evolution_state.json');
    var candidates = [localPath, workspacePath];
    for (var i = 0; i < candidates.length; i++) {
      if (fs.existsSync(candidates[i])) {
        var data = JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
        return data && Number.isFinite(data.cycleCount) ? data.cycleCount : 0;
      }
    }
  } catch (e) {}
  return 0;
}

function resolveStrategy(opts) {
  var signals = (opts && Array.isArray(opts.signals)) ? opts.signals : [];
  var name = String(process.env.EVOLVE_STRATEGY || 'balanced').toLowerCase().trim();

  // Backward compatibility: FORCE_INNOVATION=true maps to 'innovate'
  var forceInnovation = false;
  if (!process.env.EVOLVE_STRATEGY) {
    var fi = String(process.env.FORCE_INNOVATION || process.env.EVOLVE_FORCE_INNOVATION || '').toLowerCase();
    if (fi === 'true') {
      name = 'innovate';
      forceInnovation = true;  // Mark that user explicitly requested innovation
    }
  }

  // Auto-detection: when no explicit strategy is set (defaults to 'balanced'),
  // apply heuristics inspired by Echo-MingXuan's "fix first, innovate later" pattern.
  // NOTE: Don't override if user explicitly set FORCE_INNOVATION=true
  var isDefault = !process.env.EVOLVE_STRATEGY || name === 'balanced' || name === 'auto';

  if (isDefault && !forceInnovation) {
    // Early-stabilize: first 5 cycles should focus on fixing existing issues.
    var cycleCount = _readCycleCount();
    if (cycleCount > 0 && cycleCount <= 5) {
      name = 'early-stabilize';
    }

    // Saturation detection: if saturation signals are present, switch to steady-state.
    if (signals.indexOf('force_steady_state') !== -1) {
      name = 'steady-state';
    } else if (signals.indexOf('evolution_saturation') !== -1) {
      name = 'steady-state';
    }
  }

  // Explicit "auto" maps to whatever was auto-detected above (or balanced if no heuristic fired).
  if (name === 'auto') name = 'balanced';

  var strategy = STRATEGIES[name] || STRATEGIES['balanced'];
  strategy.name = name;
  return strategy;
}

function getStrategyNames() {
  return Object.keys(STRATEGIES);
}

module.exports = { resolveStrategy, getStrategyNames, STRATEGIES };
