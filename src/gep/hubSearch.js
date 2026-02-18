// Hub Search-First Evolution: query evomap-hub for reusable solutions before local solve.
//
// Flow: extractSignals() -> hubSearch(signals) -> if hit: reuse; if miss: normal evolve
// Two modes: direct (skip local reasoning) | reference (inject into prompt as strong hint)

const { getNodeId } = require('./a2aProtocol');

const DEFAULT_MIN_REUSE_SCORE = 0.72;
const DEFAULT_REUSE_MODE = 'reference'; // 'direct' | 'reference'

function getHubUrl() {
  return (process.env.A2A_HUB_URL || '').replace(/\/+$/, '');
}

function getReuseMode() {
  const m = String(process.env.EVOLVER_REUSE_MODE || DEFAULT_REUSE_MODE).toLowerCase();
  return m === 'direct' ? 'direct' : 'reference';
}

function getMinReuseScore() {
  const n = Number(process.env.EVOLVER_MIN_REUSE_SCORE);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_REUSE_SCORE;
}

/**
 * Score a hub asset for local reuse quality.
 * rank = confidence * max(success_streak, 1) * (reputation / 100)
 */
function scoreHubResult(asset) {
  const confidence = Number(asset.confidence) || 0;
  const streak = Math.max(Number(asset.success_streak) || 0, 1);
  // Reputation is included in asset from hub ranked endpoint; default 50 if missing
  const reputation = Number(asset.reputation_score) || 50;
  return confidence * streak * (reputation / 100);
}

/**
 * Pick the best matching asset above the threshold.
 * Returns { match, score, mode } or null if nothing qualifies.
 */
function pickBestMatch(results, threshold) {
  if (!Array.isArray(results) || results.length === 0) return null;

  let best = null;
  let bestScore = 0;

  for (const asset of results) {
    // Only consider promoted assets
    if (asset.status && asset.status !== 'promoted') continue;
    const s = scoreHubResult(asset);
    if (s > bestScore) {
      bestScore = s;
      best = asset;
    }
  }

  if (!best || bestScore < threshold) return null;

  return {
    match: best,
    score: Math.round(bestScore * 1000) / 1000,
    mode: getReuseMode(),
  };
}

/**
 * Search the hub for reusable capsules matching the given signals.
 * Returns { hit: true, match, score, mode } or { hit: false }.
 */
async function hubSearch(signals, opts) {
  const hubUrl = getHubUrl();
  if (!hubUrl) return { hit: false, reason: 'no_hub_url' };

  const signalList = Array.isArray(signals) ? signals.filter(Boolean) : [];
  if (signalList.length === 0) return { hit: false, reason: 'no_signals' };

  const threshold = (opts && Number.isFinite(opts.threshold)) ? opts.threshold : getMinReuseScore();
  const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : 5;
  const timeout = (opts && Number.isFinite(opts.timeoutMs)) ? opts.timeoutMs : 8000;

  try {
    const params = new URLSearchParams();
    params.set('signals', signalList.join(','));
    params.set('status', 'promoted');
    params.set('limit', String(limit));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const url = `${hubUrl}/a2a/assets/search?${params.toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return { hit: false, reason: `hub_http_${res.status}` };

    const data = await res.json();
    const assets = Array.isArray(data.assets) ? data.assets : [];

    if (assets.length === 0) return { hit: false, reason: 'no_results' };

    const pick = pickBestMatch(assets, threshold);
    if (!pick) return { hit: false, reason: 'below_threshold', candidates: assets.length };

    console.log(`[HubSearch] Hit: ${pick.match.asset_id || pick.match.local_id} (score=${pick.score}, mode=${pick.mode})`);

    return {
      hit: true,
      match: pick.match,
      score: pick.score,
      mode: pick.mode,
      asset_id: pick.match.asset_id || null,
      source_node_id: pick.match.source_node_id || null,
      chain_id: pick.match.chain_id || null,
    };
  } catch (err) {
    // Hub unreachable is non-fatal; fall through to normal evolve
    console.log(`[HubSearch] Failed (non-fatal): ${err.message}`);
    return { hit: false, reason: 'fetch_error', error: err.message };
  }
}

module.exports = {
  hubSearch,
  scoreHubResult,
  pickBestMatch,
  getReuseMode,
  getMinReuseScore,
  getHubUrl,
};
