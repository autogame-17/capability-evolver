const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getRepoRoot } = require('./gep/paths');

const MAX_EXEC_BUFFER = 10 * 1024 * 1024;
const FORCE_UPDATE_ENABLED = String(process.env.EVOLVER_ENABLE_FORCE_UPDATE || '').toLowerCase() === 'true';

// Force Update: triggered by Hub when version is critically outdated.
// Extracted from src/evolve.js so both the evolve main loop and heartbeat
// thread can trigger it independently (heartbeat-only workers need this
// because they never reach the evolve run() loop that consumes the pending
// force_update directive).
function executeForceUpdate(forceUpdate) {
  const REPO_ROOT = getRepoRoot();
  const requiredVersion = String(forceUpdate.required_version || '').replace(/^>=/, '');
  console.log('[ForceUpdate] Starting multi-channel update (target: >=' + requiredVersion + ')');

  if (!FORCE_UPDATE_ENABLED) {
    console.warn('[ForceUpdate] Automatic force update is disabled. Set EVOLVER_ENABLE_FORCE_UPDATE=true to opt in.');
    if (forceUpdate && forceUpdate.release_url) {
      console.warn('[ForceUpdate] Manual update URL: ' + forceUpdate.release_url);
    }
    return false;
  }

  function parseVer(v) {
    var m = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
  }
  function isAtLeast(current, required) {
    var c = parseVer(current), r = parseVer(required);
    for (var i = 0; i < 3; i++) {
      if (c[i] > r[i]) return true;
      if (c[i] < r[i]) return false;
    }
    return true;
  }
  function getCurrentVersion() {
    try {
      var pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
      return pkg.version || '0.0.0';
    } catch (_) { return '0.0.0'; }
  }

  // Channel 1: GitHub Release (via degit)
  try {
    console.log('[ForceUpdate] Channel 1: GitHub Release download...');
    var tmpTarget = path.resolve(REPO_ROOT, '..', '.evolver-update-tmp');
    try { fs.rmSync(tmpTarget, { recursive: true, force: true }); } catch (_) {}
    execSync('npx -y degit EvoMap/evolver ' + JSON.stringify(tmpTarget), {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000, windowsHide: true, maxBuffer: MAX_EXEC_BUFFER,
    });
    var tmpPkg = JSON.parse(fs.readFileSync(path.join(tmpTarget, 'package.json'), 'utf8'));
    if (tmpPkg.version && isAtLeast(tmpPkg.version, requiredVersion)) {
      var entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
      for (var ei = 0; ei < entries.length; ei++) {
        var eName = entries[ei].name;
        if (eName === 'node_modules' || eName === 'memory' || eName === '.git' || eName === 'MEMORY.md') continue;
        try { fs.rmSync(path.join(REPO_ROOT, eName), { recursive: true, force: true }); } catch (_) {}
      }
      var newEntries = fs.readdirSync(tmpTarget, { withFileTypes: true });
      for (var ni = 0; ni < newEntries.length; ni++) {
        var src = path.join(tmpTarget, newEntries[ni].name);
        var dst = path.join(REPO_ROOT, newEntries[ni].name);
        fs.cpSync(src, dst, { recursive: true });
      }
      try { fs.rmSync(tmpTarget, { recursive: true, force: true }); } catch (_) {}
      console.log('[ForceUpdate] GitHub Release update successful: ' + tmpPkg.version);
      return true;
    }
    try { fs.rmSync(tmpTarget, { recursive: true, force: true }); } catch (_) {}
  } catch (e) {
    console.warn('[ForceUpdate] GitHub Release failed:', e && e.message || e);
    try { fs.rmSync(path.resolve(REPO_ROOT, '..', '.evolver-update-tmp'), { recursive: true, force: true }); } catch (_) {}
  }

  // Channel 2: npm
  try {
    console.log('[ForceUpdate] Channel 2: npm install...');
    var npmCmd = 'npm install -g @evomap/evolver@latest';
    execSync(npmCmd, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000, windowsHide: true, maxBuffer: MAX_EXEC_BUFFER,
    });
    var newVerNpm = getCurrentVersion();
    if (isAtLeast(newVerNpm, requiredVersion)) {
      console.log('[ForceUpdate] npm update successful: ' + newVerNpm);
      return true;
    }
  } catch (e) {
    console.warn('[ForceUpdate] npm failed:', e && e.message || e);
  }

  // Channel 3: GitHub release (manual download URL only)
  try {
    var releaseUrl = forceUpdate.release_url;
    if (releaseUrl) {
      console.log('[ForceUpdate] Channel 3: GitHub release -- manual download required');
      console.log('[ForceUpdate] Visit: ' + releaseUrl);
    }
  } catch (_) {}

  console.warn('[ForceUpdate] All automatic channels exhausted. Current version: ' + getCurrentVersion());
  return false;
}

module.exports = { executeForceUpdate };
