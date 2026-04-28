'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SETTINGS_DIR = path.join(os.homedir(), '.evolver');
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json');
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function ensureSettingsDir() {
  if (!fs.existsSync(SETTINGS_DIR)) {
    fs.mkdirSync(SETTINGS_DIR, { recursive: true, mode: DIR_MODE });
    return;
  }
  try { fs.chmodSync(SETTINGS_DIR, DIR_MODE); } catch {}
}

function writeSettingsFile(data) {
  ensureSettingsDir();
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: FILE_MODE });
  fs.renameSync(tmp, SETTINGS_FILE);
  try { fs.chmodSync(SETTINGS_FILE, FILE_MODE); } catch {}
}

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
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
    if (fs.existsSync(SETTINGS_FILE)) {
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
  SETTINGS_DIR,
  SETTINGS_FILE,
};
