'use strict';

// OMLS-inspired idle scheduler: detects user inactivity windows and recommends
// evolution intensity levels. Monitors system idle time on supported platforms.
// When idle, the evolver can run more aggressive operations (distillation,
// reflection); when busy, it only collects signals.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getEvolutionDir } = require('./paths');

const IDLE_THRESHOLD_SECONDS = parseInt(process.env.OMLS_IDLE_THRESHOLD || '300', 10) || 300;
const DEEP_IDLE_THRESHOLD_SECONDS = parseInt(process.env.OMLS_DEEP_IDLE_THRESHOLD || '1800', 10) || 1800;

function getSystemIdleSeconds() {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      const psCode = [
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }',
        'public class IdleTime {',
        '  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);',
        '  public static uint Get() {',
        '    LASTINPUTINFO lii = new LASTINPUTINFO();',
        '    lii.cbSize = (uint)Marshal.SizeOf(lii);',
        '    GetLastInputInfo(ref lii);',
        '    return ((uint)Environment.TickCount - lii.dwTime) / 1000;',
        '  }',
        '}',
        '"@',
        '[IdleTime]::Get()',
      ].join('\n');
      const tmpPs = path.join(require('os').tmpdir(), 'evolver_idle_check.ps1');
      require('fs').writeFileSync(tmpPs, psCode, 'utf8');
      const result = execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + tmpPs + '"', { timeout: 10000, encoding: 'utf8' }).trim();
      try { require('fs').unlinkSync(tmpPs); } catch (e) {}
      const seconds = parseInt(result, 10);
      return Number.isFinite(seconds) ? seconds : -1;
    } else if (platform === 'darwin') {
      const result = execSync('ioreg -c IOHIDSystem | grep HIDIdleTime', { timeout: 5000, encoding: 'utf8' });
      const match = result.match(/(\d+)/);
      if (match) {
        return Math.floor(parseInt(match[1], 10) / 1000000000);
      }
    } else if (platform === 'linux') {
      try {
        const result = execSync('xprintidle 2>/dev/null || echo -1', { timeout: 5000, encoding: 'utf8' }).trim();
        const ms = parseInt(result, 10);
        if (Number.isFinite(ms) && ms >= 0) return Math.floor(ms / 1000);
      } catch (e) {}
    }
  } catch (e) {}
  return -1;
}

// Intensity levels:
//   'signal_only'  - only collect signals, minimal CPU
//   'normal'       - standard evolution cycle
//   'aggressive'   - run distillation, reflection, deeper analysis
//   'deep'         - extended operations (future: RL, fine-tuning triggers)
function determineIntensity(idleSeconds) {
  if (idleSeconds < 0) return 'normal';
  if (idleSeconds >= DEEP_IDLE_THRESHOLD_SECONDS) return 'deep';
  if (idleSeconds >= IDLE_THRESHOLD_SECONDS) return 'aggressive';
  return 'normal';
}

function readScheduleState() {
  const statePath = path.join(getEvolutionDir(), 'idle_schedule_state.json');
  try {
    if (!fs.existsSync(statePath)) return {};
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function writeScheduleState(state) {
  const dir = getEvolutionDir();
  const statePath = path.join(dir, 'idle_schedule_state.json');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, statePath);
  } catch (e) {}
}

// Returns scheduling recommendation with sleep multiplier and action hints.
function getScheduleRecommendation() {
  const enabled = String(process.env.OMLS_ENABLED || 'true').toLowerCase() !== 'false';
  if (!enabled) {
    return {
      enabled: false,
      idle_seconds: -1,
      intensity: 'normal',
      sleep_multiplier: 1,
      should_distill: false,
      should_reflect: false,
      should_deep_evolve: false,
    };
  }

  const idleSeconds = getSystemIdleSeconds();
  const intensity = determineIntensity(idleSeconds);

  const state = readScheduleState();
  const now = Date.now();

  let sleepMultiplier = 1;
  let shouldDistill = false;
  let shouldReflect = false;
  let shouldDeepEvolve = false;

  if (intensity === 'aggressive') {
    sleepMultiplier = 0.5;
    shouldDistill = true;
    shouldReflect = true;
  } else if (intensity === 'deep') {
    sleepMultiplier = 0.25;
    shouldDistill = true;
    shouldReflect = true;
    shouldDeepEvolve = true;
  } else if (intensity === 'signal_only') {
    sleepMultiplier = 3;
  }

  state.last_check = new Date().toISOString();
  state.last_idle_seconds = idleSeconds;
  state.last_intensity = intensity;
  writeScheduleState(state);

  return {
    enabled: true,
    idle_seconds: idleSeconds,
    intensity: intensity,
    sleep_multiplier: sleepMultiplier,
    should_distill: shouldDistill,
    should_reflect: shouldReflect,
    should_deep_evolve: shouldDeepEvolve,
  };
}

module.exports = {
  getSystemIdleSeconds: getSystemIdleSeconds,
  determineIntensity: determineIntensity,
  getScheduleRecommendation: getScheduleRecommendation,
  readScheduleState: readScheduleState,
  writeScheduleState: writeScheduleState,
  IDLE_THRESHOLD_SECONDS: IDLE_THRESHOLD_SECONDS,
  DEEP_IDLE_THRESHOLD_SECONDS: DEEP_IDLE_THRESHOLD_SECONDS,
};
