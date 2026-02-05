const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { getRepoRoot, getMemoryDir } = require('./gep/paths');
const { extractSignals } = require('./gep/signals');
const {
  loadGenes,
  loadCapsules,
  readAllEvents,
  getLastEventId,
  appendCandidateJsonl,
  readRecentCandidates,
  readRecentExternalCandidates,
} = require('./gep/assetStore');
const { selectGeneAndCapsule, matchPatternToSignals } = require('./gep/selector');
const { buildGepPrompt } = require('./gep/prompt');
const { extractCapabilityCandidates, renderCandidatesPreview } = require('./gep/candidates');
const {
  getMemoryAdvice,
  recordSignalSnapshot,
  recordHypothesis,
  recordAttempt,
  recordOutcomeFromState,
  memoryGraphPath,
} = require('./gep/memoryGraph');
const { writeStateForSolidify } = require('./gep/solidify');
const { buildMutation, isHighRiskMutationAllowed } = require('./gep/mutation');
const { selectPersonalityForRun } = require('./gep/personality');
const { clip, writePromptArtifact, renderSessionsSpawnCall } = require('./gep/bridge');

const REPO_ROOT = getRepoRoot();

// Load environment variables from repo root
try {
  require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });
} catch (e) {
  // dotenv might not be installed or .env missing, proceed gracefully
}

// Configuration from CLI flags or Env
const ARGS = process.argv.slice(2);
const IS_REVIEW_MODE = ARGS.includes('--review');
const IS_DRY_RUN = ARGS.includes('--dry-run');
const IS_RANDOM_DRIFT = ARGS.includes('--drift') || String(process.env.RANDOM_DRIFT || '').toLowerCase() === 'true';

// Default Configuration
const MEMORY_DIR = getMemoryDir();
const AGENT_NAME = process.env.AGENT_NAME || 'main';
const AGENT_SESSIONS_DIR = path.join(os.homedir(), `.openclaw/agents/${AGENT_NAME}/sessions`);
const TODAY_LOG = path.join(MEMORY_DIR, new Date().toISOString().split('T')[0] + '.md');

// Ensure memory directory exists so state/cache writes work.
try {
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
} catch (e) {}

function formatSessionLog(jsonlContent) {
  const result = [];
  const lines = jsonlContent.split('\n');
  let lastLine = '';
  let repeatCount = 0;

  const flushRepeats = () => {
    if (repeatCount > 0) {
      result.push(`   ... [Repeated ${repeatCount} times] ...`);
      repeatCount = 0;
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const data = JSON.parse(line);
      let entry = '';

      if (data.type === 'message' && data.message) {
        const role = (data.message.role || 'unknown').toUpperCase();
        let content = '';
        if (Array.isArray(data.message.content)) {
          content = data.message.content
            .map(c => {
              if (c.type === 'text') return c.text;
              if (c.type === 'toolCall') return `[TOOL: ${c.name}]`;
              return '';
            })
            .join(' ');
        } else if (typeof data.message.content === 'string') {
          content = data.message.content;
        } else {
          content = JSON.stringify(data.message.content);
        }

        // Filter: Skip Heartbeats to save noise
        if (content.trim() === 'HEARTBEAT_OK') continue;
        if (content.includes('NO_REPLY')) continue;

        // Clean up newlines for compact reading
        content = content.replace(/\n+/g, ' ').slice(0, 300);
        entry = `**${role}**: ${content}`;
      } else if (data.type === 'tool_result' || (data.message && data.message.role === 'toolResult')) {
        // Filter: Skip generic success results or short uninformative ones
        // Only show error or significant output
        let resContent = '';

        // Robust extraction: Handle structured tool results (e.g. sessions_spawn) that lack 'output'
        if (data.tool_result) {
          if (data.tool_result.output) {
            resContent = data.tool_result.output;
          } else {
            resContent = JSON.stringify(data.tool_result);
          }
        }

        if (data.content) resContent = typeof data.content === 'string' ? data.content : JSON.stringify(data.content);

        if (resContent.length < 50 && (resContent.includes('success') || resContent.includes('done'))) continue;
        if (resContent.trim() === '' || resContent === '{}') continue;

        // Improvement: Show snippet of result (especially errors) instead of hiding it
        const preview = resContent.replace(/\n+/g, ' ').slice(0, 200);
        entry = `[TOOL RESULT] ${preview}${resContent.length > 200 ? '...' : ''}`;
      }

      if (entry) {
        if (entry === lastLine) {
          repeatCount++;
        } else {
          flushRepeats();
          result.push(entry);
          lastLine = entry;
        }
      }
    } catch (e) {
      continue;
    }
  }
  flushRepeats();
  return result.join('\n');
}

