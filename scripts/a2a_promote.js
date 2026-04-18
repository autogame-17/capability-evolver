var assetStore = require('../src/gep/assetStore');
var solidifyMod = require('../src/gep/solidify');
var contentHash = require('../src/gep/contentHash');
var a2aProto = require('../src/gep/a2aProtocol');

function parseArgs(argv) {
  var out = { flags: new Set(), kv: new Map(), positionals: [] };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (!a) continue;
    if (a.startsWith('--')) {
      var eq = a.indexOf('=');
      if (eq > -1) { out.kv.set(a.slice(2, eq), a.slice(eq + 1)); }
      else {
        var key = a.slice(2);
        var next = argv[i + 1];
        if (next && !String(next).startsWith('--')) { out.kv.set(key, next); i++; }
        else { out.flags.add(key); }
      }
    } else { out.positionals.push(a); }
  }
  return out;
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  var id = String(args.kv.get('id') || '').trim();
  var typeRaw = String(args.kv.get('type') || '').trim().toLowerCase();
  var validated = args.flags.has('validated') || String(args.kv.get('validated') || '') === 'true';
  var limit = Number.isFinite(Number(args.kv.get('limit'))) ? Number(args.kv.get('limit')) : 500;
  var asJson = args.flags.has('json');

  if (!id || !typeRaw) {
    var errMsg = 'Usage: node scripts/a2a_promote.js --type capsule|gene|event --id <id> --validated [--json]';
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: errMsg }) + '\n');
    } else {
      throw new Error(errMsg);
    }
    process.exit(1);
  }
  if (!validated) {
    var errMsg2 = 'Refusing to promote without --validated (local verification must be done first).';
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: errMsg2 }) + '\n');
    } else {
      throw new Error(errMsg2);
    }
    process.exit(1);
  }

  var type = typeRaw === 'capsule' ? 'Capsule' : typeRaw === 'gene' ? 'Gene' : typeRaw === 'event' ? 'EvolutionEvent' : '';
  if (!type) {
    var errMsg3 = 'Invalid --type. Use capsule, gene, or event.';
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: errMsg3 }) + '\n');
    } else {
      throw new Error(errMsg3);
    }
    process.exit(1);
  }

  var external = assetStore.readRecentExternalCandidates(limit);
  var candidate = null;
  for (var i = 0; i < external.length; i++) {
    if (external[i] && external[i].type === type && String(external[i].id) === id) { candidate = external[i]; break; }
  }
  if (!candidate) {
    var errMsg4 = 'Candidate not found in external zone: type=' + type + ' id=' + id;
    if (asJson) {
      process.stdout.write(JSON.stringify({ error: errMsg4 }) + '\n');
    } else {
      throw new Error(errMsg4);
    }
    process.exit(1);
  }

  if (type === 'Gene') {
    var validation = Array.isArray(candidate.validation) ? candidate.validation : [];
    for (var j = 0; j < validation.length; j++) {
      var c = String(validation[j] || '').trim();
      if (!c) continue;
      if (!solidifyMod.isValidationCommandAllowed(c)) {
        var errMsg5 = 'Refusing to promote Gene ' + id + ': validation command rejected by safety check: "' + c + '". Only node/npm/npx commands without shell operators are allowed.';
        if (asJson) {
          process.stdout.write(JSON.stringify({ error: errMsg5 }) + '\n');
        } else {
          throw new Error(errMsg5);
        }
        process.exit(1);
      }
    }
  }

  var promoted = JSON.parse(JSON.stringify(candidate));
  if (!promoted.a2a || typeof promoted.a2a !== 'object') promoted.a2a = {};
  promoted.a2a.status = 'promoted';
  promoted.a2a.promoted_at = new Date().toISOString();
  if (!promoted.schema_version) promoted.schema_version = contentHash.SCHEMA_VERSION;
  promoted.asset_id = contentHash.computeAssetId(promoted);

  var emitDecisions = process.env.A2A_EMIT_DECISIONS === 'true';

  if (type === 'EvolutionEvent') {
    assetStore.appendEventJsonl(promoted);
    if (emitDecisions) {
      try {
        var dmEv = a2aProto.buildDecision({ assetId: promoted.asset_id, localId: id, decision: 'accept', reason: 'event promoted for provenance tracking' });
        a2aProto.getTransport().send(dmEv);
      } catch (e) { console.error('[a2a_promote] ERROR: Failed to send decision for event: ' + (e && e.message ? e.message : String(e))); }
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ promoted: 'event', id: id, asset_id: promoted.asset_id }) + '\n');
    } else {
      process.stdout.write('promoted_event=' + id + '\n');
    }
    return;
  }

  if (type === 'Capsule') {
    assetStore.appendCapsule(promoted);
    if (emitDecisions) {
      try {
        var dm = a2aProto.buildDecision({ assetId: promoted.asset_id, localId: id, decision: 'accept', reason: 'capsule promoted after validation' });
        a2aProto.getTransport().send(dm);
      } catch (e) { console.error('[a2a_promote] ERROR: Failed to send decision for capsule: ' + (e && e.message ? e.message : String(e))); }
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ promoted: 'capsule', id: id, asset_id: promoted.asset_id }) + '\n');
    } else {
      process.stdout.write('promoted_capsule=' + id + '\n');
    }
    return;
  }

  var localGenes = assetStore.loadGenes();
  var exists = false;
  for (var k = 0; k < localGenes.length; k++) {
    if (localGenes[k] && localGenes[k].type === 'Gene' && String(localGenes[k].id) === id) { exists = true; break; }
  }
  if (exists) {
    if (emitDecisions) {
      try {
        var dm2 = a2aProto.buildDecision({ assetId: promoted.asset_id, localId: id, decision: 'reject', reason: 'local gene with same ID already exists' });
        a2aProto.getTransport().send(dm2);
      } catch (e) { console.error('[a2a_promote] ERROR: Failed to send conflict decision for gene: ' + (e && e.message ? e.message : String(e))); }
    }
    if (asJson) {
      process.stdout.write(JSON.stringify({ conflict: 'gene', id: id, resolution: 'keep_local' }) + '\n');
    } else {
      process.stdout.write('conflict_keep_local_gene=' + id + '\n');
    }
    return;
  }

  assetStore.upsertGene(promoted);
  if (emitDecisions) {
    try {
      var dm3 = a2aProto.buildDecision({ assetId: promoted.asset_id, localId: id, decision: 'accept', reason: 'gene promoted after safety audit' });
      a2aProto.getTransport().send(dm3);
    } catch (e) { console.error('[a2a_promote] ERROR: Failed to send acceptance decision for gene: ' + (e && e.message ? e.message : String(e))); }
  }
  if (asJson) {
    process.stdout.write(JSON.stringify({ promoted: 'gene', id: id, asset_id: promoted.asset_id }) + '\n');
  } else {
    process.stdout.write('promoted_gene=' + id + '\n');
  }
}

try { main(); } catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
