var fs = require('fs');
var assetStore = require('../src/gep/assetStore');
var a2a = require('../src/gep/a2a');
var memGraph = require('../src/gep/memoryGraphAdapter');
var contentHash = require('../src/gep/contentHash');
var a2aProto = require('../src/gep/a2aProtocol');

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}

function parseSignalsFromEnv() {
  var raw = process.env.A2A_SIGNALS || '';
  if (!raw) return [];
  try {
    var maybe = JSON.parse(raw);
    if (Array.isArray(maybe)) return maybe.map(String).filter(Boolean);
  } catch (e) {}
  return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function main() {
  var args = process.argv.slice(2);
  var inputPath = '';
  for (var i = 0; i < args.length; i++) {
    if (args[i] && !args[i].startsWith('--')) { inputPath = args[i]; break; }
  }
  var source = process.env.A2A_SOURCE || 'external';
  var factor = Number.isFinite(Number(process.env.A2A_EXTERNAL_CONFIDENCE_FACTOR))
    ? Number(process.env.A2A_EXTERNAL_CONFIDENCE_FACTOR) : 0.6;

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
            console.error('Error sending decision:', e);
          }
        }
        continue;
      }
    }

    var staged = a2a.lowerConfidence(obj, { source: source, factor: factor });
    if (!staged) continue;

    try {
      assetStore.appendExternalCandidateJsonl(staged);
    } catch (e) {
      console.error('Error appending external candidate:', e);
      rejected += 1;
      continue;
    }

    try {
      memGraph.recordExternalCandidate({ asset: staged, source: source, signals: signals });
    } catch (e) {
      console.error('Error recording external candidate:', e);
      rejected += 1;
      continue;
    }

    if (emitDecisions) {
      try {
        var dm2 = a2aProto.buildDecision({ assetId: staged.asset_id, localId: staged.id, decision: 'quarantine', reason: 'staged as external candidate' });
        a2aProto.getTransport().send(dm2);
      } catch (e) {
        console.error('Error sending decision:', e);
        rejected += 1;
        continue;
      }
    }

    accepted += 1;
  }

  console.log(`accepted=${accepted} rejected=${rejected}`);
}

try { main(); } catch (e) {
  console.error('Error running main:', e);
  process.exit(1);
}