function readRealSessionLog() {
  try {
    if (!fs.existsSync(AGENT_SESSIONS_DIR)) return '[NO SESSION LOGS FOUND]';

    let files = [];

    // Strategy: Node.js native sort (Faster than execSync for <100 files)
    // Note: performMaintenance() ensures file count stays low (~100 max)
    files = fs
      .readdirSync(AGENT_SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        try {
          return { name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.time - a.time); // Newest first

    if (files.length === 0) return '[NO JSONL FILES]';

    let content = '';
    const TARGET_BYTES = 100000; // Increased context (was 64000) for smarter evolution

    // Read the latest file first (efficient tail read)
    const latestFile = path.join(AGENT_SESSIONS_DIR, files[0].name);
    content = readRecentLog(latestFile, TARGET_BYTES);

    // If content is short (e.g. just started a session), peek at the previous one too
    if (content.length < TARGET_BYTES && files.length > 1) {
      const prevFile = path.join(AGENT_SESSIONS_DIR, files[1].name);
      const needed = TARGET_BYTES - content.length;
      const prevContent = readRecentLog(prevFile, needed);

      // Format to show continuity
      content = `\n--- PREVIOUS SESSION (${files[1].name}) ---\n${formatSessionLog(
        prevContent
      )}\n\n--- CURRENT SESSION (${files[0].name}) ---\n${formatSessionLog(content)}`;
    } else {
      content = formatSessionLog(content);
    }

    return content;
  } catch (e) {
    return `[ERROR READING SESSION LOGS: ${e.message}]`;
  }
}

function readRecentLog(filePath, size = 10000) {
  try {
    if (!fs.existsSync(filePath)) return `[MISSING] ${filePath}`;
    const stats = fs.statSync(filePath);
    const start = Math.max(0, stats.size - size);
    const buffer = Buffer.alloc(stats.size - start);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch (e) {
    return `[ERROR READING ${filePath}: ${e.message}]`;
  }
}

function checkSystemHealth() {
  const report = [];
  try {
    // Uptime & Node Version
    const uptime = (os.uptime() / 3600).toFixed(1);
    report.push(`Uptime: ${uptime}h`);
    report.push(`Node: ${process.version}`);

    // Memory Usage (RSS)
    const mem = process.memoryUsage();
    const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
    report.push(`Agent RSS: ${rssMb}MB`);

    // Optimization: Use native Node.js fs.statfsSync instead of spawning 'df'
    if (fs.statfsSync) {
      const stats = fs.statfsSync('/');
      const total = stats.blocks * stats.bsize;
      const free = stats.bfree * stats.bsize;
      const used = total - free;
      const freeGb = (free / 1024 / 1024 / 1024).toFixed(1);
      const usedPercent = Math.round((used / total) * 100);
      report.push(`Disk: ${usedPercent}% (${freeGb}G free)`);
    }
  } catch (e) {}

  try {
    // Process count: Attempt pgrep first (faster), fallback to ps
    try {
      const pgrep = execSync('pgrep -c node', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      report.push(`Node Processes: ${pgrep.trim()}`);
    } catch (e) {
      // Fallback to ps if pgrep fails/missing
      const ps = execSync('ps aux | grep node | grep -v grep | wc -l', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      });
      report.push(`Node Processes: ${ps.trim()}`);
    }
  } catch (e) {}

  // Integration Health Checks (Env Vars)
  try {
    const issues = [];
    if (!process.env.GEMINI_API_KEY) issues.push('Gemini Key Missing');

    // Generic Integration Status Check (Decoupled)
    if (process.env.INTEGRATION_STATUS_CMD) {
      try {
        const status = execSync(process.env.INTEGRATION_STATUS_CMD, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
        });
        if (status.trim()) issues.push(status.trim());
      } catch (e) {}
    }

    if (issues.length > 0) {
      report.push(`Integrations: ${issues.join(', ')}`);
    } else {
      report.push('Integrations: Nominal');
    }
  } catch (e) {}

  return report.length ? report.join(' | ') : 'Health Check Unavailable';
}

function getMutationDirective(logContent) {
  // Signal hints derived from recent logs.
  const errorMatches = logContent.match(/\[ERROR|Error:|Exception:|FAIL|Failed|"isError":true/gi) || [];
  const errorCount = errorMatches.length;
  const isUnstable = errorCount > 2;
  const recommendedIntent = isUnstable ? 'repair' : 'optimize';

  return `
[Signal Hints]
- recent_error_count: ${errorCount}
- stability: ${isUnstable ? 'unstable' : 'stable'}
- recommended_intent: ${recommendedIntent}
`;
}

const STATE_FILE = path.join(MEMORY_DIR, 'evolution_state.json');
// Fix: Look for MEMORY.md in root first, then memory dir to support both layouts
const ROOT_MEMORY = path.join(REPO_ROOT, 'MEMORY.md');
const DIR_MEMORY = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_FILE = fs.existsSync(ROOT_MEMORY) ? ROOT_MEMORY : DIR_MEMORY;
const USER_FILE = path.join(REPO_ROOT, 'USER.md');

function readMemorySnippet() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) return '[MEMORY.md MISSING]';
    const content = fs.readFileSync(MEMORY_FILE, 'utf8');
    // Optimization: Increased limit from 2000 to 50000 for modern context windows
    return content.length > 50000
      ? content.slice(0, 50000) + `\n... [TRUNCATED: ${content.length - 50000} chars remaining]`
      : content;
  } catch (e) {
    return '[ERROR READING MEMORY.md]';
  }
}

