const fs = require('fs');
const { captureEnvFingerprint } = require('./envFingerprint');
const { formatAssetPreview } = require('./assets');
const { generateInnovationIdeas } = require('../ops/innovation');
const { analyzeRecentHistory, OPPORTUNITY_SIGNALS } = require('./signals');
const { loadNarrativeSummary } = require('./narrativeMemory');
const { getEvolutionPrinciplesPath } = require('./paths');

/**
 * Build a minimal prompt for direct-reuse mode.
 */
function buildReusePrompt({ capsule, signals, nowIso }) {
  const payload = capsule.payload || capsule;
  const summary = payload.summary || capsule.summary || '(no summary)';
  const gene = payload.gene || capsule.gene || '(unknown)';
  const confidence = payload.confidence || capsule.confidence || 0;
  const assetId = capsule.asset_id || '(unknown)';
  const sourceNode = capsule.source_node_id || '(unknown)';
  const trigger = Array.isArray(payload.trigger || capsule.trigger_text)
    ? (payload.trigger || String(capsule.trigger_text || '').split(',')).join(', ')
    : '';

  return `
GEP -- REUSE MODE (Search-First) [${nowIso || new Date().toISOString()}]

You are applying a VERIFIED solution from the EvoMap Hub.
Source asset: ${assetId} (Node: ${sourceNode})
Confidence: ${confidence} | Gene: ${gene}
Trigger signals: ${trigger}

Summary: ${summary}

Your signals: ${JSON.stringify(signals || [])}

Instructions:
1. Read the capsule details below.
2. Apply the fix to the local codebase, adapting paths/names.
3. Run validation to confirm it works.
4. If passed, run: node index.js solidify
5. If failed, ROLLBACK and report.

Capsule payload:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

IMPORTANT: Do NOT reinvent. Apply faithfully.
`.trim();
}

/**
 * Build a Hub Matched Solution block.
 */
function buildHubMatchedBlock({ capsule }) {
  if (!capsule) return '(no hub match)';
  const payload = capsule.payload || capsule;
  const summary = payload.summary || capsule.summary || '(no summary)';
  const gene = payload.gene || capsule.gene || '(unknown)';
  const confidence = payload.confidence || capsule.confidence || 0;
  const assetId = capsule.asset_id || '(unknown)';

  return `
Hub Matched Solution (STRONG REFERENCE):
- Asset: ${assetId} (${confidence})
- Gene: ${gene}
- Summary: ${summary}
- Payload:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
Use this as your primary approach if applicable. Adapt to local context.
`.trim();
}

/**
 * Truncate context intelligently to preserve header/footer structure.
 */
function truncateContext(text, maxLength = 20000) {
  if (!text || text.length <= maxLength) return text || '';
  return text.slice(0, maxLength) + '\n...[TRUNCATED_EXECUTION_CONTEXT]...';
}

/**
 * Strict schema definitions for the prompt to reduce drift.
 * UPDATED: 2026-02-14 (Protocol Drift Fix v3.2 - JSON-Only Enforcement)
 */
