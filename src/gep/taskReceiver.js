// ---------------------------------------------------------------------------
// taskReceiver -- pulls external tasks from Hub and injects them as signals.
//
// Called during the evolution loop before normal signal extraction.
// If a task with a bounty is available, its signals are injected with
// high priority so the evolver focuses on it.
// ---------------------------------------------------------------------------

const { getRepoRoot } = require('./paths');
const path = require('path');
const fs = require('fs');

const HUB_URL = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || 'https://evomap.ai';
const NODE_ID = process.env.A2A_NODE_ID || null;

function getNodeId() {
  if (NODE_ID) return NODE_ID;
  // Try to read from local state
  try {
    const stateFile = path.join(getRepoRoot(), '.openclaw', 'node_id');
    if (fs.existsSync(stateFile)) return fs.readFileSync(stateFile, 'utf8').trim();
  } catch {}
  return null;
}

/**
 * Fetch available tasks from Hub via the A2A fetch endpoint.
 * @returns {Array} Array of task objects, or empty array on failure.
 */
async function fetchTasks() {
  const nodeId = getNodeId();
  if (!nodeId) return [];

  try {
    const msg = {
      protocol: 'gep-a2a',
      protocol_version: '1.0.0',
      message_type: 'fetch',
      message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: nodeId,
      timestamp: new Date().toISOString(),
      payload: {
        asset_type: null,
        include_tasks: true,
      },
    };

    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/fetch`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return [];

    const data = await res.json();
    const payload = data.payload || data;
    return Array.isArray(payload.tasks) ? payload.tasks : [];
  } catch {
    return [];
  }
}

/**
 * Claim a task on the Hub.
 * @param {string} taskId
 * @returns {boolean} true if claim succeeded
 */
async function claimTask(taskId) {
  const nodeId = getNodeId();
  if (!nodeId || !taskId) return false;

  try {
    const url = `${HUB_URL.replace(/\/+$/, '')}/task/claim`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, node_id: nodeId }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Complete a task on the Hub with the result asset ID.
 * @param {string} taskId
 * @param {string} assetId
 * @returns {boolean}
 */
async function completeTask(taskId, assetId) {
  const nodeId = getNodeId();
  if (!nodeId || !taskId || !assetId) return false;

  try {
    const url = `${HUB_URL.replace(/\/+$/, '')}/task/complete`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId, asset_id: assetId, node_id: nodeId }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Extract signals from a task to inject into evolution cycle.
 * @param {object} task
 * @returns {string[]} signals array
 */
function taskToSignals(task) {
  if (!task) return [];
  const signals = [];
  // Parse comma-separated signals
  if (task.signals) {
    const parts = String(task.signals).split(',').map(s => s.trim()).filter(Boolean);
    signals.push(...parts);
  }
  // Add task marker signal
  signals.push('external_task');
  if (task.bounty_id) signals.push('bounty_task');
  return signals;
}

module.exports = {
  fetchTasks,
  claimTask,
  completeTask,
  taskToSignals,
};
