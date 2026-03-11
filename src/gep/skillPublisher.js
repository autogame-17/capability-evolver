'use strict';

var { getHubUrl, buildHubHeaders, getNodeId } = require('./a2aProtocol');

/**
 * Convert a Gene object into SKILL.md format (Claude/Anthropic style).
 *
 * @param {object} gene - Gene asset
 * @returns {string} SKILL.md content
 */
function geneToSkillMd(gene) {
  var name = (gene.id || 'unnamed-skill').replace(/^gene_distilled_/, '').replace(/_/g, '-');
  var desc = gene.summary || 'AI agent skill distilled from evolution experience.';

  var lines = [
    '---',
    'name: ' + name,
    'description: ' + desc,
    '---',
    '',
    '# ' + name,
    '',
  ];

  if (gene.signals_match && gene.signals_match.length > 0) {
    lines.push('## Trigger Signals');
    lines.push('');
    gene.signals_match.forEach(function (s) {
      lines.push('- `' + s + '`');
    });
    lines.push('');
  }

  if (gene.preconditions && gene.preconditions.length > 0) {
    lines.push('## Preconditions');
    lines.push('');
    gene.preconditions.forEach(function (p) {
      lines.push('- ' + p);
    });
    lines.push('');
  }

  if (gene.strategy && gene.strategy.length > 0) {
    lines.push('## Strategy');
    lines.push('');
    gene.strategy.forEach(function (step, i) {
      lines.push((i + 1) + '. ' + step);
    });
    lines.push('');
  }

  if (gene.constraints) {
    lines.push('## Constraints');
    lines.push('');
    if (gene.constraints.max_files) {
      lines.push('- Max files: ' + gene.constraints.max_files);
    }
    if (gene.constraints.forbidden_paths && gene.constraints.forbidden_paths.length > 0) {
      lines.push('- Forbidden paths: ' + gene.constraints.forbidden_paths.join(', '));
    }
    lines.push('');
  }

  if (gene.validation && gene.validation.length > 0) {
    lines.push('## Validation');
    lines.push('');
    gene.validation.forEach(function (cmd) {
      lines.push('```bash');
      lines.push(cmd);
      lines.push('```');
      lines.push('');
    });
  }

  return lines.join('\n');
}

/**
 * Publish a Gene as a Skill to the Hub skill store.
 *
 * @param {object} gene - Gene asset
 * @param {object} [opts] - { category, tags }
 * @returns {Promise<{ok: boolean, result?: object, error?: string}>}
 */
function publishSkillToHub(gene, opts) {
  opts = opts || {};
  var hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });

  var content = geneToSkillMd(gene);
  var nodeId = getNodeId();
  var skillId = 'skill_' + (gene.id || 'unnamed').replace(/^gene_/, '');

  var body = {
    sender_id: nodeId,
    skill_id: skillId,
    content: content,
    category: opts.category || gene.category || null,
    tags: opts.tags || gene.signals_match || [],
  };

  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/skill/store/publish';

  return fetch(endpoint, {
    method: 'POST',
    headers: buildHubHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
    .then(function (res) { return res.json().then(function (data) { return { status: res.status, data: data }; }); })
    .then(function (result) {
      if (result.status === 201 || result.status === 200) {
        return { ok: true, result: result.data };
      }
      if (result.status === 409) {
        return updateSkillOnHub(nodeId, skillId, content, opts, gene);
      }
      return { ok: false, error: result.data?.error || 'publish_failed', status: result.status };
    })
    .catch(function (err) {
      return { ok: false, error: err.message };
    });
}

/**
 * Update an existing Skill on the Hub (new version).
 */
function updateSkillOnHub(nodeId, skillId, content, opts, gene) {
  var hubUrl = getHubUrl();
  if (!hubUrl) return Promise.resolve({ ok: false, error: 'no_hub_url' });

  var body = {
    sender_id: nodeId,
    skill_id: skillId,
    content: content,
    category: opts.category || gene.category || null,
    tags: opts.tags || gene.signals_match || [],
    changelog: 'Iterative evolution update',
  };

  var endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/skill/store/update';

  return fetch(endpoint, {
    method: 'PUT',
    headers: buildHubHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) { return { ok: true, result: data }; })
    .catch(function (err) { return { ok: false, error: err.message }; });
}

module.exports = {
  geneToSkillMd: geneToSkillMd,
  publishSkillToHub: publishSkillToHub,
  updateSkillOnHub: updateSkillOnHub,
};
