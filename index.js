const evolve = require('./src/evolve');
const { solidify } = require('./src/gep/solidify');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const isLoop = args.includes('--loop') || args.includes('--mad-dog');

  if (command === 'run' || command === '/evolve' || isLoop) {
    console.log('Starting capability evolver...');
    
    if (isLoop) {
        // Signal evolve.js to enable loop gating/chain behavior.
        process.env.EVOLVE_LOOP = 'true';
        console.log('Loop mode enabled (relay).');
        // [RELAY MODE RESTORED 2026-02-03]
        // Run once, then let evolve.js trigger the next agent via sessions_spawn.
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);
            
            // [HARDENING] Fail-Safe Recovery
            // If evolution crashes, we must output a recovery command so the agent spawns the next loop.
            // We add a delay to prevent rapid crash loops.
            console.log(`
            // [RECOVERY MODE] Evolution Logic Crashed.
            // Spawning next loop with delay to prevent rapid crash loops.
            sessions_spawn({
                task: "exec: sleep 10 && node skills/private-evolver/index.js --loop",
                agentId: "main",
                cleanup: "delete",
                label: "mad_dog_recovery"
            })
            `);
            
            process.exit(1);
        }
    } else {
        // Normal Single Run
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);
            process.exit(1);
        }
    }

    // Post-run hint
    console.log('\n' + '=======================================================');
    console.log('Capability evolver finished. If you use this project, consider starring the upstream repository.');
    console.log('Upstream: https://github.com/autogame-17/capability-evolver');
    console.log('=======================================================\n');
    
  } else if (command === 'solidify') {
    const dryRun = args.includes('--dry-run');
    const noRollback = args.includes('--no-rollback');
    const intentFlag = args.find(a => typeof a === 'string' && a.startsWith('--intent='));
    const summaryFlag = args.find(a => typeof a === 'string' && a.startsWith('--summary='));
    const intent = intentFlag ? intentFlag.slice('--intent='.length) : null;
    const summary = summaryFlag ? summaryFlag.slice('--summary='.length) : null;

    try {
      const res = solidify({
        intent: intent || undefined,
        summary: summary || undefined,
        dryRun,
        rollbackOnFailure: !noRollback,
      });
      const st = res && res.ok ? 'SUCCESS' : 'FAILED';
      console.log(`[SOLIDIFY] ${st}`);
      if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
      if (res && res.event) console.log(JSON.stringify(res.event, null, 2));
      if (res && res.capsule) console.log(JSON.stringify(res.capsule, null, 2));
      process.exit(res && res.ok ? 0 : 2);
    } catch (error) {
      console.error('[SOLIDIFY] Error:', error);
      process.exit(2);
    }
  } else {
    console.log(`Usage: node index.js [run|/evolve|solidify] [--loop]
  - solidify flags:
    - --dry-run
    - --no-rollback
    - --intent=repair|optimize|innovate
    - --summary=...`);
  }
}

if (require.main === module) {
  main();
}
