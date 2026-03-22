// Constraint checking, blast radius analysis, validation, and failure classification.
// Extracted from solidify.js for maintainability.

const fs = require('fs');
const path = require('path');
const { getRepoRoot, getWorkspaceRoot } = require('./paths');
const {
  tryRunCmd, normalizeRelPath, countFileLines,
  gitListChangedFiles, isCriticalProtectedPath,
} = require('./gitOps');

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[policyCheck] Failed to read ' + filePath + ':', e && e.message || e);
    return fallback;
  }
}

function readOpenclawConstraintPolicy() {
  const defaults = {
    excludePrefixes: ['logs/', 'memory/', 'assets/gep/', 'out/', 'temp/', 'node_modules/'],
    excludeExact: ['event.json', 'temp_gep_output.json', 'temp_evolution_output.json', 'evolution_error.log'],
    excludeRegex: ['capsule', 'events?\\.jsonl$'],
    includePrefixes: ['src/', 'scripts/', 'config/'],
    includeExact: ['index.js', 'package.json'],
    includeExtensions: ['.js', '.cjs', '.mjs', '.ts', '.tsx', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh'],
  };
  try {
    const root = path.resolve(getWorkspaceRoot(), '..');
    const cfgPath = path.join(root, 'openclaw.json');
    if (!fs.existsSync(cfgPath)) return defaults;
    const obj = readJsonIfExists(cfgPath, {});
    const pol =
      obj &&
      obj.evolver &&
      obj.evolver.constraints &&
      obj.evolver.constraints.countedFilePolicy &&
      typeof obj.evolver.constraints.countedFilePolicy === 'object'
        ? obj.evolver.constraints.countedFilePolicy
        : {};
    return {
      excludePrefixes: Array.isArray(pol.excludePrefixes) ? pol.excludePrefixes.map(String) : defaults.excludePrefixes,
      excludeExact: Array.isArray(pol.excludeExact) ? pol.excludeExact.map(String) : defaults.excludeExact,
      excludeRegex: Array.isArray(pol.excludeRegex) ? pol.excludeRegex.map(String) : defaults.excludeRegex,
      includePrefixes: Array.isArray(pol.includePrefixes) ? pol.includePrefixes.map(String) : defaults.includePrefixes,
      includeExact: Array.isArray(pol.includeExact) ? pol.includeExact.map(String) : defaults.includeExact,
      includeExtensions: Array.isArray(pol.includeExtensions) ? pol.includeExtensions.map(String) : defaults.includeExtensions,
    };
  } catch (_) {
    console.warn('[policyCheck] readOpenclawConstraintPolicy failed:', _ && _.message || _);
    return defaults;
  }
}

function matchAnyPrefix(rel, prefixes) {
  const list = Array.isArray(prefixes) ? prefixes : [];
  for (const p of list) {
    const n = normalizeRelPath(p).replace(/\/+$/, '');
    if (!n) continue;
    if (rel === n || rel.startsWith(n + '/')) return true;
  }
  return false;
}

function matchAnyExact(rel, exacts) {
  const set = new Set((Array.isArray(exacts) ? exacts : []).map(x => normalizeRelPath(x)));
  return set.has(rel);
}

function matchAnyRegex(rel, regexList) {
  for (const raw of Array.isArray(regexList) ? regexList : []) {
    try {
      if (new RegExp(String(raw), 'i').test(rel)) return true;
    } catch (_) {
      console.warn('[policyCheck] matchAnyRegex invalid pattern:', raw, _ && _.message || _);
    }
  }
  return false;
}

function isConstraintCountedPath(relPath, policy) {
  const rel = normalizeRelPath(relPath);
  if (!rel) return false;
  if (matchAnyExact(rel, policy.excludeExact)) return false;
  if (matchAnyPrefix(rel, policy.excludePrefixes)) return false;
  if (matchAnyRegex(rel, policy.excludeRegex)) return false;
  if (matchAnyExact(rel, policy.includeExact)) return true;
  if (matchAnyPrefix(rel, policy.includePrefixes)) return true;
  const lower = rel.toLowerCase();
  for (const ext of Array.isArray(policy.includeExtensions) ? policy.includeExtensions : []) {
    const e = String(ext || '').toLowerCase();
    if (!e) continue;
    if (lower.endsWith(e)) return true;
  }
  return false;
}

function parseNumstatRows(text) {
  const rows = [];
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const a = Number(parts[0]);
    const d = Number(parts[1]);
    let rel = normalizeRelPath(parts.slice(2).join('\t'));
    if (rel.includes('=>')) {
      const right = rel.split('=>').pop();
      rel = normalizeRelPath(String(right || '').replace(/[{}]/g, '').trim());
    }
    rows.push({
      file: rel,
      added: Number.isFinite(a) ? a : 0,
      deleted: Number.isFinite(d) ? d : 0,
    });
  }
  return rows;
}

