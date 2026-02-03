const { execSync } = require('child_process');
const path = require('path');

// This wrapper is for FEISHU-SPECIFIC environments.
// It sets environment variables to prioritize Feishu Cards and configure crash reporting.

async function run() {
    console.log('🚀 Launching Feishu Evolver Wrapper (Env Injector)...');
    
    // 1. Force Feishu Card Reporting for normal logs
    process.env.EVOLVE_REPORT_TOOL = 'feishu-card';
    
    // 2. Configure Failure Hook
    // When the main script detects a crash, it will execute this command.
    // The main script writes the error to `evolution_error.log` in its own directory.
    const cardSender = path.resolve(__dirname, '../feishu-card/send.js');
    const errorLog = path.resolve(__dirname, '../evolver/evolution_error.log');
    
    // Command: node send.js --title "Evolution Failed" --color red --text-file "error.log"
    // Note: We wrap paths in quotes to handle spaces.
    const failHook = `node "${cardSender}" --title "Evolution Critical Failure" --color red --text-file "${errorLog}"`;
    
    process.env.ON_EVOLUTION_FAIL = failHook;
    
    try {
        // Pass all CLI arguments through to the main index.js
        const args = process.argv.slice(2).join(' ');
        const mainScript = path.resolve(__dirname, '../evolver/index.js');
        
        // 3. Inject Reporting Directive for Feishu
        process.env.EVOLVE_REPORT_DIRECTIVE = `3.  **📝 REPORT (FEISHU WRAPPER)**:
    - You **MUST** use the \`feishu-card\` skill (NOT the generic \`message\` tool).
    - **Frequency**: Report EVERY cycle (Wrapper Policy).
    - **Command**:
      \`\`\`bash
      node skills/feishu-card/send.js --title "🧬 Evolution __CYCLE_ID__ Log" --color blue --text "Status: [RUNNING]\\nAction: ... (What did you check? What did you fix?)"
      \`\`\`
    - **Target**: Auto-detects context.`;

        // 4. Inject Wrapper Sync Rule (Environment Specific)
        process.env.EVOLVE_EXTRA_MODES = `- **Mode F (Wrapper Sync)**: 🔗 **MANDATORY**: You are running inside the **Feishu Wrapper**. If you modify Core files (\`index.js\`, \`evolve.js\`), you **MUST** check \`../feishu-evolver-wrapper/index.js\`.
      - **Action**: If Core CLI/Env changes, update the Wrapper to match.
      - **Goal**: Keep Core and Wrapper in sync.`;

    // 5. Inject Integration Health Check (Feishu Specific)
    // The core `evolve.js` will execute this command and include the output in the health report.
    const checkScript = path.resolve(__dirname, 'check_health.js');
    process.env.INTEGRATION_STATUS_CMD = `node "${checkScript}"`;

    // Execute main script with inherited stdio
    execSync(`node "${mainScript}" ${args}`, { stdio: 'inherit' });

    } catch (e) {
        // The main script handles its own crash reporting via the hook.
        // This wrapper just exits.
        process.exit(1);
    }
}

run();