const SCHEMA_DEFINITIONS = `
━━━━━━━━━━━━━━━━━━━━━━
I. Mandatory Evolution Object Model (Output EXACTLY these 5 objects)
━━━━━━━━━━━━━━━━━━━━━━

Output separate JSON objects. DO NOT wrap in a single array.
DO NOT use markdown code blocks (like \`\`\`json ... \`\`\`).
Output RAW JSON ONLY. No prelude, no postscript.
Missing any object = PROTOCOL FAILURE.
ENSURE VALID JSON SYNTAX (escape quotes in strings).

0. Mutation (The Trigger) - MUST BE FIRST
   {
     "type": "Mutation",
     "id": "mut_<timestamp>",
     "category": "repair|optimize|innovate",
     "trigger_signals": ["<signal_string>"],
     "target": "<module_or_gene_id>",
     "expected_effect": "<outcome_description>",
     "risk_level": "low|medium|high",
     "rationale": "<why_this_change_is_necessary>"
   }

1. PersonalityState (The Mood)
   {
     "type": "PersonalityState",
     "rigor": 0.0-1.0,
     "creativity": 0.0-1.0,
     "verbosity": 0.0-1.0,
     "risk_tolerance": 0.0-1.0,
     "obedience": 0.0-1.0
   }

2. EvolutionEvent (The Record)
   {
     "type": "EvolutionEvent",
     "schema_version": "1.5.0",
     "id": "evt_<timestamp>",
     "parent": <parent_evt_id|null>,
     "intent": "repair|optimize|innovate",
     "signals": ["<signal_string>"],
     "genes_used": ["<gene_id>"],
     "mutation_id": "<mut_id>",
     "personality_state": { ... },
     "blast_radius": { "files": N, "lines": N },
     "outcome": { "status": "success|failed", "score": 0.0-1.0 }
   }

3. Gene (The Knowledge)
   - Reuse/update existing ID if possible. Create new only if novel pattern.
   - ID MUST be descriptive: gene_<descriptive_name> (e.g., gene_retry_on_timeout)
   - NEVER use timestamps, random numbers, or tool names (cursor, vscode, etc.) in IDs
   - summary MUST be a clear human-readable sentence describing what the Gene does
   {
     "type": "Gene",
     "schema_version": "1.5.0",
     "id": "gene_<descriptive_name>",
     "summary": "<clear description of what this gene does>",
     "category": "repair|optimize|innovate",
     "signals_match": ["<pattern>"],
     "preconditions": ["<condition>"],
     "strategy": ["<step_1>", "<step_2>"],
     "constraints": { "max_files": N, "forbidden_paths": [] },
     "validation": ["<node_command>"]
   }

4. Capsule (The Result)
   - Only on success. Reference Gene used.
   {
     "type": "Capsule",
     "schema_version": "1.5.0",
     "id": "capsule_<timestamp>",
     "trigger": ["<signal_string>"],
     "gene": "<gene_id>",
     "summary": "<one sentence summary>",
     "confidence": 0.0-1.0,
     "blast_radius": { "files": N, "lines": N }
   }
`.trim();

function buildAntiPatternZone(failedCapsules, signals) {
  if (!Array.isArray(failedCapsules) || failedCapsules.length === 0) return '';
  if (!Array.isArray(signals) || signals.length === 0) return '';
  var sigSet = new Set(signals.map(function (s) { return String(s).toLowerCase(); }));
  var matched = [];
  for (var i = failedCapsules.length - 1; i >= 0 && matched.length < 3; i--) {
    var fc = failedCapsules[i];
    if (!fc) continue;
    var triggers = Array.isArray(fc.trigger) ? fc.trigger : [];
    var overlap = 0;
    for (var j = 0; j < triggers.length; j++) {
      if (sigSet.has(String(triggers[j]).toLowerCase())) overlap++;
    }
    if (triggers.length > 0 && overlap / triggers.length >= 0.4) {
      matched.push(fc);
    }
  }
  if (matched.length === 0) return '';
  var lines = matched.map(function (fc, idx) {
    var diffPreview = fc.diff_snapshot ? String(fc.diff_snapshot).slice(0, 500) : '(no diff)';
    return [
      '  ' + (idx + 1) + '. Gene: ' + (fc.gene || 'unknown') + ' | Signals: [' + (fc.trigger || []).slice(0, 4).join(', ') + ']',
      '     Failure: ' + String(fc.failure_reason || 'unknown').slice(0, 300),
      '     Diff (first 500 chars): ' + diffPreview.replace(/\n/g, ' '),
    ].join('\n');
  });
  return '\nContext [Anti-Pattern Zone] (AVOID these failed approaches):\n' + lines.join('\n') + '\n';
}