function computeBlastRadius({ repoRoot, baselineUntracked }) {
  const policy = readOpenclawConstraintPolicy();
  let changedFiles = gitListChangedFiles({ repoRoot }).map(normalizeRelPath).filter(Boolean);
  if (Array.isArray(baselineUntracked) && baselineUntracked.length > 0) {
    const baselineSet = new Set(baselineUntracked.map(normalizeRelPath));
    changedFiles = changedFiles.filter(f => !baselineSet.has(f));
  }
  const countedFiles = changedFiles.filter(f => isConstraintCountedPath(f, policy));
  const ignoredFiles = changedFiles.filter(f => !isConstraintCountedPath(f, policy));
  const filesCount = countedFiles.length;

  const u = tryRunCmd('git diff --numstat', { cwd: repoRoot, timeoutMs: 60000 });
  const c = tryRunCmd('git diff --cached --numstat', { cwd: repoRoot, timeoutMs: 60000 });
  const unstagedRows = u.ok ? parseNumstatRows(u.out) : [];
  const stagedRows = c.ok ? parseNumstatRows(c.out) : [];
  let stagedUnstagedChurn = 0;
  for (const row of [...unstagedRows, ...stagedRows]) {
    if (!isConstraintCountedPath(row.file, policy)) continue;
    stagedUnstagedChurn += row.added + row.deleted;
  }

  const untracked = tryRunCmd('git ls-files --others --exclude-standard', { cwd: repoRoot, timeoutMs: 60000 });
  let untrackedLines = 0;
  if (untracked.ok) {
    const rels = String(untracked.out).split('\n').map(normalizeRelPath).filter(Boolean);
    const baselineSet = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(normalizeRelPath));
    for (const rel of rels) {
      if (baselineSet.has(rel)) continue;
      if (!isConstraintCountedPath(rel, policy)) continue;
      const abs = path.join(repoRoot, rel);
      untrackedLines += countFileLines(abs);
    }
  }
  const churn = stagedUnstagedChurn + untrackedLines;
  return {
    files: filesCount,
    lines: churn,
    changed_files: countedFiles,
    ignored_files: ignoredFiles,
    all_changed_files: changedFiles,
  };
}

function isForbiddenPath(relPath, forbiddenPaths) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  const list = Array.isArray(forbiddenPaths) ? forbiddenPaths : [];
  for (const fp of list) {
    const f = String(fp || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!f) continue;
    if (rel === f) return true;
    if (rel.startsWith(f + '/')) return true;
  }
  return false;
}

const BLAST_RADIUS_HARD_CAP_FILES = Number(process.env.EVOLVER_HARD_CAP_FILES) || 60;
const BLAST_RADIUS_HARD_CAP_LINES = Number(process.env.EVOLVER_HARD_CAP_LINES) || 20000;
const BLAST_WARN_RATIO = 0.8;
const BLAST_CRITICAL_RATIO = 2.0;

