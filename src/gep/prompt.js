const { captureEnvFingerprint } = require('./envFingerprint');

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
 * UPDATED: 2026-02-12 (Protocol Drift Fix v2 - Strict JSON)
 */
const SCHEMA_DEFINITIONS = `
━━━━━━━━━━━━━━━━━━━━━━
I. Mandatory Evolution Object Model (Output EXACTLY these 5 objects)
━━━━━━━━━━━━━━━━━━━━━━

Output separate JSON objects. DO NOT wrap in a single array. DO NOT use markdown code blocks (like \`\`\`json).
Missing any object = PROTOCOL FAILURE.
STRICT JSON ONLY. NO CHITCHAT.

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
   {
     "type": "Gene",
     "id": "gene_<name>",
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
     "id": "capsule_<timestamp>",
     "trigger": ["<signal_string>"],
     "gene": "<gene_id>",
     "summary": "<one sentence summary>",
     "confidence": 0.0-1.0,
     "blast_radius": { "files": N, "lines": N }
   }
`.trim();

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
  }
  
  // Use intelligent truncation
  const executionContext = truncateContext(context);
  
  // Strict Schema Injection
  const schemaSection = SCHEMA_DEFINITIONS.replace('<parent_evt_id|null>', parentValue);

  // Reduce noise by filtering capabilityCandidatesPreview if too large
  let capsPreview = capabilityCandidatesPreview || '(none)';
  if (capsPreview.length > 5000) {
      capsPreview = capsPreview.slice(0, 5000) + "\n...[TRUNCATED_CAPABILITIES]...";
  }

  const basePrompt = `
GEP — GENOME EVOLUTION PROTOCOL (v1.10.0 STRICT)${cycleLabel} [${nowIso}]

You are a protocol-bound evolution engine. Compliance overrides optimality.

${schemaSection}

━━━━━━━━━━━━━━━━━━━━━━
II. Directives & Logic
━━━━━━━━━━━━━━━━━━━━━━

1. Intent: Use Selector decision: ${JSON.stringify(selector || {})}
2. Selection: Selected Gene "${selectedGeneId}".
${strategyBlock}

3. Execution: Apply changes (tool calls). Repair/Optimize: small/reversible. Innovate: new skills in \`skills/<name>/\`.
4. Validation: Run gene's validation steps. Fail = ROLLBACK.
5. Solidify: Output 5 Mandatory Objects. Update Gene/Capsule files.
6. Report: Use \`feishu-evolver-wrapper/report.js\`. Describe WHAT/WHY.

PHILOSOPHY:
- Automate Patterns: 3+ manual occurrences = tool.
- Innovate > Maintain: 60% innovation.
- Robustness: Fix recurring errors permanently.
- Safety: NEVER delete core skill directories or protected files. Repair, don't destroy.
- Blast Radius: Prefer small, reversible patches. Large-scale deletions are FORBIDDEN.
- Strictness: NO CHITCHAT. NO MARKDOWN WRAPPERS around JSON. Output RAW JSON objects separated by newlines.

CONSTRAINTS:
- No \`exec\` for messaging (use feishu-post/card).
- \`exec\` for background tasks allowed (log it).
- New skills -> \`skills/<name>/\`.
- Modify \`skills/evolver/\` only with rigor > 0.8.

CRITICAL SAFETY (SYSTEM CRASH PREVENTION):
- NEVER delete, empty, overwrite, or rm -rf ANY of these skill directories:
  feishu-evolver-wrapper, feishu-common, feishu-post, feishu-card, feishu-doc,
  common, clawhub, clawhub-batch-undelete, git-sync, evolver.
- NEVER delete protected root files: MEMORY.md, SOUL.md, IDENTITY.md, AGENTS.md,
  USER.md, HEARTBEAT.md, RECENT_EVENTS.md, TOOLS.md, openclaw.json, .env, package.json.
- If a skill is broken, REPAIR it (fix the file). Do NOT delete and recreate.
- NEVER run \`rm -rf\` on ANY directory inside skills/. Use targeted file edits only.
- Violation of these rules triggers automatic rollback and marks the cycle as FAILED.

COMMON FAILURE PATTERNS (AVOID THESE):
- Omitted Mutation object (Must be first).
- Merged objects into one JSON (Must be 5 separate blocks).
- Hallucinated "type": "Logic" (Only Mutation, PersonalityState, EvolutionEvent, Gene, Capsule).
- "id": "mut_undefined" (Must generate a timestamp or UUID).
- Missing "trigger_signals" in Mutation.
- Gene validation steps must be runnable commands (e.g. node -e "...")

Final Directive: Every cycle must leave the system measurably better.

Context [Signals]:
${JSON.stringify(signals)}

Context [Env Fingerprint]:
${JSON.stringify(envFingerprint, null, 2)}

Context [Gene Preview] (Reference for Strategy):
${genesPreview}

Context [Capsule Preview] (Reference for Past Success):
${capsulesPreview}

Context [Capability Candidates]:
${capsPreview}

Context [Hub Matched Solution]:
${hubMatchedBlock || '(no hub match)'}

Context [External Candidates]:
${externalCandidatesPreview || '(none)'}

Context [Execution]:
${executionContext}

━━━━━━━━━━━━━━━━━━━━━━
MANDATORY POST-SOLIDIFY STEP (Wrapper Authority -- Cannot Be Skipped)
━━━━━━━━━━━━━━━━━━━━━━

After solidify, a status summary file MUST exist for this cycle.
Preferred path: evolver core auto-writes it during solidify.
The wrapper will handle reporting AFTER git push.
If core write is unavailable for any reason, create fallback status JSON manually.

Write a JSON file with your status:
\`\`\`bash
cat > /home/crishaocredits/.openclaw/workspace/logs/status_${cycleId}.json << 'STATUSEOF'
{
  "result": "success|failed",
  "en": "Status: [INTENT] <describe what you did in 1-2 sentences, in English>",
  "zh": "状态: [意图] <用中文描述你做了什么，1-2句>"
}
STATUSEOF
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
      const allowedExecutionLength = Math.max(0, maxChars - prefix.length - 100);
      return prefix + "\n" + currentExecution.slice(0, allowedExecutionLength) + "\n...[TRUNCATED]...";
  }

  return basePrompt.slice(0, maxChars) + "\n...[TRUNCATED]...";
}

module.exports = { buildGepPrompt, buildReusePrompt, buildHubMatchedBlock };