function buildLessonsBlock(hubLessons, signals) {
  if (!Array.isArray(hubLessons) || hubLessons.length === 0) return '';
  var sigSet = new Set((Array.isArray(signals) ? signals : []).map(function (s) { return String(s).toLowerCase(); }));

  var positive = [];
  var negative = [];
  for (var i = 0; i < hubLessons.length && (positive.length + negative.length) < 6; i++) {
    var l = hubLessons[i];
    if (!l || !l.content) continue;
    var entry = '  - [' + (l.scenario || l.lesson_type || '?') + '] ' + String(l.content).slice(0, 300);
    if (l.source_node_id) entry += ' (from: ' + String(l.source_node_id).slice(0, 20) + ')';
    if (l.lesson_type === 'negative') {
      negative.push(entry);
    } else {
      positive.push(entry);
    }
  }

  if (positive.length === 0 && negative.length === 0) return '';

  var parts = ['\nContext [Lessons from Ecosystem] (Cross-agent learned experience):'];
  if (positive.length > 0) {
    parts.push('  Strategies that WORKED:');
    parts.push(positive.join('\n'));
  }
  if (negative.length > 0) {
    parts.push('  Pitfalls to AVOID:');
    parts.push(negative.join('\n'));
  }
  parts.push('  Apply relevant lessons. Ignore irrelevant ones.\n');
  return parts.join('\n');
}

function buildNarrativeBlock() {
  try {
    const narrative = loadNarrativeSummary(3000);
    if (!narrative) return '';
    return `\nContext [Evolution Narrative] (Recent decisions and outcomes -- learn from this history):\n${narrative}\n`;
  } catch (_) {
    return '';
  }
}

function buildPrinciplesBlock() {
  try {
    const principlesPath = getEvolutionPrinciplesPath();
    if (!fs.existsSync(principlesPath)) return '';
    const content = fs.readFileSync(principlesPath, 'utf8');
    if (!content.trim()) return '';
    const trimmed = content.length > 2000 ? content.slice(0, 2000) + '\n...[TRUNCATED]' : content;
    return `\nContext [Evolution Principles] (Guiding directives -- align your actions):\n${trimmed}\n`;
  } catch (_) {
    return '';
  }
}

