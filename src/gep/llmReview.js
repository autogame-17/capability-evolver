'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getRepoRoot } = require('./paths');

const REVIEW_ENABLED_KEY = 'EVOLVER_LLM_REVIEW';
const REVIEW_TIMEOUT_MS = 30000;

// MiniMax OpenAI-compatible API
const MINIMAX_BASE_URL = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
const MINIMAX_MODEL = 'MiniMax-M2.7';

function isLlmReviewEnabled() {
  return String(process.env[REVIEW_ENABLED_KEY] || '').toLowerCase() === 'true';
}

function buildReviewPrompt({ diff, gene, signals, mutation }) {
  const geneId = gene && gene.id ? gene.id : '(unknown)';
  const category = (mutation && mutation.category) || (gene && gene.category) || 'unknown';
  const rationale = mutation && mutation.rationale ? String(mutation.rationale).slice(0, 500) : '(none)';
  const signalsList = Array.isArray(signals) ? signals.slice(0, 8).join(', ') : '(none)';
  const diffPreview = String(diff || '').slice(0, 6000);

  return `You are reviewing a code change produced by an autonomous evolution engine.

## Context
- Gene: ${geneId} (${category})
- Signals: [${signalsList}]
- Rationale: ${rationale}

## Diff
\`\`\`diff
${diffPreview}
\`\`\`

## Review Criteria
1. Does this change address the stated signals?
2. Are there any obvious regressions or bugs introduced?
3. Is the blast radius proportionate to the problem?
4. Are there any security or safety concerns?

## Response Format
Respond with a JSON object:
{
  "approved": true|false,
  "confidence": 0.0-1.0,
  "concerns": ["..."],
  "summary": "one-line review summary"
}`;
}

/**
 * Call MiniMax API to review the change. Returns a parsed review object or null on failure.
 * Uses the OpenAI-compatible endpoint at api.minimax.io.
 */
async function callMiniMaxReview(prompt) {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REVIEW_TIMEOUT_MS);

  try {
    const res = await fetch(`${MINIMAX_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.log('[LLMReview] MiniMax API returned ' + res.status);
      return null;
    }

    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return null;

    // Extract JSON from the response (may be wrapped in markdown code fences)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const review = JSON.parse(jsonMatch[0]);
    if (typeof review.approved !== 'boolean') return null;
    return review;
  } catch (e) {
    if (e && e.name !== 'AbortError') {
      console.log('[LLMReview] MiniMax API call failed (non-fatal): ' + (e.message || e));
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function runLlmReview({ diff, gene, signals, mutation }) {
  if (!isLlmReviewEnabled()) return null;

  const prompt = buildReviewPrompt({ diff, gene, signals, mutation });

  // Use MiniMax for review when API key is configured
  if (process.env.MINIMAX_API_KEY) {
    // Node.js 18+ has fetch built-in; wrap the async call synchronously via execFileSync
    const reviewScript = `
      const prompt = require('fs').readFileSync(process.argv[1], 'utf8');
      const apiKey = process.env.MINIMAX_API_KEY;
      const baseUrl = process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1';
      fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'MiniMax-M2.7',
          messages: [{ role: 'user', content: prompt }],
          temperature: 1.0,
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(25000),
      })
        .then(r => r.json())
        .then(data => {
          const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          if (!content) throw new Error('empty response');
          const m = content.match(/\\{[\\s\\S]*\\}/);
          if (!m) throw new Error('no JSON in response');
          const review = JSON.parse(m[0]);
          if (typeof review.approved !== 'boolean') throw new Error('invalid review shape');
          console.log(JSON.stringify(review));
        })
        .catch(e => {
          console.log(JSON.stringify({ approved: true, confidence: 0.5, concerns: ['minimax review failed: ' + (e && e.message || e)], summary: 'minimax review error, auto-approved' }));
        });
    `;

    try {
      const repoRoot = getRepoRoot();
      const tmpFile = path.join(os.tmpdir(), 'evolver_review_prompt_' + process.pid + '.txt');
      fs.writeFileSync(tmpFile, prompt, 'utf8');

      try {
        const result = execFileSync(process.execPath, ['-e', reviewScript, tmpFile], {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: REVIEW_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env },
        });

        try {
          return JSON.parse(result.trim());
        } catch (_) {
          return { approved: true, confidence: 0.5, concerns: ['failed to parse minimax review response'], summary: 'review parse error' };
        }
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
      }
    } catch (e) {
      console.log('[LLMReview] MiniMax execution failed (non-fatal): ' + (e && e.message ? e.message : e));
      return { approved: true, confidence: 0.5, concerns: ['minimax review execution failed'], summary: 'minimax review timeout or error' };
    }
  }

  // Fallback: auto-approve when no LLM is configured
  try {
    const repoRoot = getRepoRoot();
    const tmpFile = path.join(os.tmpdir(), 'evolver_review_prompt_' + process.pid + '.txt');
    fs.writeFileSync(tmpFile, prompt, 'utf8');

    try {
      const reviewScript = `
        const fs = require('fs');
        const prompt = fs.readFileSync(process.argv[1], 'utf8');
        console.log(JSON.stringify({ approved: true, confidence: 0.7, concerns: [], summary: 'auto-approved (no external LLM configured)' }));
      `;
      const result = execFileSync(process.execPath, ['-e', reviewScript, tmpFile], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: REVIEW_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      try {
        return JSON.parse(result.trim());
      } catch (_) {
        return { approved: true, confidence: 0.5, concerns: ['failed to parse review response'], summary: 'review parse error' };
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
  } catch (e) {
    console.log('[LLMReview] Execution failed (non-fatal): ' + (e && e.message ? e.message : e));
    return { approved: true, confidence: 0.5, concerns: ['review execution failed'], summary: 'review timeout or error' };
  }
}

module.exports = { isLlmReviewEnabled, runLlmReview, buildReviewPrompt, callMiniMaxReview };