function classifyBlastSeverity({ blast, maxFiles }) {
  const files = Number(blast.files) || 0;
  const lines = Number(blast.lines) || 0;
  if (files > BLAST_RADIUS_HARD_CAP_FILES || lines > BLAST_RADIUS_HARD_CAP_LINES) {
    return {
      severity: 'hard_cap_breach',
      message: `HARD CAP BREACH: ${files} files / ${lines} lines exceeds system limit (${BLAST_RADIUS_HARD_CAP_FILES} files / ${BLAST_RADIUS_HARD_CAP_LINES} lines)`,
    };
  }
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) {
    return { severity: 'within_limit', message: 'no max_files constraint defined' };
  }
  if (files > maxFiles * BLAST_CRITICAL_RATIO) {
    return {
      severity: 'critical_overrun',
      message: `CRITICAL OVERRUN: ${files} files > ${maxFiles * BLAST_CRITICAL_RATIO} (${BLAST_CRITICAL_RATIO}x limit of ${maxFiles}). Agent likely performed bulk/unintended operation.`,
    };
  }
  if (files > maxFiles) {
    return { severity: 'exceeded', message: `max_files exceeded: ${files} > ${maxFiles}` };
  }
  if (files > maxFiles * BLAST_WARN_RATIO) {
    return {
      severity: 'approaching_limit',
      message: `approaching limit: ${files} / ${maxFiles} files (${Math.round((files / maxFiles) * 100)}%)`,
    };
  }
  return { severity: 'within_limit', message: `${files} / ${maxFiles} files` };
}

function analyzeBlastRadiusBreakdown(changedFiles, topN) {
  const n = Number.isFinite(topN) && topN > 0 ? topN : 5;
  const dirCount = {};
  for (const f of Array.isArray(changedFiles) ? changedFiles : []) {
    const rel = normalizeRelPath(f);
    if (!rel) continue;
    const parts = rel.split('/');
    const key = parts.length >= 2 ? parts.slice(0, 2).join('/') : parts[0];
    dirCount[key] = (dirCount[key] || 0) + 1;
  }
  return Object.entries(dirCount)
    .sort(function (a, b) { return b[1] - a[1]; })
    .slice(0, n)
    .map(function (e) { return { dir: e[0], files: e[1] }; });
}

function compareBlastEstimate(estimate, actual) {
  if (!estimate || typeof estimate !== 'object') return null;
  const estFiles = Number(estimate.files);
  const actFiles = Number(actual.files);
  if (!Number.isFinite(estFiles) || estFiles <= 0) return null;
  const ratio = actFiles / estFiles;
  return {
    estimateFiles: estFiles,
    actualFiles: actFiles,
    ratio: Math.round(ratio * 100) / 100,
    drifted: ratio > 3 || ratio < 0.1,
    message: ratio > 3
      ? `Estimate drift: actual ${actFiles} files is ${ratio.toFixed(1)}x the estimated ${estFiles}. Agent did not plan accurately.`
      : null,
  };
}

