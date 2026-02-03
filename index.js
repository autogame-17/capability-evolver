const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// [2026-02-03] PLAN B+ MAD DOG: CRON-DRIVEN ATOMIC STEPS
// This wrapper no longer manages a loop. It runs ONE generation and exits.
// The Loop is managed by Cron.

async function run() {
    console.log('🚀 Launching Feishu Evolver Wrapper (Atomic One-Shot)...');
    
    // Check Args
    const args = process.argv.slice(2);
    const isOnce = args.includes('--once');

    if (!isOnce && args.includes('--loop')) {
        console.warn("⚠️ WARNING: --loop is deprecated. Please update Cron to use --once.");
    }
    
    // 1. Force Feishu Card Reporting
    process.env.EVOLVE_REPORT_TOOL = 'feishu-card';
    
    // 2. Resolve Evolver Path (NOW LOCAL BUNDLED)
    // We merged private-evolver into this folder as 'core_index.js'
    const evolverDir = __dirname;
    const mainScript = path.join(evolverDir, 'core_index.js');
    
    const lifecycleLog = path.resolve(__dirname, '../../logs/wrapper_lifecycle.log');
    
    // Ensure logs dir
    if (!fs.existsSync(path.dirname(lifecycleLog))) {
        fs.mkdirSync(path.dirname(lifecycleLog), { recursive: true });
    }
    
    const startTime = Date.now();
    fs.appendFileSync(lifecycleLog, `[${new Date(startTime).toISOString()}] START Atomic Wrapper PID=${process.pid}\n`);
    
    try {
        // 3. Inject Reporting Directive
        process.env.EVOLVE_REPORT_DIRECTIVE = `3.  **📝 REPORT (FEISHU ATOMIC)**:
    - You **MUST** use the \`feishu-evolver-wrapper/report.js\` tool.
    - **Frequency**: Report EVERY cycle.
    - **Command**:
      \`\`\`bash
      node skills/feishu-evolver-wrapper/report.js --cycle "__CYCLE_ID__" --status "Status: [ATOMIC] Step Complete."
      \`\`\`
    - **Target**: Auto-detects context.`;

        // 4. Inject Atomic Mode Rule
        process.env.EVOLVE_EXTRA_MODES = `- **Mode A (Atomic)**: 🔗 **MANDATORY**: You are running in **Atomic Mode**. 
      - **Action**: Do NOT spawn a new loop. Do NOT call sessions_spawn.
      - **Goal**: Complete ONE generation, update state, and EXIT gracefully.`;

        // Pass clean args (remove wrapper flags if any)
        let childArgsArr = args.filter(a => a !== '--once' && a !== '--loop');
        
        // Fix: Default to 'run' if no command provided (for Cron compatibility)
        if (childArgsArr.length === 0) {
            childArgsArr.push('run');
        }
        
        const childArgs = childArgsArr.join(' ');

        // Execute Evolver
        console.log(`▶️ Executing Core Logic: ${mainScript}`);
        const output = execSync(`node "${mainScript}" ${childArgs}`, { 
            stdio: 'pipe', 
            maxBuffer: 1024 * 1024 * 50, 
            timeout: 900000, // 15 min max per step
            encoding: 'utf8'
        }); 

        // Output Handling
        const lines = output.split('\n');
        if (lines.length > 1500) {
            console.log(lines.slice(0, 500).join('\n'));
            console.log(`\n... [TRUNCATED ${lines.length - 1000} LINES] ...\n`);
            console.log(lines.slice(-500).join('\n'));
        } else {
            console.log(output);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        fs.appendFileSync(lifecycleLog, `[${new Date().toISOString()}] SUCCESS Atomic PID=${process.pid} Duration=${duration}s\n`);
        console.log("\n✅ Atomic Step Complete. Exiting to wait for next Cron trigger.");

    } catch (e) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        fs.appendFileSync(lifecycleLog, `[${new Date().toISOString()}] ERROR Atomic PID=${process.pid} Duration=${duration}s: ${e.message}\n`);
        console.error("Atomic Step Failed:", e.message);
        
        // We do NOT restart here. We let Cron handle the retry in 5 minutes.
        // This prevents infinite crash loops consuming resources.
        
        console.log("\n❌ Atomic Step Failed.");
        process.exit(1);
    }
}

run();
