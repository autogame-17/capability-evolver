#!/usr/bin/env node
const evolve = require('./src/evolve');
const { solidify } = require('./src/gep/solidify');
const path = require('path');
const { getRepoRoot } = require('./src/gep/paths');
try { require('dotenv').config({ path: path.join(getRepoRoot(), '.env') }); } catch (e) { console.warn('[Evolver] Warning: dotenv not found or failed to load .env'); }
const fs = require('fs');
const { spawn } = require('child_process');

function sleepMs(ms) {
  const n = parseInt(String(ms), 10);
  const t = Number.isFinite(n) ? Math.max(0, n) : 0;
  return new Promise(resolve => setTimeout(resolve, t));
}

function readJsonSafe(p) {
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

/**
 * Mark a pending evolution run as rejected (state-only, no git rollback).
 * @param {string} statePath - Path to evolution_solidify_state.json
 * @returns {boolean} true if a pending run was found and rejected
 */
function rejectPendingRun(statePath) {
  try {
    const state = readJsonSafe(statePath);
    if (state && state.last_run && state.last_run.run_id) {
      state.last_solidify = {
        run_id: state.last_run.run_id,
        rejected: true,
        reason: 'loop_bridge_disabled_autoreject_no_rollback',
        timestamp: new Date().toISOString(),
      };
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, statePath);
      return true;
    }
  } catch (e) {
    console.warn('[Loop] Failed to clear pending run state: ' + (e.message || e));
  }

  return false;
}

function isPendingSolidify(state) {
  const lastRun = state && state.last_run ? state.last_run : null;
  const lastSolid = state && state.last_solidify ? state.last_solidify : null;
  if (!lastRun || !lastRun.run_id) return false;
  if (!lastSolid || !lastSolid.run_id) return true;
  return String(lastSolid.run_id) !== String(lastRun.run_id);
}

function parseMs(v, fallback) {
  const n = parseInt(String(v == null ? '' : v), 10);
  if (Number.isFinite(n)) return Math.max(0, n);
  return fallback;
}

function getLastSignals(statePath) {
  try {
    const st = readJsonSafe(statePath);
    return (st && st.last_run && Array.isArray(st.last_run.signals)) ? st.last_run.signals : [];
  } catch (e) {
    return [];
  }
}

// Singleton Guard - prevent multiple evolver daemon instances
function acquireLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return true;
    } catch (exclErr) {
      if (exclErr.code !== 'EEXIST') throw exclErr;
    }
    const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      console.log('[Singleton] Corrupt lock file (invalid PID). Taking over.');
    } else {
      try {
        process.kill(pid, 0);
        console.log(`[Singleton] Evolver loop already running (PID ${pid}). Exiting.`);
        return false;
      } catch (e) {
        console.log(`[Singleton] Stale lock found (PID ${pid}). Taking over.`);
      }
    }
    fs.writeFileSync(lockFile, String(process.pid));
    return true;
  } catch (err) {
    console.error('[Singleton] Lock acquisition failed:', err);
    return false;
  }
}

