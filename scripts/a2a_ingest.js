var fs = require('fs');
var path = require('path');
var assetStore = require('../src/gep/assetStore');
var a2a = require('../src/gep/a2a');
var memGraph = require('../src/gep/memoryGraphAdapter');
var contentHash = require('../src/gep/contentHash');
var a2aProto = require('../src/gep/a2aProtocol');
var paths = require('../src/gep/paths');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function isPathSafe(inputPath) {
  // Resolve the path to its absolute form
  var resolved;
  try {
    resolved = path.resolve(inputPath);
  } catch (e) {
    return false;
  }
  // Get the repo root and ensure the resolved path is within it
  var repoRoot;
  try {
    repoRoot = paths.getRepoRoot();
  } catch (e) {
    return false;
  }
  // Resolve repo root as well for accurate comparison
  var resolvedRoot = path.resolve(repoRoot);
  // Check for path traversal sequences
  if (inputPath.includes('..')) return false;
  // Ensure the resolved path starts with the repo root
  if (!resolved.startsWith(resolvedRoot)) return false;
  return true;
}

function parseSignalsFromEnv() {
  var raw = process.env.A2A_SIGNALS || '';
  if (!raw) return [];
  var signals = [];
  try {
    var maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) signals = maybe.map(String).filter(Boolean);
  } catch (e) {
    signals = String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  // Validate each signal against safe pattern: alphanumeric, underscores, hyphens only
  var safePattern = /^[a-zA-Z0-9_-]+$/;
  for (var i = 0; i < signals.length; i++) {
    var sig = signals[i];
    if (!sig || !safePattern.test(sig)) {
      console.error('[a2a_ingest] ERROR: Invalid signal "' + sig + '" - must match /^[a-zA-Z0-9_-]+$/');
      process.exit(1);
    }
  }
  return signals;
}

function main() {
  var args = process.argv.slice(2);
  var inputPath = '';
  var dryRun = args.includes('--dry-run');
  var asJson = args.includes('--json');
  for (var i = 0; i < args.length; i++) {
    if (args[i] && !args[i].startsWith('--')) { inputPath = args[i]; break; }
  }
  var source = process.env.A2A_SOURCE || 'external';
  var factor = Number.isFinite(Number(process.env.A2A_EXTERNAL_CONFIDENCE_FACTOR))
    ? Number(process.env.A2A_EXTERNAL_CONFIDENCE_FACTOR) : 0.6;

  // Security: Validate inputPath is within repo root
  if (inputPath && !isPathSafe(inputPath)) {
    var errMsg = '[a2a_ingest] ERROR: Invalid inputPath "' + inputPath + '" - must be within the evolver directory and contain no path traversal sequences.';
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: errMsg, accepted: 0, rejected: 0 }) + '\n');
    } else {
      process.stderr.write(errMsg + '\n');
    }
    process.exit(1);
  }

  var text = inputPath ? a2a.readTextIfExists(inputPath) : readStdin();
  var parsed = a2a.parseA2AInput(text);
  var signals = parseSignalsFromEnv();

  var accepted = 0;
  var rejected = 0;
  var emitDecisions = process.env.A2A_EMIT_DECISIONS === 'true';

  for (var j = 0; j < parsed.length; j++) {
    var obj = parsed[j];
    if (!a2a.isAllowedA2AAsset(obj)) continue;

    if (obj.asset_id && typeof obj.asset_id === 'string') {
      if (!contentHash.verifyAssetId(obj)) {
        rejected += 1;
        if (emitDecisions) {
          try {
            var dm = a2aProto.buildDecision({ assetId: obj.asset_id, localId: obj.id, decision: 'reject', reason: 'asset_id integrity check failed' });
            a2aProto.getTransport().send(dm);
          } catch (e) {
            console.error('[a2a_ingest] ERROR: Failed to send decision via transport: ' + (e && e.message ? e.message : String(e)));
          }
        }
        continue;
      }
    }

    var staged = a2a.lowerConfidence(obj, { source: source, factor: factor });
    if (!staged) continue;

    if (dryRun) {
      process.stdout.write('[dry-run] Would stage: ' + (staged.id || staged.asset_id || JSON.stringify(staged).slice(0, 100)) + '\n');
    } else {
      assetStore.appendExternalCandidateJsonl(staged);
      try { memGraph.recordExternalCandidate({ asset: staged, source: source, signals: signals }); } catch (e) {
        console.error('[a2a_ingest] ERROR: Failed to record external candidate in memory graph: ' + (e && e.message ? e.message : String(e)));
      }
    }

    if (emitDecisions) {
      try {
        var dm2 = a2aProto.buildDecision({ assetId: staged.asset_id, localId: staged.id, decision: 'quarantine', reason: 'staged as external candidate' });
        a2aProto.getTransport().send(dm2);
      } catch (e) {
        console.error('[a2a_ingest] ERROR: Failed to send decision via transport: ' + (e && e.message ? e.message : String(e)));
      }
    }

    accepted += 1;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ accepted: accepted, rejected: rejected }) + '\n');
  } else {
    process.stdout.write('accepted=' + accepted + ' rejected=' + rejected + '\n');
  }
}

try { main(); } catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