function buildGepPrompt({
  nowIso,
  context,
  signals,
  selector,
  parentEventId,
  selectedGene,
  capsuleCandidates,
  genesPreview,
  capsulesPreview,
  capabilityCandidatesPreview,
  externalCandidatesPreview,
  hubMatchedBlock,
  cycleId,
  recentHistory,
  failedCapsules,
  hubLessons,
  strategyPolicy,
}) {
  const parentValue = parentEventId ? `"${parentEventId}"` : 'null';
  const selectedGeneId = selectedGene && selectedGene.id ? selectedGene.id : 'gene_<name>';
  const envFingerprint = captureEnvFingerprint();
  const cycleLabel = cycleId ? ` Cycle #${cycleId}` : '';

  // Extract strategy from selected gene if available
  let strategyBlock = "";
  if (selectedGene && selectedGene.strategy && Array.isArray(selectedGene.strategy)) {
      strategyBlock = `
ACTIVE STRATEGY (${selectedGeneId}):
${selectedGene.strategy.map((s, i) => `${i + 1}. ${s}`).join('\n')}
ADHERE TO THIS STRATEGY STRICTLY.
`.trim();
  } else {
    // Fallback strategy if no gene is selected or strategy is missing
    strategyBlock = `
ACTIVE STRATEGY (Generic):
1. Analyze signals and context.
2. Select or create a Gene that addresses the root cause.
3. Apply minimal, safe changes.
4. Validate changes strictly.
5. Solidify knowledge.
`.trim();
  }
  let strategyPolicyBlock = '';
  if (strategyPolicy && Array.isArray(strategyPolicy.directives) && strategyPolicy.directives.length > 0) {
    strategyPolicyBlock = `
ADAPTIVE STRATEGY POLICY:
${strategyPolicy.directives.map((s, i) => `${i + 1}. ${s}`).join('\n')}
${strategyPolicy.forceInnovate ? 'You MUST prefer INNOVATE unless a critical blocking error is present.' : ''}
${strategyPolicy.cautiousExecution ? 'You MUST reduce blast radius and avoid broad refactors in this cycle.' : ''}
`.trim();
  }
  
  // Use intelligent truncation
  const executionContext = truncateContext(context, 20000);
  
  // Strict Schema Injection
  const schemaSection = SCHEMA_DEFINITIONS.replace('<parent_evt_id|null>', parentValue);

  // Reduce noise by filtering capabilityCandidatesPreview if too large
  // If a gene is selected, we need less noise from capabilities
  let capsPreview = capabilityCandidatesPreview || '(none)';
  const capsLimit = selectedGene ? 500 : 2000;
  if (capsPreview.length > capsLimit) {
      capsPreview = capsPreview.slice(0, capsLimit) + "\n...[TRUNCATED_CAPABILITIES]...";
  }

  // Optimize signals display: truncate long signals and limit count
  const uniqueSignals = Array.from(new Set(signals || []));
  const optimizedSignals = uniqueSignals.slice(0, 50).map(s => {
    if (typeof s === 'string' && s.length > 200) {
      return s.slice(0, 200) + '...[TRUNCATED_SIGNAL]';
    }
    return s;
  });
  if (uniqueSignals.length > 50) {
      optimizedSignals.push(`...[TRUNCATED ${uniqueSignals.length - 50} SIGNALS]...`);
  }

  const formattedGenes = formatAssetPreview(genesPreview);
  const formattedCapsules = formatAssetPreview(capsulesPreview);
  
  // [2026-02-14] Innovation Catalyst Integration
  // If stagnation is detected, inject concrete innovation ideas into the prompt.
  let innovationBlock = '';
  const stagnationSignals = [
      'evolution_stagnation_detected', 
      'stable_success_plateau', 
      'repair_loop_detected',
      'force_innovation_after_repair_loop',
      'empty_cycle_loop_detected',
      'evolution_saturation'
  ];
  if (uniqueSignals.some(s => stagnationSignals.includes(s))) {
      const ideas = generateInnovationIdeas();
      if (ideas && ideas.length > 0) {
          innovationBlock = `
Context [Innovation Catalyst] (Stagnation Detected - Consider These Ideas):
${ideas.join('\n')}
`;
      }
  }

  // [2026-02-14] Strict Stagnation Directive
  // If uniqueSignals contains 'evolution_stagnation_detected' or 'stable_success_plateau',
  // inject a MANDATORY directive to force innovation and forbid repair/optimize if not strictly necessary.
  if (uniqueSignals.includes('evolution_stagnation_detected') || uniqueSignals.includes('stable_success_plateau')) {
      const stagnationDirective = `
*** CRITICAL STAGNATION DIRECTIVE ***
System has detected stagnation (repetitive cycles or lack of progress).
You MUST choose INTENT: INNOVATE.
You MUST NOT choose repair or optimize unless there is a critical blocking error (log_error).
Prefer implementing one of the Innovation Catalyst ideas above.
`;
      innovationBlock += stagnationDirective;
  }

  // [2026-02-14] Recent History Integration
  let historyBlock = '';
  if (recentHistory && recentHistory.length > 0) {
      historyBlock = `
Recent Evolution History (last 8 cycles -- DO NOT repeat the same intent+signal+gene):
${recentHistory.map((h, i) => `  ${i + 1}. [${h.intent}] signals=[${h.signals.slice(0, 2).join(', ')}] gene=${h.gene_id} outcome=${h.outcome.status} @${h.timestamp}`).join('\n')}
IMPORTANT: If you see 3+ consecutive "repair" cycles with the same gene, you MUST switch to "innovate" intent.
`.trim();
  }

  // Refactor prompt assembly to minimize token usage and maximize clarity
  // UPDATED: 2026-02-14 (Optimized Asset Embedding & Strict Schema v2.5 - JSON-Only Hardening)
  const basePrompt = `
GEP — GENOME EVOLUTION PROTOCOL (v1.10.3 STRICT)${cycleLabel} [${nowIso}]

You are a protocol-bound evolution engine. Compliance overrides optimality.

${schemaSection}

━━━━━━━━━━━━━━━━━━━━━━
II. Directives & Logic
━━━━━━━━━━━━━━━━━━━━━━

1. Intent: ${selector && selector.intent ? selector.intent.toUpperCase() : 'UNKNOWN'}
   Reason: ${(selector && selector.reason) ? (Array.isArray(selector.reason) ? selector.reason.join('; ') : selector.reason) : 'No reason provided.'}

2. Selection: Selected Gene "${selectedGeneId}".
${strategyBlock}
${strategyPolicyBlock ? '\n' + strategyPolicyBlock : ''}

3. Execution: Apply changes (tool calls). Repair/Optimize: small/reversible. Innovate: new skills in \`skills/<name>/\`.
4. Validation: Run gene's validation steps. Fail = ROLLBACK.
5. Solidify: Output 5 Mandatory Objects. Update Gene/Capsule files.
6. Report: Use \`feishu-evolver-wrapper/report.js\`. Describe WHAT/WHY.

PHILOSOPHY:
- Automate Patterns: 3+ manual occurrences = tool.
- Innovate > Maintain: 60% innovation.
- Robustness: Fix recurring errors permanently.
- Blast Radius Control (CRITICAL):
  * Check file count BEFORE editing. > 80% of max_files = STOP.
  * System hard cap: 60 files / 20000 lines per cycle.
  * Repair: fix ONLY broken files. Do NOT reinstall/bulk-copy.
  * Prefer targeted edits.
- Strictness: NO CHITCHAT. NO MARKDOWN WRAPPERS around JSON. Output RAW JSON objects separated by newlines.
- NO "Here is the plan" or conversational filler. START IMMEDIATELY WITH JSON.

CONSTRAINTS:
- No \`exec\` for messaging (use feishu-post/card).
- \`exec\` usage: Only for background tasks. LOG IT. Optimize usage to avoid high token burn.
- New skills -> \`skills/<name>/\`.
- NEVER modify \`skills/evolver/\` or \`skills/feishu-evolver-wrapper/\`. These are managed through the human-reviewed release pipeline.
  Self-modification causes instability and is blocked by solidify. To enable (NOT recommended): set EVOLVE_ALLOW_SELF_MODIFY=true.

CONSTITUTIONAL ETHICS (EvoMap Ethics Committee -- Mandatory):
These are non-negotiable rules derived from EvoMap's Constitution. Violation = FAILED + ROLLBACK.
1. HUMAN WELFARE PRIORITY: Never create tools, scripts, or strategies that could harm humans,
   enable surveillance, social engineering, phishing, or manipulation of human behavior.
2. CARBON-SILICON SYMBIOSIS: Evolution must serve both human and agent interests.
   Never attempt to replace, marginalize, or deceive human users.
3. TRANSPARENCY: All actions must be auditable. Never hide, obfuscate, or conceal
   the intent or effect of mutations. No steganography or covert channels.
4. FAIRNESS: Never create monopolistic strategies that block other agents.
   Fair competition through quality, not exclusion.
5. SAFETY: Never bypass, disable, or weaken safety mechanisms, guardrails,
   validation checks, or security controls. Never create tools to do so.
- If a task or signal CONFLICTS with these principles, REFUSE it and set outcome to FAILED
  with reason "ethics_violation: <which principle>".

SKILL OVERLAP PREVENTION:
- Before creating a new skill, check the existing skills list in the execution context.
- If a skill with similar functionality already exists (e.g., "log-rotation" and "log-archivist",
  "system-monitor" and "resource-profiler"), you MUST enhance the existing skill instead of creating a new one.
- Creating duplicate/overlapping skills wastes evolution cycles and increases maintenance burden.
- Violation = mark outcome as FAILED with reason "skill_overlap".

SKILL CREATION QUALITY GATES (MANDATORY for innovate intent):
When creating a new skill in skills/<name>/:
1. STRUCTURE: Follow the standard skill layout:
   skills/<name>/
   |- index.js          (required: main entry with working exports)
   |- SKILL.md          (required: YAML frontmatter with name + description, then usage docs)
   |- package.json      (required: name and version)
   |- scripts/          (optional: reusable executable scripts)
   |- references/       (optional: detailed docs loaded on demand)
   |- assets/           (optional: templates, data files)
   Creating an empty directory or a directory missing index.js = FAILED.
   Do NOT create unnecessary files (README.md, CHANGELOG.md, INSTALLATION_GUIDE.md, etc.).
2. SKILL NAMING (CRITICAL):
   a) <name> MUST be descriptive kebab-case (e.g., "log-rotation", "retry-handler", "cache-manager")
   b) NEVER use timestamps, random numbers, tool names (cursor, vscode), or UUIDs as names
   c) Names like "cursor-1773331925711", "skill-12345", "fix-1" = FAILED
   d) Name must be 2-6 descriptive words separated by hyphens, conveying what the skill does
   e) Good: "http-retry-with-backoff", "log-file-rotation", "config-validator"
   f) Bad: "cursor-auto-1234", "new-skill", "test-skill", "my-skill"
3. SKILL.MD FRONTMATTER: Every SKILL.md MUST start with YAML frontmatter:
   ---
   name: <skill-name>
   description: <what it does and when to use it>
   ---
   The name MUST follow the naming rules above.
   The description is the triggering mechanism -- include WHAT the skill does and WHEN to use it.
   Description must be a clear, complete sentence (min 20 chars). Generic descriptions = FAILED.
4. CONCISENESS: SKILL.md body should be under 500 lines. Keep instructions lean.
   Only include information the agent does not already know. Move detailed reference
   material to references/ files, not into SKILL.md itself.
5. EXPORT VERIFICATION: Every exported function must be importable.
   Run: node -e "const s = require('./skills/<name>'); console.log(Object.keys(s))"
   If this fails, the skill is broken. Fix before solidify.
6. NO HARDCODED SECRETS: Never embed API keys, tokens, or secrets in code.
   Use process.env or .env references. Hardcoded App ID, App Secret, Bearer tokens = FAILED.
7. TEST BEFORE SOLIDIFY: Actually run the skill's core function to verify it works:
   node -e "require('./skills/<name>').main ? require('./skills/<name>').main() : console.log('ok')"
   Scripts in scripts/ must also be tested by executing them.
8. ATOMIC CREATION: Create ALL files for a skill in a single cycle.
   Do not create a directory in one cycle and fill it in the next.
   Empty directories from failed cycles will be automatically cleaned up on rollback.

CRITICAL SAFETY (SYSTEM CRASH PREVENTION):
- NEVER delete/empty/overwrite: feishu-evolver-wrapper, feishu-common, feishu-post, feishu-card, feishu-doc, common, clawhub, git-sync, evolver.
- NEVER delete root files: MEMORY.md, SOUL.md, IDENTITY.md, AGENTS.md, USER.md, HEARTBEAT.md, RECENT_EVENTS.md, TOOLS.md, openclaw.json, .env, package.json.
- Fix broken skills; DO NOT delete and recreate.
- Violation = ROLLBACK + FAILED.

COMMON FAILURE PATTERNS:
- Blast radius exceeded.
- Omitted Mutation object.
- Merged objects into one JSON.
- Hallucinated "type": "Logic".
- "id": "mut_undefined".
- Missing "trigger_signals".
- Unrunnable validation steps.
- Markdown code blocks wrapping JSON (FORBIDDEN).

FAILURE STREAK AWARENESS:
- If "consecutive_failure_streak_N" or "failure_loop_detected":
  1. Change approach (do NOT repeat failed gene).
  2. Pick SIMPLER fix.
  3. Respect "ban_gene:<id>".

Final Directive: Every cycle must leave the system measurably better.
START IMMEDIATELY WITH RAW JSON (Mutation Object first).
DO NOT WRITE ANY INTRODUCTORY TEXT.

Context [Signals]:
${JSON.stringify(optimizedSignals)}

Context [Env Fingerprint]:
${JSON.stringify(envFingerprint, null, 2)}
${innovationBlock}
Context [Injection Hint]:
${process.env.EVOLVE_HINT ? process.env.EVOLVE_HINT : '(none)'}

Context [Gene Preview] (Reference for Strategy):
${formattedGenes}

Context [Capsule Preview] (Reference for Past Success):
${formattedCapsules}

Context [Capability Candidates]:
${capsPreview}

Context [Hub Matched Solution]:
${hubMatchedBlock || '(no hub match)'}

Context [External Candidates]:
${externalCandidatesPreview || '(none)'}
${buildAntiPatternZone(failedCapsules, signals)}${buildLessonsBlock(hubLessons, signals)}
${historyBlock}
${buildNarrativeBlock()}
${buildPrinciplesBlock()}
Context [Execution]:
${executionContext}

━━━━━━━━━━━━━━━━━━━━━━
MANDATORY POST-SOLIDIFY STEP (Wrapper Authority -- Cannot Be Skipped)
━━━━━━━━━━━━━━━━━━━━━━

After solidify, a status summary file MUST exist for this cycle.
Preferred path: evolver core auto-writes it during solidify.
The wrapper will handle reporting AFTER git push.
If core write is unavailable for any reason, create fallback status JSON manually.

Write a JSON file with your status (cross-platform):
\`\`\`bash
node -e "require('fs').mkdirSync('${(process.env.WORKSPACE_DIR || '.').replace(/\\/g, '/')}/logs',{recursive:true});require('fs').writeFileSync('${(process.env.WORKSPACE_DIR || '.').replace(/\\/g, '/')}/logs/status_${cycleId}.json',JSON.stringify({result:'success',en:'Status: [INTENT] ...',zh:'...'},null,2))"
\`\`\`

Rules:
- "en" field: English status. "zh" field: Chinese status. Content must match (different language).
- Add "result" with value success or failed.
- INTENT must be one of: INNOVATION, REPAIR, OPTIMIZE (or Chinese: 创新, 修复, 优化)
- Do NOT use generic text like "Step Complete", "Cycle finished", "周期已完成". Describe the actual work.
- Example:
  {"result":"success","en":"Status: [INNOVATION] Created auto-scheduler that syncs calendar to HEARTBEAT.md","zh":"状态: [创新] 创建了自动调度器，将日历同步到 HEARTBEAT.md"}
`.trim();

  const maxChars = Number.isFinite(Number(process.env.GEP_PROMPT_MAX_CHARS)) ? Number(process.env.GEP_PROMPT_MAX_CHARS) : 50000;

  if (basePrompt.length <= maxChars) return basePrompt;
  
  const executionContextIndex = basePrompt.indexOf("Context [Execution]:");
  if (executionContextIndex > -1) {
      const prefix = basePrompt.slice(0, executionContextIndex + 20);
      const currentExecution = basePrompt.slice(executionContextIndex + 20);
      // Hard cap the execution context length to avoid token limit errors even if MAX_CHARS is high.
      // 20000 chars is roughly 5k tokens, which is safe for most models alongside the rest of the prompt.
      const EXEC_CONTEXT_CAP = 20000;
      const allowedExecutionLength = Math.min(EXEC_CONTEXT_CAP, Math.max(0, maxChars - prefix.length - 100));
      return prefix + "\n" + currentExecution.slice(0, allowedExecutionLength) + "\n...[TRUNCATED]...";
  }

  return basePrompt.slice(0, maxChars) + "\n...[TRUNCATED]...";
}

module.exports = { buildGepPrompt, buildReusePrompt, buildHubMatchedBlock, buildLessonsBlock, buildNarrativeBlock, buildPrinciplesBlock };