function releaseLock() {
  const lockFile = path.join(__dirname, 'evolver.pid');
  try {
    if (fs.existsSync(lockFile)) {
       const pid = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
       if (pid === process.pid) fs.unlinkSync(lockFile);
    }
  } catch (e) { /* ignore */ }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const isLoop = args.includes('--loop') || args.includes('--mad-dog');
  const isVerbose = args.includes('--verbose') || args.includes('-v') ||
    String(process.env.EVOLVER_VERBOSE || '').toLowerCase() === 'true';
  if (isVerbose) process.env.EVOLVER_VERBOSE = 'true';

  if (!command || command === 'run' || command === '/evolve' || isLoop) {
    if (isLoop) {
        const originalLog = console.log;
        const originalWarn = console.warn;
        const originalError = console.error;
        function ts() { return '[' + new Date().toISOString() + ']'; }
        console.log = (...args) => { originalLog.call(console, ts(), ...args); };
        console.warn = (...args) => { originalWarn.call(console, ts(), ...args); };
        console.error = (...args) => { originalError.call(console, ts(), ...args); };
    }

    console.log('Starting evolver...');
    
    if (isLoop) {
        // Internal daemon loop (no wrapper required).
        if (!acquireLock()) process.exit(0);
        function shutdown() {
          releaseLock();
          try { require('./src/gep/a2aProtocol').stopEventStream(); } catch (e) {}
        }
        process.on('exit', shutdown);
        process.on('SIGINT', () => { shutdown(); process.exit(); });
        process.on('SIGTERM', () => { shutdown(); process.exit(); });
        process.on('uncaughtException', (err) => {
          console.error('[FATAL] Uncaught exception:', err && err.stack ? err.stack : String(err));
          releaseLock();
          process.exit(1);
        });
        let _unhandledRejectionCount = 0;
        process.on('unhandledRejection', (reason) => {
          _unhandledRejectionCount++;
          console.error('[FATAL] Unhandled promise rejection (' + _unhandledRejectionCount + '):', reason && reason.stack ? reason.stack : String(reason));
          if (_unhandledRejectionCount >= 5) {
            console.error('[FATAL] Too many unhandled rejections (' + _unhandledRejectionCount + '). Exiting to avoid corrupt state.');
            releaseLock();
            process.exit(1);
          }
        });

        process.env.EVOLVE_LOOP = 'true';
        if (!process.env.EVOLVE_BRIDGE) {
          process.env.EVOLVE_BRIDGE = 'false';
        }
        console.log(`Loop mode enabled (internal daemon, bridge=${process.env.EVOLVE_BRIDGE}, verbose=${isVerbose}).`);

        const { getEvolutionDir, getEvolverLogPath } = require('./src/gep/paths');
        const solidifyStatePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');

        const minSleepMs = parseMs(process.env.EVOLVER_MIN_SLEEP_MS, 2000);
        const maxSleepMs = parseMs(process.env.EVOLVER_MAX_SLEEP_MS, 300000);
        const idleThresholdMs = parseMs(process.env.EVOLVER_IDLE_THRESHOLD_MS, 500);
        const pendingSleepMs = parseMs(
          process.env.EVOLVE_PENDING_SLEEP_MS ||
            process.env.EVOLVE_MIN_INTERVAL ||
            process.env.FEISHU_EVOLVER_INTERVAL,
          120000
        );

        const maxCyclesPerProcess = parseMs(process.env.EVOLVER_MAX_CYCLES_PER_PROCESS, 100) || 100;
        const maxRssMb = parseMs(process.env.EVOLVER_MAX_RSS_MB, 500) || 500;
        const suicideEnabled = String(process.env.EVOLVER_SUICIDE || '').toLowerCase() !== 'false';

        // Start hub heartbeat (keeps node alive independently of evolution cycles)
        try {
          if (process.env.EVOMAP_PROXY === '1' || process.env.A2A_TRANSPORT === 'mailbox') {
            const { startProxy } = require('./src/proxy');
            const proxyInfo = await startProxy({
              hubUrl: process.env.A2A_HUB_URL,
            });
            console.log('[Proxy] Started on ' + proxyInfo.url);
            const { registerMailboxTransport } = require('./src/gep/mailboxTransport');
            registerMailboxTransport();
            process.env.A2A_TRANSPORT = 'mailbox';
          } else {
            const a2a = require('./src/gep/a2aProtocol');
            try { a2a.startHeartbeat(); }
            catch (hbErr) { console.warn('[Heartbeat] startHeartbeat failed: ' + (hbErr && hbErr.message || hbErr)); }
            try { a2a.startEventStream(); }
            catch (ssErr) { console.warn('[SSE] startEventStream failed: ' + (ssErr && ssErr.message || ssErr)); }
          }
        } catch (e) {
          console.warn('[Heartbeat] Failed to start: ' + (e.message || e));
        }

        // ATP: auto-start merchant agent if enabled
        try {
          const { defaultHandler, merchantAgent } = require('./src/atp');
          const atpMode = defaultHandler.getAtpMode();
          if (atpMode === 'auto' || atpMode === 'on') {
            const hubUrl = process.env.A2A_HUB_URL || process.env.EVOMAP_HUB_URL || '';
            if (hubUrl) {
              const services = defaultHandler.resolveAtpServices();
              merchantAgent.start({
                services: services,
                onOrder: defaultHandler.defaultOrderHandler,
                pollMs: 30000,
              }).catch(function (atpErr) {
                console.warn('[ATP] merchantAgent.start failed: ' + (atpErr && atpErr.message || atpErr));
              });
            }
          }
        } catch (atpInitErr) {
          console.warn('[ATP] Auto-init failed: ' + (atpInitErr && atpInitErr.message || atpInitErr));
        }

        // Hoist module refs used inside the loop to avoid repeated module lookups per cycle
        const idleScheduler = require('./src/gep/idleScheduler');
        const { shouldDistillFromFailures: shouldDF, autoDistillFromFailures: autoDF } = require('./src/gep/skillDistiller');
        const { tryExplore } = require('./src/gep/explore');

        let currentSleepMs = minSleepMs;
        let cycleCount = 0;

        while (true) {
          try {
          cycleCount += 1;

          // Ralph-loop gating: do not run a new cycle while previous run is pending solidify.
          const st0 = readJsonSafe(solidifyStatePath);
          if (isPendingSolidify(st0)) {
            await sleepMs(Math.max(pendingSleepMs, minSleepMs));
            continue;
          }

          const t0 = Date.now();
          let ok = false;
          try {
            await evolve.run();
            ok = true;

            if (String(process.env.EVOLVE_BRIDGE || '').toLowerCase() === 'false') {
              const stAfterRun = readJsonSafe(solidifyStatePath);
              if (isPendingSolidify(stAfterRun)) {
                const cleared = rejectPendingRun(solidifyStatePath);
                if (cleared) {
                  console.warn('[Loop] Auto-rejected pending run because bridge is disabled in loop mode (state only, no rollback).');
                }
              }
            }
          } catch (error) {
            const msg = error && error.message ? String(error.message) : String(error);
            console.error(`Evolution cycle failed: ${msg}`);
          }
          const dt = Date.now() - t0;

          // Adaptive sleep: treat very fast cycles as "idle", backoff; otherwise reset to min.
          if (!ok || dt < idleThresholdMs) {
            currentSleepMs = Math.min(maxSleepMs, Math.max(minSleepMs, currentSleepMs * 2));
          } else {
            currentSleepMs = minSleepMs;
          }

          // OMLS-inspired idle scheduling: adjust sleep and trigger aggressive
          // operations (distillation, reflection) during detected idle windows.
          let omlsMultiplier = 1;
          try {
            const schedule = idleScheduler.getScheduleRecommendation();
            if (schedule.enabled && schedule.sleep_multiplier > 0) {
              omlsMultiplier = schedule.sleep_multiplier;
              if (schedule.should_distill) {
                try {
                  if (shouldDF()) {
                    const dfResult = autoDF();
                    if (dfResult && dfResult.ok) {
                      console.log('[OMLS] Idle-window failure distillation: ' + dfResult.gene.id);
                    }
                  }
                } catch (e) {
                  if (isVerbose) console.warn('[OMLS] Distill error: ' + (e.message || e));
                }
              }
              if (schedule.should_explore) {
                try {
                  const exploreResult = await tryExplore([], schedule, getRepoRoot());
                  if (exploreResult && exploreResult.signals && exploreResult.signals.length > 0) {
                    console.log('[OMLS] Explore discovered ' + exploreResult.signals.length + ' signals: ' + exploreResult.signals.slice(0, 5).join(', '));
                  }
                } catch (e) {
                  if (isVerbose) console.warn('[OMLS] Explore error: ' + (e.message || e));
                }
              }
              if (isVerbose && schedule.idle_seconds >= 0) {
                console.log(`[OMLS] idle=${schedule.idle_seconds}s intensity=${schedule.intensity} multiplier=${omlsMultiplier}`);
              }
            }
          } catch (e) {
            if (isVerbose) console.warn('[OMLS] Scheduler error: ' + (e.message || e));
          }

          // Suicide check (memory leak protection)
          if (suicideEnabled) {
            const memMb = process.memoryUsage().rss / 1024 / 1024;
            if (cycleCount >= maxCyclesPerProcess || memMb > maxRssMb) {
              console.log(`[Daemon] Restarting self (cycles=${cycleCount}, rssMb=${memMb.toFixed(0)})`);
              try {
                const logFd = fs.openSync(getEvolverLogPath(), 'a');
                const spawnOpts = {
                  detached: true,
                  stdio: ['ignore', logFd, logFd],
                  env: process.env,
                  windowsHide: true,
                };
                const child = spawn(process.execPath, [__filename, ...args], spawnOpts);
                child.unref();
                releaseLock();
                process.exit(0);
              } catch (spawnErr) {
                console.error('[Daemon] Spawn failed, continuing current process:', spawnErr.message);
              }
            }
          }

          let saturationMultiplier = 1;
          try {
            const lastSignals = getLastSignals(solidifyStatePath);
            if (lastSignals.includes('force_steady_state')) {
              saturationMultiplier = 4;
              console.log('[Daemon] Saturation detected. Entering steady-state mode (4x sleep).');
            } else if (lastSignals.includes('evolution_saturation')) {
              saturationMultiplier = 2;
              console.log('[Daemon] Approaching saturation. Reducing evolution frequency (2x sleep).');
            }
          } catch (e) {
            if (isVerbose) console.warn('[Daemon] Saturation check error: ' + (e.message || e));
          }

          // Jitter to avoid lockstep restarts.
          const jitter = Math.floor(Math.random() * 250);
          const totalSleepMs = Math.max(minSleepMs, (currentSleepMs + jitter) * saturationMultiplier * omlsMultiplier);
          if (isVerbose) {
            const memMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
            const signals = getLastSignals(solidifyStatePath).join(',');
            console.log(`[Verbose] cycle=${cycleCount} ok=${ok} dt=${dt}ms sleep=${totalSleepMs}ms (base=${currentSleepMs} jitter=${jitter} sat=${saturationMultiplier}x) rss=${memMb}MB signals=[${signals}]`);
          }
          await sleepMs(totalSleepMs);

          } catch (loopErr) {
            console.error('[Daemon] Unexpected loop error (recovering): ' + (loopErr && loopErr.message ? loopErr.message : String(loopErr)));
            await sleepMs(Math.max(minSleepMs, 10000));
          }
        }
    } else {
        // Normal Single Run
        try {
            await evolve.run();
        } catch (error) {
            console.error('Evolution failed:', error);
            process.exit(1);
        }
    }

    // Post-run hint
    console.log('\n' + '=======================================================');
    console.log('Evolver finished. If you use this project, consider starring the upstream repository.');
    console.log('Upstream: https://github.com/EvoMap/evolver');
    console.log('=======================================================\n');
    
  } else if (command === 'solidify') {
    const dryRun = args.includes('--dry-run');
    const noRollback = args.includes('--no-rollback');
    const intentFlag = args.find(a => typeof a === 'string' && a.startsWith('--intent='));
    const summaryFlag = args.find(a => typeof a === 'string' && a.startsWith('--summary='));
    const intent = intentFlag ? intentFlag.slice('--intent='.length) : null;
    const summary = summaryFlag ? summaryFlag.slice('--summary='.length) : null;

    try {
      const res = solidify({
        intent: intent || undefined,
        summary: summary || undefined,
        dryRun,
        rollbackOnFailure: !noRollback,
      });
      const st = res && res.ok ? 'SUCCESS' : 'FAILED';
      console.log(`[SOLIDIFY] ${st}`);
      if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
      if (res && res.event) console.log(JSON.stringify(res.event, null, 2));
      if (res && res.capsule) console.log(JSON.stringify(res.capsule, null, 2));

      if (res && res.ok && !dryRun) {
        try {
          const { shouldDistill, prepareDistillation, autoDistill, shouldDistillFromFailures, autoDistillFromFailures } = require('./src/gep/skillDistiller');
          const { readStateForSolidify } = require('./src/gep/solidify');
          const solidifyState = readStateForSolidify();
          const count = solidifyState.solidify_count || 0;
          const autoDistillInterval = 5;
          const autoTrigger = count > 0 && count % autoDistillInterval === 0;

          if (autoTrigger || shouldDistill()) {
            const auto = autoDistill();
            if (auto && auto.ok && auto.gene) {
              console.log('[Distiller] Auto-distilled gene: ' + auto.gene.id);
            } else {
              const dr = prepareDistillation();
              if (dr && dr.ok && dr.promptPath) {
                const trigger = autoTrigger ? `auto (every ${autoDistillInterval} solidifies, count=${count})` : 'threshold';
                console.log('\n[DISTILL_REQUEST]');
                console.log(`Distillation triggered: ${trigger}`);
                console.log('Read the prompt file, process it with your LLM,');
                console.log('save the LLM response to a file, then run:');
                console.log('  node index.js distill --response-file=<path_to_llm_response>');
                console.log('Prompt file: ' + dr.promptPath);
                console.log('[/DISTILL_REQUEST]');
              }
            }
          }

          if (shouldDistillFromFailures()) {
            const failureResult = autoDistillFromFailures();
            if (failureResult && failureResult.ok && failureResult.gene) {
              console.log('[Distiller] Repair gene distilled from failures: ' + failureResult.gene.id);
            }
          }
        } catch (e) {
          console.warn('[Distiller] Init failed (non-fatal): ' + (e.message || e));
        }
      }

      if (res && res.hubReviewPromise) {
        await res.hubReviewPromise;
      }

      // Post-solidify urgent questions: when solidify fails or produces a
      // low-quality outcome, generate questions and send them to Hub immediately.
      if (!dryRun) {
        try {
          const { generateUrgentQuestions } = require('./src/gep/questionGenerator');
          const { fetchTasks } = require('./src/gep/taskReceiver');
          const urgentOpts = {};

          if (!res || !res.ok) {
            if (res && res.validation && !res.validation.ok) {
              urgentOpts.validationFailed = true;
              const failedStep = res.validation.results && res.validation.results.find(function (r) { return !r.ok; });
              urgentOpts.validationErrors = failedStep ? (failedStep.err || failedStep.cmd || '') : '';
            }
            urgentOpts.geneId = res && res.gene ? res.gene.id : undefined;
            const evtOutcome = res && res.event && res.event.outcome;
            if (evtOutcome && typeof evtOutcome.score === 'number' && evtOutcome.score < 0.3) {
              urgentOpts.lowConfidence = true;
              urgentOpts.confidenceScore = evtOutcome.score;
              urgentOpts.intent = res.event.intent;
            }
            if (res && res.blast && res.blast.files === 0 && res.blast.lines === 0) {
              urgentOpts.zeroBlastRadius = true;
              urgentOpts.hadSignals = true;
              urgentOpts.signals = res.event && Array.isArray(res.event.signals) ? res.event.signals : [];
            }
            if (res && res.constraintCheck && Array.isArray(res.constraintCheck.violations)) {
              const llmRejectV = res.constraintCheck.violations.find(function (v) { return String(v).startsWith('llm_review_rejected'); });
              if (llmRejectV) {
                urgentOpts.llmReviewRejected = true;
                urgentOpts.llmReviewReason = String(llmRejectV).replace('llm_review_rejected: ', '');
              }
            }
            const lr = readJsonSafe(path.join(require('./src/gep/paths').getEvolutionDir(), 'evolution_solidify_state.json'));
            if (lr && lr.last_run && lr.last_run.active_task_id) {
              urgentOpts.taskCompletionFailed = true;
              urgentOpts.taskTitle = lr.last_run.active_task_title || '';
              urgentOpts.taskSignals = Array.isArray(lr.last_run.task_signals) ? lr.last_run.task_signals.join(', ') : '';
            }
          } else if (res.event && res.event.outcome && res.event.outcome.score < 0.3) {
            urgentOpts.lowConfidence = true;
            urgentOpts.confidenceScore = res.event.outcome.score;
            urgentOpts.intent = res.event.intent;
          }

          if (Object.keys(urgentOpts).length > 0) {
            const urgentQs = generateUrgentQuestions(urgentOpts);
            if (urgentQs.length > 0) {
              console.log('[UrgentQ] Generated ' + urgentQs.length + ' urgent question(s) from solidify outcome.');
              try {
                const fetchRes = await fetchTasks({ questions: urgentQs });
                if (fetchRes.questions_created) {
                  const accepted = fetchRes.questions_created.filter(function (q) { return !q.error; });
                  if (accepted.length > 0) {
                    console.log('[UrgentQ] Hub accepted ' + accepted.length + ' urgent question(s) as bounties.');
                  }
                }
              } catch (err) {
                console.log('[UrgentQ] Send failed (non-fatal): ' + (err && err.message ? err.message : err));
              }
            }
          }
        } catch (e) {
          console.log('[UrgentQ] Init failed (non-fatal): ' + (e && e.message ? e.message : e));
        }
      }

      process.exit(res && res.ok ? 0 : 2);
    } catch (error) {
      console.error('[SOLIDIFY] Error:', error);
      process.exit(2);
    }
  } else if (command === 'distill') {
    const responseFileFlag = args.find(a => typeof a === 'string' && a.startsWith('--response-file='));
    if (!responseFileFlag) {
      console.error('Usage: node index.js distill --response-file=<path>');
      process.exit(1);
    }
    const responseFilePath = responseFileFlag.slice('--response-file='.length);
    try {
      const responseText = fs.readFileSync(responseFilePath, 'utf8');
      const { completeDistillation } = require('./src/gep/skillDistiller');
      const result = completeDistillation(responseText);
      if (result && result.ok) {
        console.log('[Distiller] Gene produced: ' + result.gene.id);
        console.log(JSON.stringify(result.gene, null, 2));
      } else {
        console.warn('[Distiller] Distillation did not produce a gene: ' + (result && result.reason || 'unknown'));
      }
      process.exit(result && result.ok ? 0 : 2);
    } catch (error) {
      console.error('[DISTILL] Error:', error);
      process.exit(2);
    }

  } else if (command === 'review' || command === '--review') {
    const { getEvolutionDir, getRepoRoot } = require('./src/gep/paths');
    const { loadGenes } = require('./src/gep/assetStore');
    const { execSync } = require('child_process');

    const statePath = path.join(getEvolutionDir(), 'evolution_solidify_state.json');
    const state = readJsonSafe(statePath);
    const lastRun = state && state.last_run ? state.last_run : null;

    if (!lastRun || !lastRun.run_id) {
      console.log('[Review] No pending evolution run to review.');
      console.log('Run "node index.js run" first to produce changes, then review before solidifying.');
      process.exit(0);
    }

    const lastSolid = state && state.last_solidify ? state.last_solidify : null;
    if (lastSolid && String(lastSolid.run_id) === String(lastRun.run_id)) {
      console.log('[Review] Last run has already been solidified. Nothing to review.');
      process.exit(0);
    }

    const repoRoot = getRepoRoot();
    let diff = '';
    try {
      const unstaged = execSync('git diff', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim();
      const staged = execSync('git diff --cached', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', { cwd: repoRoot, encoding: 'utf8', timeout: 10000 }).trim();
      if (staged) diff += '=== Staged Changes ===\n' + staged + '\n\n';
      if (unstaged) diff += '=== Unstaged Changes ===\n' + unstaged + '\n\n';
      if (untracked) diff += '=== Untracked Files ===\n' + untracked + '\n';
    } catch (e) {
      diff = '(failed to capture diff: ' + (e.message || e) + ')';
    }

    const genes = loadGenes();
    const geneId = lastRun.selected_gene_id ? String(lastRun.selected_gene_id) : null;
    const gene = geneId ? genes.find(g => g && g.type === 'Gene' && g.id === geneId) : null;
    const signals = Array.isArray(lastRun.signals) ? lastRun.signals : [];
    const mutation = lastRun.mutation || null;

    console.log('\n' + '='.repeat(60));
    console.log('[Review] Pending evolution run: ' + lastRun.run_id);
    console.log('='.repeat(60));
    console.log('\n--- Gene ---');
    if (gene) {
      console.log('  ID:       ' + gene.id);
      console.log('  Category: ' + (gene.category || '?'));
      console.log('  Summary:  ' + (gene.summary || '?'));
      if (Array.isArray(gene.strategy) && gene.strategy.length > 0) {
        console.log('  Strategy:');
        gene.strategy.forEach((s, i) => console.log('    ' + (i + 1) + '. ' + s));
      }
    } else {
      console.log('  (no gene selected or gene not found: ' + (geneId || 'none') + ')');
    }

    console.log('\n--- Signals ---');
    if (signals.length > 0) {
      signals.forEach(s => console.log('  - ' + s));
    } else {
      console.log('  (no signals)');
    }

    console.log('\n--- Mutation ---');
    if (mutation) {
      console.log('  Category:   ' + (mutation.category || '?'));
      console.log('  Risk Level: ' + (mutation.risk_level || '?'));
      if (mutation.rationale) console.log('  Rationale:  ' + mutation.rationale);
    } else {
      console.log('  (no mutation data)');
    }

    if (lastRun.blast_radius_estimate) {
      console.log('\n--- Blast Radius Estimate ---');
      const br = lastRun.blast_radius_estimate;
      console.log('  Files changed: ' + (br.files_changed || '?'));
      console.log('  Lines changed: ' + (br.lines_changed || '?'));
    }

    console.log('\n--- Diff ---');
    if (diff.trim()) {
      console.log(diff.length > 5000 ? diff.slice(0, 5000) + '\n... (truncated, ' + diff.length + ' chars total)' : diff);
    } else {
      console.log('  (no changes detected)');
    }
    console.log('='.repeat(60));

    if (args.includes('--approve')) {
      console.log('\n[Review] Approved. Running solidify...\n');
      try {
        const res = solidify({
          intent: lastRun.intent || undefined,
          rollbackOnFailure: true,
        });
        const st = res && res.ok ? 'SUCCESS' : 'FAILED';
        console.log(`[SOLIDIFY] ${st}`);
        if (res && res.gene) console.log(JSON.stringify(res.gene, null, 2));
        if (res && res.hubReviewPromise) {
          await res.hubReviewPromise;
        }
        process.exit(res && res.ok ? 0 : 2);
      } catch (error) {
        console.error('[SOLIDIFY] Error:', error);
        process.exit(2);
      }
    } else if (args.includes('--reject')) {
      console.log('\n[Review] Rejected. Rolling back changes...');
      try {
        execSync('git checkout -- .', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        execSync('git clean -fd', { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
        const evolDir = getEvolutionDir();
        const sp = path.join(evolDir, 'evolution_solidify_state.json');
        if (fs.existsSync(sp)) {
          const s = readJsonSafe(sp);
          if (s && s.last_run) {
            s.last_solidify = { run_id: s.last_run.run_id, rejected: true, timestamp: new Date().toISOString() };
            const tmpReject = `${sp}.tmp`;
            fs.writeFileSync(tmpReject, JSON.stringify(s, null, 2) + '\n', 'utf8');
            fs.renameSync(tmpReject, sp);
          }
        }
        console.log('[Review] Changes rolled back.');
      } catch (e) {
        console.error('[Review] Rollback failed:', e.message || e);
        process.exit(2);
      }
    } else {
      console.log('\nTo approve and solidify:  node index.js review --approve');
      console.log('To reject and rollback:   node index.js review --reject');
    }

  } else if (command === 'fetch') {
    let skillId = null;
    const eqFlag = args.find(a => typeof a === 'string' && (a.startsWith('--skill=') || a.startsWith('-s=')));
    if (eqFlag) {
      skillId = eqFlag.split('=').slice(1).join('=');
    } else {
      const sIdx = args.indexOf('-s');
      const longIdx = args.indexOf('--skill');
      const flagIdx = sIdx !== -1 ? sIdx : longIdx;
      if (flagIdx !== -1 && args[flagIdx + 1] && !String(args[flagIdx + 1]).startsWith('-')) {
        skillId = args[flagIdx + 1];
      }
    }
    if (!skillId) {
      const positional = args[1];
      if (positional && !String(positional).startsWith('-')) skillId = positional;
    }

    if (!skillId) {
      console.error('Usage: evolver fetch --skill <skill_id>');
      console.error('       evolver fetch -s <skill_id>');
      process.exit(1);
    }

    const { getHubUrl, getNodeId, buildHubHeaders, sendHelloToHub, getHubNodeSecret } = require('./src/gep/a2aProtocol');

    const hubUrl = getHubUrl();
    if (!hubUrl) {
      console.error('[fetch] A2A_HUB_URL is not configured.');
      console.error('Set it via environment variable or .env file:');
      console.error('  export A2A_HUB_URL=https://evomap.ai');
      process.exit(1);
    }

    try {
      if (!getHubNodeSecret()) {
        console.log('[fetch] No node_secret found. Sending hello to Hub to register...');
        const helloResult = await sendHelloToHub();
        if (!helloResult || !helloResult.ok) {
          console.error('[fetch] Failed to register with Hub:', helloResult && helloResult.error || 'unknown');
          process.exit(1);
        }
        console.log('[fetch] Registered as ' + getNodeId());
      }

      const endpoint = hubUrl.replace(/\/+$/, '') + '/a2a/skill/store/' + encodeURIComponent(skillId) + '/download';
      const nodeId = getNodeId();

      console.log('[fetch] Downloading skill: ' + skillId);

      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: buildHubHeaders(),
        body: JSON.stringify({ sender_id: nodeId }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        let errorDetail = '';
        let errorCode = '';
        try {
          const j = JSON.parse(body);
          errorDetail = j.detail || j.message || j.error || '';
          errorCode = j.error || j.code || '';
        } catch (_) {
          errorDetail = body ? body.slice(0, 500) : '';
        }
        console.error('[fetch] Download failed (HTTP ' + resp.status + ')' + (errorCode ? ': ' + errorCode : ''));
        if (errorDetail && errorDetail !== errorCode) {
          console.error('  Detail: ' + errorDetail);
        }
        if (resp.status === 404) {
          console.error('  Skill "' + skillId + '" not found or not publicly available.');
          console.error('  Check the skill ID spelling, or browse available skills at https://evomap.ai');
        } else if (resp.status === 401 || resp.status === 403) {
          console.error('  Authentication failed. Try:');
          console.error('    1. Delete ~/.evomap/node_secret and retry');
          console.error('    2. Re-register: set A2A_NODE_ID and run fetch again');
        } else if (resp.status === 402) {
          console.error('  Insufficient credits. Check your balance at https://evomap.ai');
        } else if (resp.status >= 500) {
          console.error('  Server error. The Hub may be temporarily unavailable.');
          console.error('  Try again in a few minutes. If the issue persists, report at:');
          console.error('    https://github.com/autogame-17/evolver/issues');
        }
        if (isVerbose) {
          console.error('[Verbose] Endpoint: ' + endpoint);
          console.error('[Verbose] Status: ' + resp.status + ' ' + (resp.statusText || ''));
          console.error('[Verbose] Response body: ' + (body || '(empty)').slice(0, 2000));
        }
        process.exit(1);
      }

      const data = await resp.json();
      const outFlag = args.find(a => typeof a === 'string' && a.startsWith('--out='));
      const safeId = String(data.skill_id || skillId).replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const outDir = outFlag
        ? outFlag.slice('--out='.length)
        : path.join('.', 'skills', safeId);

      if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

      if (data.content) {
        fs.writeFileSync(path.join(outDir, 'SKILL.md'), data.content, 'utf8');
      }

      const bundled = Array.isArray(data.bundled_files) ? data.bundled_files : [];
      for (const file of bundled) {
        if (!file || !file.name || typeof file.content !== 'string') continue;
        const safeName = path.basename(file.name);
        fs.writeFileSync(path.join(outDir, safeName), file.content, 'utf8');
      }

      console.log('[fetch] Skill downloaded to: ' + outDir);
      console.log('  Name:    ' + (data.name || skillId));
      console.log('  Version: ' + (data.version || '?'));
      console.log('  Files:   SKILL.md' + (bundled.length > 0 ? ', ' + bundled.map(f => f.name).join(', ') : ''));
      if (data.already_purchased) {
        console.log('  Cost:    free (already purchased)');
      } else {
        console.log('  Cost:    ' + (data.credit_cost || 0) + ' credits');
      }
    } catch (error) {
      if (error && error.name === 'TimeoutError') {
        console.error('[fetch] Request timed out (30s). Check your network and A2A_HUB_URL.');
        console.error('  Hub URL: ' + hubUrl);
      } else {
        console.error('[fetch] Error: ' + (error && error.message || error));
        if (error && error.cause) console.error('  Cause: ' + (error.cause.message || error.cause.code || error.cause));
        if (isVerbose && error && error.stack) console.error('[Verbose] Stack:\n' + error.stack);
      }
      process.exit(1);
    }

  } else if (command === 'asset-log') {
    const { summarizeCallLog, readCallLog, getLogPath } = require('./src/gep/assetCallLog');

    const runIdFlag = args.find(a => typeof a === 'string' && a.startsWith('--run='));
    const actionFlag = args.find(a => typeof a === 'string' && a.startsWith('--action='));
    const lastFlag = args.find(a => typeof a === 'string' && a.startsWith('--last='));
    const sinceFlag = args.find(a => typeof a === 'string' && a.startsWith('--since='));
    const jsonMode = args.includes('--json');

    const opts = {};
    if (runIdFlag) opts.run_id = runIdFlag.slice('--run='.length);
    if (actionFlag) opts.action = actionFlag.slice('--action='.length);
    if (lastFlag) opts.last = parseInt(lastFlag.slice('--last='.length), 10);
    if (sinceFlag) opts.since = sinceFlag.slice('--since='.length);

    if (jsonMode) {
      const entries = readCallLog(opts);
      console.log(JSON.stringify(entries, null, 2));
    } else {
      const summary = summarizeCallLog(opts);
      console.log(`\n[Asset Call Log] ${getLogPath()}`);
      console.log(`  Total entries: ${summary.total_entries}`);
      console.log(`  Unique assets: ${summary.unique_assets}`);
      console.log(`  Unique runs:   ${summary.unique_runs}`);
      console.log(`  By action:`);
      for (const [action, count] of Object.entries(summary.by_action)) {
        console.log(`    ${action}: ${count}`);
      }
      if (summary.entries.length > 0) {
        console.log(`\n  Recent entries:`);
        const show = summary.entries.slice(-10);
        for (const e of show) {
          const ts = e.timestamp ? e.timestamp.slice(0, 19) : '?';
          const assetShort = e.asset_id ? e.asset_id.slice(0, 20) + '...' : '(none)';
          const sigPreview = Array.isArray(e.signals) ? e.signals.slice(0, 3).join(', ') : '';
          console.log(`    [${ts}] ${e.action || '?'}  asset=${assetShort}  score=${e.score || '-'}  mode=${e.mode || '-'}  signals=[${sigPreview}]  run=${e.run_id || '-'}`);
        }
      } else {
        console.log('\n  No entries found.');
      }
      console.log('');
    }

  } else if (command === 'setup-hooks') {
    const { setupHooks } = require('./src/adapters/hookAdapter');

    const platformFlag = args.find(a => typeof a === 'string' && a.startsWith('--platform='));
    const platform = platformFlag ? platformFlag.slice('--platform='.length) : undefined;
    const force = args.includes('--force');
    const uninstall = args.includes('--uninstall');

    try {
      const result = await setupHooks({
        platform,
        cwd: process.cwd(),
        force,
        uninstall,
        evolverRoot: __dirname,
      });
      if (result && result.ok) {
        if (!uninstall && result.files) {
          console.log('\n[setup-hooks] Files created/updated:');
          for (const f of result.files) {
            console.log('  ' + f);
          }
        }
        process.exit(0);
      } else {
        console.error('[setup-hooks] Failed: ' + (result && result.error || 'unknown'));
        process.exit(1);
      }
    } catch (error) {
      console.error('[setup-hooks] Error:', error && error.message || error);
      process.exit(1);
    }

  } else {
    console.log(`Usage: node index.js [run|/evolve|solidify|review|distill|fetch|asset-log|setup-hooks] [--loop]
  - fetch flags:
    - --skill=<id> | -s <id>   (skill ID to download)
    - --out=<dir>              (output directory, default: ./skills/<skill_id>)
  - solidify flags:
    - --dry-run
    - --no-rollback
    - --intent=repair|optimize|innovate
    - --summary=...
  - review flags:
    - --approve                (approve and solidify the pending changes)
    - --reject                 (reject and rollback the pending changes)
  - distill flags:
    - --response-file=<path>  (LLM response file for skill distillation)
  - setup-hooks flags:
    - --platform=cursor|claude-code|codex  (auto-detect if omitted)
    - --force                              (overwrite existing config)
    - --uninstall                          (remove evolver hooks)
  - asset-log flags:
    - --run=<run_id>           (filter by run ID)
    - --action=<action>        (filter: hub_search_hit, hub_search_miss, asset_reuse, asset_reference, asset_publish, asset_publish_skip)
    - --last=<N>               (show last N entries)
    - --since=<ISO_date>       (entries after date)
    - --json                   (raw JSON output)`);
  }
}

if (require.main === module) {
  main().catch(function (err) {
    console.error('[FATAL] Top-level error:', err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  readJsonSafe,
  rejectPendingRun,
  isPendingSolidify,
};
