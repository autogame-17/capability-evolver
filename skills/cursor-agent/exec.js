const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SESSION = 'cursor-automation';
const OUTPUT_FILE = path.join('/tmp', `cursor_${Date.now()}.log`);
const DONE_FILE = path.join('/tmp', `cursor_${Date.now()}.done`);
const TIMEOUT_MS = 120000; // 2 minutes

const prompt = process.argv[2];

if (!prompt) {
  console.error('Usage: node exec.js "prompt"');
  process.exit(1);
}

// Helper to run shell command
function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8' });
  } catch (e) {
    return e.stdout || ''; // Tmux commands might fail if session doesn't exist etc.
  }
}

// Clean up previous run artifacts
if (fs.existsSync(OUTPUT_FILE)) fs.unlinkSync(OUTPUT_FILE);
if (fs.existsSync(DONE_FILE)) fs.unlinkSync(DONE_FILE);

// Ensure tmux session exists or create it
// We kill it first to ensure clean state for this job
run(`tmux kill-session -t ${SESSION} 2>/dev/null`);
run(`tmux new-session -d -s ${SESSION}`);

console.log(`[Cursor] Session '${SESSION}' started.`);

// Prepare command
// We use -p for non-interactive (CI mode) but wrap in tmux for TTY.
// We redirect output to file and signal completion.
// Escaping quotes in prompt is important.
const safePrompt = prompt.replace(/"/g, '\\"');
const command = `/home/crishaocredits/.local/bin/agent -p "${safePrompt}" --output-format text --force > ${OUTPUT_FILE} 2>&1; echo "DONE" > ${DONE_FILE}`;

console.log(`[Cursor] Executing: ${safePrompt.substring(0, 50)}...`);

// Send command to tmux
run(`tmux send-keys -t ${SESSION} '${command}' Enter`);

// Poll for completion
const start = Date.now();
const interval = setInterval(() => {
  if (fs.existsSync(DONE_FILE)) {
    clearInterval(interval);
    finish(true);
  } else if (Date.now() - start > TIMEOUT_MS) {
    clearInterval(interval);
    console.error('[Cursor] Timeout waiting for agent.');
    finish(false);
  }
}, 1000);

function finish(success) {
  // Read output
  let output = '';
  if (fs.existsSync(OUTPUT_FILE)) {
    output = fs.readFileSync(OUTPUT_FILE, 'utf8');
  } else {
    // Fallback: capture pane if file write failed
    output = run(`tmux capture-pane -t ${SESSION} -p -S -100`);
  }

  // Cleanup
  run(`tmux kill-session -t ${SESSION}`);
  if (fs.existsSync(OUTPUT_FILE)) fs.unlinkSync(OUTPUT_FILE);
  if (fs.existsSync(DONE_FILE)) fs.unlinkSync(DONE_FILE);

  if (success) {
    console.log('[Cursor] Output:');
    console.log(output);
  } else {
    console.log('[Cursor] Failed/Timed out. Partial output:');
    console.log(output);
    process.exit(1);
  }
}