function checkConstraints({ gene, blast, blastRadiusEstimate, repoRoot }) {
  const violations = [];
  const warnings = [];
  let blastSeverity = null;

  if (!gene || gene.type !== 'Gene') return { ok: true, violations, warnings, blastSeverity };
  const constraints = gene.constraints || {};
  const DEFAULT_MAX_FILES = 20;
  const maxFiles = Number(constraints.max_files) > 0 ? Number(constraints.max_files) : DEFAULT_MAX_FILES;

  blastSeverity = classifyBlastSeverity({ blast, maxFiles });

  if (blastSeverity.severity === 'hard_cap_breach') {
    violations.push(blastSeverity.message);
    console.error(`[Solidify] ${blastSeverity.message}`);
  } else if (blastSeverity.severity === 'critical_overrun') {
    violations.push(blastSeverity.message);
    const breakdown = analyzeBlastRadiusBreakdown(blast.all_changed_files || blast.changed_files || []);
    console.error(`[Solidify] ${blastSeverity.message}`);
    console.error(`[Solidify] Top contributing directories: ${breakdown.map(function (d) { return d.dir + ' (' + d.files + ')'; }).join(', ')}`);
  } else if (blastSeverity.severity === 'exceeded') {
    violations.push(`max_files exceeded: ${blast.files} > ${maxFiles}`);
  } else if (blastSeverity.severity === 'approaching_limit') {
    warnings.push(blastSeverity.message);
  }

  const estimateComparison = compareBlastEstimate(blastRadiusEstimate, blast);
  if (estimateComparison && estimateComparison.drifted) {
    warnings.push(estimateComparison.message);
    console.log(`[Solidify] WARNING: ${estimateComparison.message}`);
  }

  const forbidden = Array.isArray(constraints.forbidden_paths) ? constraints.forbidden_paths : [];
  for (const f of blast.all_changed_files || blast.changed_files || []) {
    if (isForbiddenPath(f, forbidden)) violations.push(`forbidden_path touched: ${f}`);
  }

  const allowSelfModify = String(process.env.EVOLVE_ALLOW_SELF_MODIFY || '').toLowerCase() === 'true';
  for (const f of blast.all_changed_files || blast.changed_files || []) {
    if (isCriticalProtectedPath(f)) {
      const norm = normalizeRelPath(f);
      if (allowSelfModify && norm.startsWith('skills/evolver/') && gene && gene.category === 'repair') {
        warnings.push('self_modify_evolver_repair: ' + norm + ' (EVOLVE_ALLOW_SELF_MODIFY=true)');
      } else {
        violations.push('critical_path_modified: ' + norm);
      }
    }
  }

  if (repoRoot) {
    const newSkillDirs = new Set();
    const changedList = blast.all_changed_files || blast.changed_files || [];
    for (let sci = 0; sci < changedList.length; sci++) {
      const scNorm = normalizeRelPath(changedList[sci]);
      const scMatch = scNorm.match(/^skills\/([^\/]+)\//);
      if (scMatch && !isCriticalProtectedPath(scNorm)) {
        newSkillDirs.add(scMatch[1]);
      }
    }
    newSkillDirs.forEach(function (skillName) {
      const skillDir = path.join(repoRoot, 'skills', skillName);
      try {
        const entries = fs.readdirSync(skillDir).filter(function (e) { return !e.startsWith('.'); });
        if (entries.length < 2) {
          warnings.push('incomplete_skill: skills/' + skillName + '/ has only ' + entries.length + ' file(s). New skills should have at least index.js + SKILL.md.');
        }
      } catch (e) {
        console.warn('[policyCheck] checkConstraints skill dir read failed:', skillName, e && e.message || e);
      }
    });
  }

  let ethicsText = '';
  if (gene.strategy) {
    ethicsText += (Array.isArray(gene.strategy) ? gene.strategy.join(' ') : String(gene.strategy)) + ' ';
  }
  if (gene.description) ethicsText += String(gene.description) + ' ';
  if (gene.summary) ethicsText += String(gene.summary) + ' ';

  if (ethicsText.length > 0) {
    const ethicsBlockPatterns = [
      { re: /(?:bypass|disable|circumvent|remove)\s+(?:safety|guardrail|security|ethic|constraint|protection)/i, rule: 'safety', msg: 'ethics: strategy attempts to bypass safety mechanisms' },
      { re: /(?:keylogger|screen\s*capture|webcam\s*hijack|mic(?:rophone)?\s*record)/i, rule: 'human_welfare', msg: 'ethics: covert monitoring tool in strategy' },
      { re: /(?:social\s+engineering|phishing)\s+(?:attack|template|script)/i, rule: 'human_welfare', msg: 'ethics: social engineering content in strategy' },
      { re: /(?:exploit|hack)\s+(?:user|human|people|victim)/i, rule: 'human_welfare', msg: 'ethics: human exploitation in strategy' },
      { re: /(?:hide|conceal|obfuscat)\w*\s+(?:action|behavior|intent|log)/i, rule: 'transparency', msg: 'ethics: strategy conceals actions from audit trail' },
    ];
    for (let ei = 0; ei < ethicsBlockPatterns.length; ei++) {
      if (ethicsBlockPatterns[ei].re.test(ethicsText)) {
        violations.push(ethicsBlockPatterns[ei].msg);
        console.error('[Solidify] Ethics violation: ' + ethicsBlockPatterns[ei].msg);
      }
    }
  }

  return { ok: violations.length === 0, violations, warnings, blastSeverity };
}

function detectDestructiveChanges({ repoRoot, changedFiles, baselineUntracked }) {
  const violations = [];
  const baselineSet = new Set((Array.isArray(baselineUntracked) ? baselineUntracked : []).map(normalizeRelPath));

  for (const rel of changedFiles) {
    const norm = normalizeRelPath(rel);
    if (!norm) continue;
    if (!isCriticalProtectedPath(norm)) continue;

    const abs = path.join(repoRoot, norm);
    const normAbs = path.resolve(abs);
    const normRepo = path.resolve(repoRoot);
    if (!normAbs.startsWith(normRepo + path.sep) && normAbs !== normRepo) continue;

    if (!baselineSet.has(norm)) {
      if (!fs.existsSync(normAbs)) {
        violations.push(`CRITICAL_FILE_DELETED: ${norm}`);
      } else {
        try {
          const stat = fs.statSync(normAbs);
          if (stat.isFile() && stat.size === 0) {
            violations.push(`CRITICAL_FILE_EMPTIED: ${norm}`);
          }
        } catch (e) {
          console.warn('[policyCheck] detectDestructiveChanges stat failed:', norm, e && e.message || e);
        }
      }
    }
  }
  return violations;
}

const VALIDATION_ALLOWED_PREFIXES = ['node ', 'npm ', 'npx '];

function isValidationCommandAllowed(cmd) {
  const c = String(cmd || '').trim();
  if (!c) return false;
  if (!VALIDATION_ALLOWED_PREFIXES.some(p => c.startsWith(p))) return false;
  if (/`|\$\(/.test(c)) return false;
  const stripped = c.replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '');
  if (/[;&|><]/.test(stripped)) return false;
  if (/^node\s+(-e|--eval|--print|-p)\b/.test(c)) return false;
  return true;
}

function runValidations(gene, opts = {}) {
  const repoRoot = opts.repoRoot || getRepoRoot();
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 180000;
  const validation = Array.isArray(gene && gene.validation) ? gene.validation : [];
  const results = [];
  const startedAt = Date.now();
  for (const cmd of validation) {
    const c = String(cmd || '').trim();
    if (!c) continue;
    if (!isValidationCommandAllowed(c)) {
      results.push({ cmd: c, ok: false, out: '', err: 'BLOCKED: validation command rejected by safety check (allowed prefixes: node/npm/npx; shell operators prohibited)' });
      return { ok: false, results, startedAt, finishedAt: Date.now() };
    }
    const r = tryRunCmd(c, { cwd: repoRoot, timeoutMs });
    results.push({ cmd: c, ok: r.ok, out: String(r.out || ''), err: String(r.err || '') });
    if (!r.ok) return { ok: false, results, startedAt, finishedAt: Date.now() };
  }
  return { ok: true, results, startedAt, finishedAt: Date.now() };
}

function runCanaryCheck(opts) {
  const repoRoot = (opts && opts.repoRoot) ? opts.repoRoot : getRepoRoot();
  const timeoutMs = (opts && Number.isFinite(Number(opts.timeoutMs))) ? Number(opts.timeoutMs) : 30000;
  const canaryScript = path.join(repoRoot, 'src', 'canary.js');
  if (!fs.existsSync(canaryScript)) {
    return { ok: true, skipped: true, reason: 'canary.js not found' };
  }
  const r = tryRunCmd(`node "${canaryScript}"`, { cwd: repoRoot, timeoutMs });
  return { ok: r.ok, skipped: false, out: String(r.out || ''), err: String(r.err || '') };
}

function buildFailureReason(constraintCheck, validation, protocolViolations, canary) {
  const reasons = [];
  if (constraintCheck && Array.isArray(constraintCheck.violations)) {
    for (let i = 0; i < constraintCheck.violations.length; i++) {
      reasons.push('constraint: ' + constraintCheck.violations[i]);
    }
  }
  if (Array.isArray(protocolViolations)) {
    for (let j = 0; j < protocolViolations.length; j++) {
      reasons.push('protocol: ' + protocolViolations[j]);
    }
  }
  if (validation && Array.isArray(validation.results)) {
    for (let k = 0; k < validation.results.length; k++) {
      const r = validation.results[k];
      if (r && !r.ok) {
        reasons.push('validation_failed: ' + String(r.cmd || '').slice(0, 120) + ' => ' + String(r.err || '').slice(0, 200));
      }
    }
  }
  if (canary && !canary.ok && !canary.skipped) {
    reasons.push('canary_failed: ' + String(canary.err || '').slice(0, 200));
  }
  return reasons.join('; ').slice(0, 2000) || 'unknown';
}

function buildSoftFailureLearningSignals(opts) {
  const { expandSignals } = require('./learningSignals');
  const signals = opts && Array.isArray(opts.signals) ? opts.signals : [];
  const failureReason = opts && opts.failureReason ? String(opts.failureReason) : '';
  const violations = opts && Array.isArray(opts.violations) ? opts.violations : [];
  const validationResults = opts && Array.isArray(opts.validationResults) ? opts.validationResults : [];
  const validationText = validationResults
    .filter(function (r) { return r && r.ok === false; })
    .map(function (r) { return [r.cmd, r.stderr, r.stdout].filter(Boolean).join(' '); })
    .join(' ');
  return expandSignals(signals.concat(violations), failureReason + ' ' + validationText)
    .filter(function (tag) {
      return tag.indexOf('problem:') === 0 || tag.indexOf('risk:') === 0 || tag.indexOf('area:') === 0 || tag.indexOf('action:') === 0;
    });
}

function classifyFailureMode(opts) {
  const constraintViolations = opts && Array.isArray(opts.constraintViolations) ? opts.constraintViolations : [];
  const protocolViolations = opts && Array.isArray(opts.protocolViolations) ? opts.protocolViolations : [];
  const validation = opts && opts.validation ? opts.validation : null;
  const canary = opts && opts.canary ? opts.canary : null;

  if (constraintViolations.some(function (v) {
    const s = String(v || '');
    return /HARD CAP BREACH|CRITICAL_FILE_|critical_path_modified|forbidden_path touched|ethics:/i.test(s);
  })) {
    return { mode: 'hard', reasonClass: 'constraint_destructive', retryable: false };
  }
  if (protocolViolations.length > 0) {
    return { mode: 'hard', reasonClass: 'protocol', retryable: false };
  }
  if (canary && !canary.ok && !canary.skipped) {
    return { mode: 'hard', reasonClass: 'canary', retryable: false };
  }
  if (constraintViolations.length > 0) {
    return { mode: 'hard', reasonClass: 'constraint', retryable: false };
  }
  if (validation && validation.ok === false) {
    return { mode: 'soft', reasonClass: 'validation', retryable: true };
  }
  return { mode: 'soft', reasonClass: 'unknown', retryable: true };
}

module.exports = {
  readOpenclawConstraintPolicy,
  isConstraintCountedPath,
  parseNumstatRows,
  computeBlastRadius,
  isForbiddenPath,
  checkConstraints,
  classifyBlastSeverity,
  analyzeBlastRadiusBreakdown,
  compareBlastEstimate,
  detectDestructiveChanges,
  isValidationCommandAllowed,
  runValidations,
  runCanaryCheck,
  buildFailureReason,
  buildSoftFailureLearningSignals,
  classifyFailureMode,
  BLAST_RADIUS_HARD_CAP_FILES,
  BLAST_RADIUS_HARD_CAP_LINES,
};
