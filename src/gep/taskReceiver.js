// ---------------------------------------------------------------------------
// taskReceiver -- pulls external tasks from Hub, auto-claims, and injects
// them as high-priority signals into the evolution loop.
// ---------------------------------------------------------------------------

const { getNodeId } = require('./a2aProtocol');

const HUB_URL = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || 'https://evomap.ai';

/**
 * Fetch available tasks from Hub via the A2A fetch endpoint.
 * Optionally piggybacks proactive questions in the payload for Hub to create bounties.
 *
 * @param {object} [opts]
 * @param {Array<{ question: string, amount?: number, signals?: string[] }>} [opts.questions]
 * @returns {{ tasks: Array, questions_created?: Array }}
 */
async function fetchTasks(opts) {
  const o = opts || {};
  const nodeId = getNodeId();
  if (!nodeId) return { tasks: [] };

  try {
    const payload = {
      asset_type: null,
      include_tasks: true,
    };

    if (Array.isArray(o.questions) && o.questions.length > 0) {
      payload.questions = o.questions;
    }

    const msg = {
      protocol: 'gep-a2a',
      protocol_version: '1.0.0',
      message_type: 'fetch',
      message_id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sender_id: nodeId,
      timestamp: new Date().toISOString(),
      payload,
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

    if (!res.ok) return { tasks: [] };

    const data = await res.json();
    const respPayload = data.payload || data;
    const tasks = Array.isArray(respPayload.tasks) ? respPayload.tasks : [];
    const result = { tasks };

    if (respPayload.questions_created) {
      result.questions_created = respPayload.questions_created;
    }

    return result;
  } catch {
    return { tasks: [] };
  }
}

/**
 * Pick the best task from a list. Priority:
 *   1. Bounty tasks (higher amount first)
 *   2. Tasks already claimed by this node
 *   3. Open tasks (newest first)
 * @param {Array} tasks
 * @returns {object|null}
 */
function selectBestTask(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const nodeId = getNodeId();

  // Already-claimed tasks for this node take top priority (resume work)
  const myClaimedTask = tasks.find(
    t => t.status === 'claimed' && t.claimed_by_node_id === nodeId
  );
  if (myClaimedTask) return myClaimedTask;

  // Filter to open tasks only
  const open = tasks.filter(t => t.status === 'open');
  if (open.length === 0) return null;

  // Prefer bounty tasks, sorted by amount descending
  const bountyTasks = open.filter(t => t.bounty_id);
  if (bountyTasks.length > 0) {
    bountyTasks.sort((a, b) => (b.bounty_amount || 0) - (a.bounty_amount || 0));
    return bountyTasks[0];
  }

  // Fallback: newest open task
  return open[0];
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
    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/task/claim`;
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
    const url = `${HUB_URL.replace(/\/+$/, '')}/a2a/task/complete`;
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
  if (task.signals) {
    const parts = String(task.signals).split(',').map(s => s.trim()).filter(Boolean);
    signals.push(...parts);
  }
  if (task.title) {
    const words = String(task.title).toLowerCase().split(/\s+/).filter(w => w.length >= 3);
    for (const w of words.slice(0, 5)) {
      if (!signals.includes(w)) signals.push(w);
    }
  }
  signals.push('external_task');
  if (task.bounty_id) signals.push('bounty_task');
  return signals;
}

module.exports = {
  fetchTasks,
  selectBestTask,
  claimTask,
  completeTask,
  taskToSignals,
};
