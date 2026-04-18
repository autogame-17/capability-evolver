const { loadGenes, loadCapsules, readAllEvents } = require('../src/gep/assetStore');
const { exportEligibleCapsules, exportEligibleGenes, isAllowedA2AAsset } = require('../src/gep/a2a');
const { buildPublish, buildHello, getTransport } = require('../src/gep/a2aProtocol');
const { computeAssetId, SCHEMA_VERSION } = require('../src/gep/contentHash');

function main() {
  var args = process.argv.slice(2);
  var asJson = args.includes('--json');
  var asProtocol = args.includes('--protocol');
  var withHello = args.includes('--hello');
  var persist = args.includes('--persist');
  var includeEvents = args.includes('--include-events');
  var dryRun = args.includes('--dry-run');

  var capsules = loadCapsules();
  var genes = loadGenes();
  var events = readAllEvents();

  // Build eligible list: Capsules (filtered) + Genes (filtered) + Events (opt-in)
  var eligibleCapsules = exportEligibleCapsules({ capsules: capsules, events: events });
  var eligibleGenes = exportEligibleGenes({ genes: genes });
  var eligible = eligibleCapsules.concat(eligibleGenes);

  if (includeEvents) {
    var eligibleEvents = (Array.isArray(events) ? events : []).filter(function (e) {
      return isAllowedA2AAsset(e) && e.type === 'EvolutionEvent';
    });
    for (var ei = 0; ei < eligibleEvents.length; ei++) {
      var ev = eligibleEvents[ei];
      if (!ev.schema_version) ev.schema_version = SCHEMA_VERSION;
      if (!ev.asset_id) { try { ev.asset_id = computeAssetId(ev); } catch (e) { console.error('[a2a_export] ERROR: Failed to compute asset_id for event: ' + (e && e.message ? e.message : String(e))); } }
    }
    eligible = eligible.concat(eligibleEvents);
  }

  if (withHello || asProtocol) {
    var hello = buildHello({ geneCount: genes.length, capsuleCount: capsules.length });
    process.stdout.write(JSON.stringify(hello) + '\n');
    if (persist && !dryRun) {
      try { getTransport().send(hello); }
      catch (e) { console.error('[a2a_export] ERROR: Failed to send hello via transport: ' + (e && e.message ? e.message : String(e))); }
    } else if (dryRun) {
      process.stdout.write('[dry-run] Would send hello message\n');
    }
  }

  if (asProtocol) {
    for (var i = 0; i < eligible.length; i++) {
      var msg = buildPublish({ asset: eligible[i] });
      process.stdout.write(JSON.stringify(msg) + '\n');
      if (persist && !dryRun) {
        try { getTransport().send(msg); }
        catch (e) { console.error('[a2a_export] ERROR: Failed to send publish message for asset ' + (eligible[i] && eligible[i].asset_id ? eligible[i].asset_id : '?') + ': ' + (e && e.message ? e.message : String(e))); }
      } else if (dryRun) {
        process.stdout.write('[dry-run] Would send publish message for asset ' + (eligible[i] && eligible[i].asset_id ? eligible[i].asset_id : '?') + '\n');
      }
    }
    return;
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(eligible, null, 2) + '\n');
    return;
  }

  for (var j = 0; j < eligible.length; j++) {
    process.stdout.write(JSON.stringify(eligible[j]) + '\n');
  }
}

try { main(); } catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + '\n');
  process.exit(1);
}
