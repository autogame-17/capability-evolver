const path = require('path');
const evolve = require('./evolve');
const { execSync } = require('child_process');
const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const isLoop = args.includes('--loop') || args.includes('--mad-dog');

  if (command === 'run' || command === '/evolve' || isLoop) {
    console.log('🚀 Starting Capability Evolver...');
    
    if (isLoop) {
        console.log('🐕 **MAD DOG MODE (Relay) ACTIVATED** 🐕');
        // [RELAY MODE RESTORED 2026-02-03]
        // Run once, then let evolve.js trigger the next agent via sessions_spawn.
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);

            // [HOOK] Execute Failure Hook (if set by wrapper)
            if (process.env.ON_EVOLUTION_FAIL) {
                try {
                    console.log('🪝 Executing Failure Hook...');
                    require('child_process').execSync(process.env.ON_EVOLUTION_FAIL, { stdio: 'inherit' });
                } catch (hookError) {
                    console.error('Failure Hook crashed:', hookError.message);
                }
            }
            
            // [HARDENING] Fail-Safe Recovery
            // If evolution crashes, we must output a recovery command so the agent spawns the next loop.
            // We add a delay to prevent rapid crash loops.
            
            // Fix: Use correct self-path (wrapper) if available
            const workspaceRoot = path.resolve(__dirname, '../../');
            const selfPath = process.env.EVOLVER_SELF_PATH 
                ? path.relative(workspaceRoot, process.env.EVOLVER_SELF_PATH)
                : 'skills/private-evolver/index.js';

            console.log(`
            // [RECOVERY MODE] Evolution Logic Crashed.
            // Spawning next loop with delay to prevent rapid crash loops.
            sessions_spawn({
                task: "exec: sleep 10 && node ${selfPath} --loop",
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

  } else {
    console.log(`Usage: node index.js [run|/evolve] [--loop]`);
  }
}

if (require.main === module) {
  main();
}
