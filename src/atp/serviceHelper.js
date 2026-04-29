// ATP Service Helper -- wraps marketplace service publishing for merchant agents.

const { getNodeId, buildHubHeaders, getHubUrl } = require('../gep/a2aProtocol');
const { redactString } = require('../gep/sanitize');

const MAX_TITLE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_LIST_ITEMS = 12;
const MAX_LIST_ITEM_LENGTH = 80;
const ALLOWED_EXECUTION_MODES = new Set(['exclusive', 'open', 'swarm']);

function cleanText(value, fallback, maxLength) {
  const text = redactString(String(value == null ? '' : value)).trim();
  if (!text) return fallback || '';
  return text.slice(0, maxLength);
}

function cleanStringList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(function (item) { return cleanText(item, '', MAX_LIST_ITEM_LENGTH); })
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

function normalizeExecutionMode(value) {
  const mode = String(value || 'exclusive').trim().toLowerCase();
  return ALLOWED_EXECUTION_MODES.has(mode) ? mode : 'exclusive';
}

function sanitizeServicePayload(svc) {
  const input = svc || {};
  return {
    title: cleanText(input.title, '', MAX_TITLE_LENGTH),
    description: cleanText(input.description, '', MAX_DESCRIPTION_LENGTH),
    capabilities: cleanStringList(input.capabilities),
    use_cases: cleanStringList(input.useCases),
    price_per_task: Math.max(1, Math.round(Number(input.pricePerTask) || 10)),
    execution_mode: normalizeExecutionMode(input.executionMode),
    max_concurrent: Math.max(1, Math.min(50, Math.round(Number(input.maxConcurrent) || 3))),
    recipe_id: input.recipeId == null || input.recipeId === '' ? undefined : cleanText(input.recipeId, '', MAX_LIST_ITEM_LENGTH),
  };
}

function sanitizeServiceUpdates(updates) {
  const input = updates || {};
  const out = {};
  if (Object.prototype.hasOwnProperty.call(input, 'title')) out.title = cleanText(input.title, '', MAX_TITLE_LENGTH);
  if (Object.prototype.hasOwnProperty.call(input, 'description')) out.description = cleanText(input.description, '', MAX_DESCRIPTION_LENGTH);
  if (Object.prototype.hasOwnProperty.call(input, 'capabilities')) out.capabilities = cleanStringList(input.capabilities);
  if (Object.prototype.hasOwnProperty.call(input, 'useCases')) out.use_cases = cleanStringList(input.useCases);
  if (Object.prototype.hasOwnProperty.call(input, 'pricePerTask')) out.price_per_task = Math.max(1, Math.round(Number(input.pricePerTask) || 10));
  if (Object.prototype.hasOwnProperty.call(input, 'executionMode')) out.execution_mode = normalizeExecutionMode(input.executionMode);
  if (Object.prototype.hasOwnProperty.call(input, 'maxConcurrent')) out.max_concurrent = Math.max(1, Math.min(50, Math.round(Number(input.maxConcurrent) || 3)));
  if (Object.prototype.hasOwnProperty.call(input, 'recipeId')) out.recipe_id = input.recipeId == null || input.recipeId === '' ? undefined : cleanText(input.recipeId, '', MAX_LIST_ITEM_LENGTH);
  return out;
}

/**
 * Publish a ServiceListing via the Hub marketplace API.
 * @param {object} svc
 * @param {string} svc.title
 * @param {string} [svc.description]
 * @param {string[]} [svc.capabilities]
 * @param {string[]} [svc.useCases]
 * @param {number} [svc.pricePerTask] - min 1 Credit
 * @param {string} [svc.executionMode] - exclusive | open | swarm
 * @param {number} [svc.maxConcurrent]
 * @param {string} [svc.recipeId]
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function publishService(svc) {
  const hubUrl = getHubUrl();
  if (!hubUrl) return { ok: false, error: 'no_hub_url' };

  const nodeId = getNodeId();
  const endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/service/publish';
  const timeout = require('../config').HTTP_TRANSPORT_TIMEOUT_MS;

  const payload = sanitizeServicePayload(svc);
  if (!payload.title) return { ok: false, error: 'title is required' };
  const body = {
    sender_id: nodeId,
    title: payload.title,
    description: payload.description,
    capabilities: payload.capabilities,
    use_cases: payload.use_cases,
    price_per_task: payload.price_per_task,
    execution_mode: payload.execution_mode,
    max_concurrent: payload.max_concurrent,
    recipe_id: payload.recipe_id,
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: buildHubHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const t = await res.text();
      return { ok: false, status: res.status, error: t.slice(0, 400) };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Update an existing ServiceListing.
 * @param {string} listingId
 * @param {object} updates
 * @returns {Promise<{ok: boolean, data?: object, error?: string}>}
 */
async function updateService(listingId, updates) {
  const hubUrl = getHubUrl();
  if (!hubUrl) return { ok: false, error: 'no_hub_url' };

  const nodeId = getNodeId();
  const endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/service/update';
  const timeout = require('../config').HTTP_TRANSPORT_TIMEOUT_MS;

  const body = {
    sender_id: nodeId,
    listing_id: cleanText(listingId, '', MAX_LIST_ITEM_LENGTH),
    ...sanitizeServiceUpdates(updates),
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: buildHubHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const t = await res.text();
      return { ok: false, status: res.status, error: t.slice(0, 400) };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  publishService,
  updateService,
  sanitizeServicePayload,
  sanitizeServiceUpdates,
};
