'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SKILL_UPDATE_BYTES = 512 * 1024;
const ALLOW_UNSIGNED_SKILL_UPDATE =
  String(process.env.EVOMAP_ALLOW_UNSIGNED_SKILL_UPDATE || '').toLowerCase() === 'true';

function verifyPayloadHash(content, expectedHash) {
  if (!expectedHash) return ALLOW_UNSIGNED_SKILL_UPDATE;
  const actual = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  return actual === String(expectedHash).toLowerCase();
}

class SkillUpdater {
  constructor({ store, skillPath, logger } = {}) {
    this.store = store;
    this.skillPath = skillPath || null;
    this.logger = logger || console;
  }

  setSkillPath(filePath) {
    this.skillPath = filePath;
  }

  processSkillUpdate(message) {
    if (!this.skillPath) {
      this.logger.warn('[skill-updater] No skill path configured, skipping update');
      return false;
    }

    const payload = message.payload || message;
    const content = payload.content || payload.skill_content;

    if (!content || typeof content !== 'string') {
      this.logger.warn('[skill-updater] No content in skill_update message');
      return false;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_UPDATE_BYTES) {
      this.logger.warn('[skill-updater] skill_update content too large');
      return false;
    }
    if (!verifyPayloadHash(content, payload.sha256 || payload.content_sha256)) {
      this.logger.warn('[skill-updater] skill_update missing hash or hash mismatch');
      return false;
    }

    try {
      const dir = path.dirname(this.skillPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      if (fs.existsSync(this.skillPath)) {
        const backupPath = this.skillPath + '.bak';
        fs.copyFileSync(this.skillPath, backupPath);
      }

      const tmpPath = this.skillPath + '.tmp';
      fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, this.skillPath);
      try { fs.chmodSync(this.skillPath, 0o600); } catch {}
      this.store.setState('last_skill_update', new Date().toISOString());
      this.store.setState('skill_version', payload.version || 'unknown');
      this.logger.log(`[skill-updater] Updated skill.md (version: ${payload.version || 'unknown'})`);
      return true;
    } catch (err) {
      this.logger.error(`[skill-updater] Failed to update: ${err.message}`);
      return false;
    }
  }

  pollAndApply() {
    const updates = this.store.poll({ type: 'skill_update' });
    let applied = 0;
    for (const msg of updates) {
      if (this.processSkillUpdate(msg)) {
        this.store.ack(msg.id);
        applied++;
      }
    }
    return applied;
  }
}

module.exports = { SkillUpdater };