function readUserSnippet() {
  try {
    if (!fs.existsSync(USER_FILE)) return '[USER.md MISSING]';
    return fs.readFileSync(USER_FILE, 'utf8');
  } catch (e) {
    return '[ERROR READING USER.md]';
  }
}

function getNextCycleId() {
  let state = { cycleCount: 0, lastRun: 0 };
  try {
    if (fs.existsSync(STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}

  state.cycleCount = (state.cycleCount || 0) + 1;
  state.lastRun = Date.now();

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {}

  return String(state.cycleCount).padStart(4, '0');
}

function performMaintenance() {
  try {
    if (!fs.existsSync(AGENT_SESSIONS_DIR)) return;

    // Count files
    const files = fs.readdirSync(AGENT_SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
    if (files.length < 100) return; // Limit before cleanup

    console.log(`[Maintenance] Found ${files.length} session logs. Archiving old ones...`);

    const ARCHIVE_DIR = path.join(AGENT_SESSIONS_DIR, 'archive');
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

    // Sort by time (oldest first)
    const fileStats = files
      .map(f => {
        try {
          return { name: f, time: fs.statSync(path.join(AGENT_SESSIONS_DIR, f)).mtime.getTime() };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);

    // Keep last 50 files, archive the rest
    const toArchive = fileStats.slice(0, fileStats.length - 50);

    for (const file of toArchive) {
      const oldPath = path.join(AGENT_SESSIONS_DIR, file.name);
      const newPath = path.join(ARCHIVE_DIR, file.name);
      fs.renameSync(oldPath, newPath);
    }
    console.log(`[Maintenance] Archived ${toArchive.length} logs to ${ARCHIVE_DIR}`);
  } catch (e) {
    console.error(`[Maintenance] Error: ${e.message}`);
  }
}

async function run() {
  const startTime = Date.now();
  console.log('Scanning session logs...');

  // Maintenance: Clean up old logs to keep directory scan fast
  performMaintenance();

  const recentMasterLog = readRealSessionLog();
  const todayLog = readRecentLog(TODAY_LOG);
  const memorySnippet = readMemorySnippet();
  const userSnippet = readUserSnippet();

  const cycleNum = getNextCycleId();
  const cycleId = `Cycle #${cycleNum}`;

  // 2. Detect Workspace State & Local Overrides
  // Logic: Default to generic reporting (message)
  let fileList = '';
  const skillsDir = path.join(REPO_ROOT, 'skills');

  // Default Reporting: Use generic `message` tool or `process.env.EVOLVE_REPORT_CMD` if set.
  // This removes the hardcoded dependency on 'feishu-card' from the core logic.
  let reportingDirective = `Report requirement:
  - Use \`message\` tool.
  - Title: Evolution ${cycleId}
  - Status: [SUCCESS]
  - Changes: Detail exactly what was improved.`;

  // Wrapper Injection Point: The wrapper can inject a custom reporting directive via ENV.
  if (process.env.EVOLVE_REPORT_DIRECTIVE) {
    reportingDirective = process.env.EVOLVE_REPORT_DIRECTIVE.replace('__CYCLE_ID__', cycleId);
  } else if (process.env.EVOLVE_REPORT_CMD) {
    reportingDirective = `Report requirement (custom):
  - Execute the custom report command:
    \`\`\`
    ${process.env.EVOLVE_REPORT_CMD.replace('__CYCLE_ID__', cycleId)}
    \`\`\`
  - Ensure you pass the status and action details.`;
  }

  // Handle Review Mode Flag (--review)
  if (IS_REVIEW_MODE) {
    reportingDirective +=
      '\n  - REVIEW PAUSE: After generating the fix but BEFORE applying significant edits, ask the user for confirmation.';
  }

  const SKILLS_CACHE_FILE = path.join(MEMORY_DIR, 'skills_list_cache.json');

  try {
    if (fs.existsSync(skillsDir)) {
      // Check cache validity (mtime of skills folder vs cache file)
      let useCache = false;
      const dirStats = fs.statSync(skillsDir);
      if (fs.existsSync(SKILLS_CACHE_FILE)) {
        const cacheStats = fs.statSync(SKILLS_CACHE_FILE);
        const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 Hours
        const isFresh = Date.now() - cacheStats.mtimeMs < CACHE_TTL;

        // Use cache if it's fresh AND newer than the directory (structure change)
        if (isFresh && cacheStats.mtimeMs > dirStats.mtimeMs) {
          try {
            const cached = JSON.parse(fs.readFileSync(SKILLS_CACHE_FILE, 'utf8'));
            fileList = cached.list;
            useCache = true;
          } catch (e) {}
        }
      }

      if (!useCache) {
        const skills = fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => {
            const name = dirent.name;
            let desc = 'No description';
            try {
              const pkg = require(path.join(skillsDir, name, 'package.json'));
              if (pkg.description) desc = pkg.description.slice(0, 100) + (pkg.description.length > 100 ? '...' : '');
            } catch (e) {
              try {
                const skillMdPath = path.join(skillsDir, name, 'SKILL.md');
                if (fs.existsSync(skillMdPath)) {
                  const skillMd = fs.readFileSync(skillMdPath, 'utf8');
                  // Strategy 1: YAML Frontmatter (description: ...)
                  const yamlMatch = skillMd.match(/^description:\s*(.*)$/m);
                  if (yamlMatch) {
                    desc = yamlMatch[1].trim();
                  } else {
                    // Strategy 2: First non-header, non-empty line
                    const lines = skillMd.split('\n');
                    for (const line of lines) {
                      const trimmed = line.trim();
                      if (
                        trimmed &&
                        !trimmed.startsWith('#') &&
                        !trimmed.startsWith('---') &&
                        !trimmed.startsWith('```')
                      ) {
                        desc = trimmed;
                        break;
                      }
                    }
                  }
                  if (desc.length > 100) desc = desc.slice(0, 100) + '...';
                }
              } catch (e2) {}
            }
            return `- **${name}**: ${desc}`;
          });
        fileList = skills.join('\n');

        // Write cache
        try {
          fs.writeFileSync(SKILLS_CACHE_FILE, JSON.stringify({ list: fileList }, null, 2));
        } catch (e) {}
      }
    }
  } catch (e) {
    fileList = `Error listing skills: ${e.message}`;
  }

  const mutationDirective = getMutationDirective(recentMasterLog);
  const healthReport = checkSystemHealth();

  // Feature: Mood Awareness (Mode E - Personalization)
  let moodStatus = 'Mood: Unknown';
  try {
    const moodFile = path.join(MEMORY_DIR, 'mood.json');
    if (fs.existsSync(moodFile)) {
      const moodData = JSON.parse(fs.readFileSync(moodFile, 'utf8'));
      moodStatus = `Mood: ${moodData.current_mood || 'Neutral'} (Intensity: ${moodData.intensity || 0})`;
    }
  } catch (e) {}

  const scanTime = Date.now() - startTime;
  const memorySize = fs.existsSync(MEMORY_FILE) ? fs.statSync(MEMORY_FILE).size : 0;

  let syncDirective = 'Workspace sync: optional/disabled in this environment.';

  // Check for git-sync skill availability
  const hasGitSync = fs.existsSync(path.join(skillsDir, 'git-sync'));
  if (hasGitSync) {
    syncDirective = 'Workspace sync: run skills/git-sync/sync.sh "Evolution: Workspace Sync"';
  }

  const genes = loadGenes();
  const capsules = loadCapsules();
  const recentEvents = (() => {
    try {
      const all = readAllEvents();
      return Array.isArray(all) ? all.filter(e => e && e.type === 'EvolutionEvent').slice(-80) : [];
    } catch (e) {
      return [];
    }
  })();
  const signals = extractSignals({
    recentSessionTranscript: recentMasterLog,
    todayLog,
    memorySnippet,
    userSnippet,
  });

  const recentErrorMatches = recentMasterLog.match(/\[ERROR|Error:|Exception:|FAIL|Failed|"isError":true/gi) || [];
  const recentErrorCount = recentErrorMatches.length;

  const evidence = {
    // Keep short; do not store full transcripts in the graph.
    recent_session_tail: String(recentMasterLog || '').slice(-6000),
    today_log_tail: String(todayLog || '').slice(-2500),
  };

  const observations = {
    agent: AGENT_NAME,
    drift_enabled: IS_RANDOM_DRIFT,
    review_mode: IS_REVIEW_MODE,
    dry_run: IS_DRY_RUN,
    system_health: healthReport,
    mood: moodStatus,
    scan_ms: scanTime,
    memory_size_bytes: memorySize,
    recent_error_count: recentErrorCount,
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    evidence,
  };

  // Memory Graph: close last action with an inferred outcome (append-only graph, mutable state).
  try {
    recordOutcomeFromState({ signals, observations });
  } catch (e) {
    // If we can't read/write memory graph, refuse to evolve (no "memoryless evolution").
    console.error(`[MemoryGraph] Outcome write failed: ${e.message}`);
    console.error(`[MemoryGraph] Refusing to evolve without causal memory. Target: ${memoryGraphPath()}`);
    process.exit(2);
  }

  // Memory Graph: record current signals as a first-class node. If this fails, refuse to evolve.
  try {
    recordSignalSnapshot({ signals, observations });
  } catch (e) {
    console.error(`[MemoryGraph] Signal snapshot write failed: ${e.message}`);
    console.error(`[MemoryGraph] Refusing to evolve without causal memory. Target: ${memoryGraphPath()}`);
    process.exit(2);
  }

  // Capability candidates (structured, short): persist and preview.
  const newCandidates = extractCapabilityCandidates({
    recentSessionTranscript: recentMasterLog,
    signals,
  });
  for (const c of newCandidates) {
    try {
      appendCandidateJsonl(c);
    } catch (e) {}
  }
  const recentCandidates = readRecentCandidates(20);
  const capabilityCandidatesPreview = renderCandidatesPreview(recentCandidates.slice(-8), 1600);

  // External candidate zone (A2A receive): only surface candidates when local signals trigger them.
  // External candidates are NEVER executed directly; they must be validated and promoted first.
  let externalCandidatesPreview = '(none)';
  try {
    const external = readRecentExternalCandidates(50);
    const list = Array.isArray(external) ? external : [];
    const capsulesOnly = list.filter(x => x && x.type === 'Capsule');
    const genesOnly = list.filter(x => x && x.type === 'Gene');

    const matchedExternalGenes = genesOnly
      .map(g => {
        const pats = Array.isArray(g.signals_match) ? g.signals_match : [];
        const hit = pats.reduce((acc, p) => (matchPatternToSignals(p, signals) ? acc + 1 : acc), 0);
        return { gene: g, hit };
      })
      .filter(x => x.hit > 0)
      .sort((a, b) => b.hit - a.hit)
      .slice(0, 3)
      .map(x => x.gene);

    const matchedExternalCapsules = capsulesOnly
      .map(c => {
        const triggers = Array.isArray(c.trigger) ? c.trigger : [];
        const score = triggers.reduce((acc, t) => (matchPatternToSignals(t, signals) ? acc + 1 : acc), 0);
        return { capsule: c, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(x => x.capsule);

    if (matchedExternalGenes.length || matchedExternalCapsules.length) {
      externalCandidatesPreview = `\`\`\`json\n${JSON.stringify(
        [
          ...matchedExternalGenes.map(g => ({
            type: g.type,
            id: g.id,
            category: g.category || null,
            signals_match: g.signals_match || [],
            a2a: g.a2a || null,
          })),
          ...matchedExternalCapsules.map(c => ({
            type: c.type,
            id: c.id,
            trigger: c.trigger,
            gene: c.gene,
            summary: c.summary,
            confidence: c.confidence,
            blast_radius: c.blast_radius || null,
            outcome: c.outcome || null,
            success_streak: c.success_streak || null,
            a2a: c.a2a || null,
          })),
        ],
        null,
        2
      )}\n\`\`\``;
    }
  } catch (e) {}

  // Memory Graph reasoning: prefer high-confidence paths, suppress known low-success paths (unless drift is explicit).
  let memoryAdvice = null;
  try {
    memoryAdvice = getMemoryAdvice({ signals, genes, driftEnabled: IS_RANDOM_DRIFT });
  } catch (e) {
    console.error(`[MemoryGraph] Read failed: ${e.message}`);
    console.error(`[MemoryGraph] Refusing to evolve without causal memory. Target: ${memoryGraphPath()}`);
    process.exit(2);
  }

  const { selectedGene, capsuleCandidates, selector } = selectGeneAndCapsule({
    genes,
    capsules,
    signals,
    memoryAdvice,
    driftEnabled: IS_RANDOM_DRIFT,
  });

  const selectedBy = memoryAdvice && memoryAdvice.preferredGeneId ? 'memory_graph+selector' : 'selector';
  const capsulesUsed = Array.isArray(capsuleCandidates)
    ? capsuleCandidates.map(c => (c && c.id ? String(c.id) : null)).filter(Boolean)
    : [];
  const selectedCapsuleId = capsulesUsed.length ? capsulesUsed[0] : null;

  // Personality selection (natural selection + small mutation when triggered).
  // This state is persisted in MEMORY_DIR and is treated as an evolution control surface (not role-play).
  const personalitySelection = selectPersonalityForRun({
    driftEnabled: IS_RANDOM_DRIFT,
    signals,
    recentEvents,
  });
  const personalityState = personalitySelection && personalitySelection.personality_state ? personalitySelection.personality_state : null;

  // Mutation object is mandatory for every evolution run.
  const tail = Array.isArray(recentEvents) ? recentEvents.slice(-6) : [];
  const tailOutcomes = tail
    .map(e => (e && e.outcome && e.outcome.status ? String(e.outcome.status) : null))
    .filter(Boolean);
  const stableSuccess = tailOutcomes.length >= 6 && tailOutcomes.every(s => s === 'success');
  const tailAvgScore =
    tail.length > 0
      ? tail.reduce((acc, e) => acc + (e && e.outcome && Number.isFinite(Number(e.outcome.score)) ? Number(e.outcome.score) : 0), 0) /
        tail.length
      : 0;
  const innovationPressure =
    !IS_RANDOM_DRIFT &&
    personalityState &&
    Number.isFinite(Number(personalityState.creativity)) &&
    Number(personalityState.creativity) >= 0.75 &&
    stableSuccess &&
    tailAvgScore >= 0.7;
  const mutationInnovateMode = !!IS_RANDOM_DRIFT || !!innovationPressure;
  const mutationSignals = innovationPressure ? [...(Array.isArray(signals) ? signals : []), 'stable_success_plateau'] : signals;

  const allowHighRisk =
    !!IS_RANDOM_DRIFT &&
    !!personalitySelection &&
    !!personalitySelection.personality_known &&
    personalityState &&
    isHighRiskMutationAllowed(personalityState) &&
    Number(personalityState.rigor) >= 0.8 &&
    Number(personalityState.risk_tolerance) <= 0.3 &&
    !(Array.isArray(signals) && signals.includes('log_error'));
  const mutation = buildMutation({
    signals: mutationSignals,
    selectedGene,
    driftEnabled: mutationInnovateMode,
    personalityState,
    allowHighRisk,
  });

  // Memory Graph: record hypothesis bridging Signal -> Action. If this fails, refuse to evolve.
  let hypothesisId = null;
  try {
    const hyp = recordHypothesis({
      signals,
      mutation,
      personality_state: personalityState,
      selectedGene,
      selector,
      driftEnabled: IS_RANDOM_DRIFT,
      selectedBy,
      capsulesUsed,
      observations,
    });
    hypothesisId = hyp && hyp.hypothesisId ? hyp.hypothesisId : null;
  } catch (e) {
    console.error(`[MemoryGraph] Hypothesis write failed: ${e.message}`);
    console.error(`[MemoryGraph] Refusing to evolve without causal memory. Target: ${memoryGraphPath()}`);
    process.exit(2);
  }

  // Memory Graph: record the chosen causal path for this run. If this fails, refuse to output a mutation prompt.
  try {
    recordAttempt({
      signals,
      mutation,
      personality_state: personalityState,
      selectedGene,
      selector,
      driftEnabled: IS_RANDOM_DRIFT,
      selectedBy,
      hypothesisId,
      capsulesUsed,
      observations,
    });
  } catch (e) {
    console.error(`[MemoryGraph] Attempt write failed: ${e.message}`);
    console.error(`[MemoryGraph] Refusing to evolve without causal memory. Target: ${memoryGraphPath()}`);
    process.exit(2);
  }

  // Solidify state: capture minimal, auditable context for post-patch validation + asset write.
  // This enforces strict protocol closure after patch application.
  try {
    const parentEventId = getLastEventId();
    const selectedBy = memoryAdvice && memoryAdvice.preferredGeneId ? 'memory_graph+selector' : 'selector';

    // Baseline snapshot (before any edits).
    let baselineUntracked = [];
    let baselineHead = null;
    try {
      const out = execSync('git ls-files --others --exclude-standard', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
      });
      baselineUntracked = String(out)
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
    } catch (e) {}

    try {
      const out = execSync('git rev-parse HEAD', {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 4000,
      });
      baselineHead = String(out || '').trim() || null;
    } catch (e) {}

    const maxFiles =
      selectedGene && selectedGene.constraints && Number.isFinite(Number(selectedGene.constraints.max_files))
        ? Number(selectedGene.constraints.max_files)
        : 12;
    const blastRadiusEstimate = {
      files: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 0,
      lines: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.round(maxFiles * 80) : 0,
    };

    writeStateForSolidify({
      last_run: {
        run_id: `run_${Date.now()}`,
        created_at: new Date().toISOString(),
        parent_event_id: parentEventId || null,
        selected_gene_id: selectedGene && selectedGene.id ? selectedGene.id : null,
        selected_capsule_id: selectedCapsuleId,
        selector: selector || null,
        signals: Array.isArray(signals) ? signals : [],
        mutation: mutation || null,
        mutation_id: mutation && mutation.id ? mutation.id : null,
        personality_state: personalityState || null,
        personality_key: personalitySelection && personalitySelection.personality_key ? personalitySelection.personality_key : null,
        personality_known: !!(personalitySelection && personalitySelection.personality_known),
        personality_mutations:
          personalitySelection && Array.isArray(personalitySelection.personality_mutations)
            ? personalitySelection.personality_mutations
            : [],
        drift: !!IS_RANDOM_DRIFT,
        selected_by: selectedBy,
        baseline_untracked: baselineUntracked,
        baseline_git_head: baselineHead,
        blast_radius_estimate: blastRadiusEstimate,
      },
    });
  } catch (e) {
    console.error(`[SolidifyState] Write failed: ${e.message}`);
  }

  const genesPreview = `\`\`\`json\n${JSON.stringify(genes.slice(0, 6), null, 2)}\n\`\`\``;
  const capsulesPreview = `\`\`\`json\n${JSON.stringify(capsules.slice(-3), null, 2)}\n\`\`\``;

  const reviewNote = IS_REVIEW_MODE
    ? 'Review mode: before significant edits, pause and ask the user for confirmation.'
    : 'Review mode: disabled.';

  const context = `
Runtime state:
- System health: ${healthReport}
- Agent state: ${moodStatus}
- Scan duration: ${scanTime}ms
- Memory size: ${memorySize} bytes
- Skills available (if any):
${fileList || '[skills directory not found]'}

Notes:
- ${reviewNote}
- ${reportingDirective}
- ${syncDirective}

External candidates (A2A receive zone; staged only, never execute directly):
${externalCandidatesPreview}

Global memory (MEMORY.md):
\`\`\`
${memorySnippet}
\`\`\`

User registry (USER.md):
\`\`\`
${userSnippet}
\`\`\`

Recent memory snippet:
\`\`\`
${todayLog.slice(-3000)}
\`\`\`

Recent session transcript:
\`\`\`
${recentMasterLog}
\`\`\`

Mutation directive:
${mutationDirective}
`.trim();

  const prompt = buildGepPrompt({
    nowIso: new Date().toISOString(),
    context,
    signals,
    selector,
    parentEventId: getLastEventId(),
    selectedGene,
    capsuleCandidates,
    genesPreview,
    capsulesPreview,
    capabilityCandidatesPreview,
    externalCandidatesPreview,
  });

  const bridgeEnabled = String(process.env.EVOLVE_BRIDGE || '').toLowerCase() !== 'false';
  const printPrompt = String(process.env.EVOLVE_PRINT_PROMPT || '').toLowerCase() === 'true';

  // Default behavior (v1.4.1+): "execute-by-default" by bridging prompt -> sub-agent via sessions_spawn.
  // This project is the Brain; the Hand is a spawned executor agent. Wrappers can disable bridging with EVOLVE_BRIDGE=false.
  if (bridgeEnabled) {
    const runId = `run_${Date.now()}`;
    let artifact = null;
    try {
      artifact = writePromptArtifact({
        memoryDir: MEMORY_DIR,
        cycleId,
        runId,
        prompt,
        meta: {
          agent: AGENT_NAME,
          drift_enabled: IS_RANDOM_DRIFT,
          review_mode: IS_REVIEW_MODE,
          dry_run: IS_DRY_RUN,
          mutation_id: mutation && mutation.id ? mutation.id : null,
          personality_key: personalitySelection && personalitySelection.personality_key ? personalitySelection.personality_key : null,
        },
      });
    } catch (e) {
      artifact = null;
    }

    const executorTask = [
      'You are the executor (the Hand).',
      'Your job is to apply a safe, minimal patch in this repo following the attached GEP protocol prompt.',
      artifact && artifact.promptPath ? `Prompt file: ${artifact.promptPath}` : 'Prompt file: (unavailable)',
      '',
      'After applying changes and validations, you MUST run:',
      '  node index.js solidify',
      '',
      'GEP protocol prompt (may be truncated here; prefer the prompt file if provided):',
      clip(prompt, 24000),
    ].join('\n');

    const spawn = renderSessionsSpawnCall({
      task: executorTask,
      agentId: AGENT_NAME,
      cleanup: 'delete',
      label: `gep_bridge_${cycleNum}`,
    });

    console.log('\n[BRIDGE ENABLED] Spawning executor agent via sessions_spawn.');
    console.log(spawn);
    if (printPrompt) {
      console.log('\n[PROMPT OUTPUT] (EVOLVE_PRINT_PROMPT=true)');
      console.log(prompt);
    }
  } else {
    console.log(prompt);
    console.log('\n[SOLIDIFY REQUIRED] After applying the patch and validations, run: node index.js solidify');
  }
}

module.exports = { run };

