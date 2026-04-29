'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_SETTINGS_DIR = path.join(os.homedir(), '.evolver');
const SETTINGS_DIR = DEFAULT_SETTINGS_DIR;
const SETTINGS_FILE = path.join(DEFAULT_SETTINGS_DIR, 'settings.json');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function resolveSettingsDir() {
  return process.env.EVOLVER_SETTINGS_DIR || DEFAULT_SETTINGS_DIR;
}

function resolveSettingsFile() {
  return path.join(resolveSettingsDir(), 'settings.json');
}

function ensureSettingsDir() {
  const settingsDir = resolveSettingsDir();
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true, mode: DIR_MODE });
    return;
  }
  try { fs.chmodSync(settingsDir, DIR_MODE); } catch {}
}

function writeSettingsFile(data) {
  ensureSettingsDir();
  const settingsFile = resolveSettingsFile();
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, settingsFile);
  try { fs.chmodSync(settingsFile, FILE_MODE); } catch {}
}

function readSettings() {
  try {
    const settingsFile = resolveSettingsFile();
    if (fs.existsSync(settingsFile)) {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {}
  return {};
}

function writeSettings(data) {
  const current = readSettings();
  const merged = { ...current, ...data };
  writeSettingsFile(merged);
  return merged;
}

function clearSettings() {
  try {
    const settingsFile = resolveSettingsFile();
    if (fs.existsSync(settingsFile)) {
      const current = readSettings();
      delete current.proxy;
      writeSettingsFile(current);
    }
  } catch {}
}

function isStaleProxy() {
  const settings = readSettings();
  const pid = settings.proxy?.pid;
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

function clearIfStale() {
  if (isStaleProxy()) {
    clearSettings();
    return true;
  }
  return false;
}

function getProxyUrl() {
  const settings = readSettings();
  return settings.proxy?.url || null;
}

function getProxyAuthToken() {
  const settings = readSettings();
  return settings.proxy?.auth_token || null;
}

function getProxyRequestHeaders() {
  const token = getProxyAuthToken();
  if (!token) return {};
  return { 'x-evomap-proxy-token': token };
}

function createProxyAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = {
  readSettings,
  writeSettings,
  clearSettings,
  clearIfStale,
  isStaleProxy,
  getProxyUrl,
  getProxyAuthToken,
  getProxyRequestHeaders,
  createProxyAuthToken,
  resolveSettingsDir,
  resolveSettingsFile,
  SETTINGS_DIR,
  SETTINGS_FILE,
};
