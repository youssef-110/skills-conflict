'use strict';
// Persistent state under ~/.claude/skill-router/: config, cached index, usage stats.

const fs = require('fs');
const path = require('path');
const { claudeDir } = require('./discover');

const DEFAULT_CONFIG = {
  enabled: true,
  // below this router confidence (0..1) nothing is injected into the conversation
  minConfidence: 0.3,
  // at or above this the picks are given as a directive instead of a shortlist
  strongConfidence: 0.5,
  // how many skills to recommend at most (primary + complementary)
  maxPicks: 3,
  // cosine similarity above which two candidate skills count as doing the same job
  overlapThreshold: 0.28,
  // include agents (subagent types) and slash commands as candidates
  includeAgents: true,
  includeCommands: true,
  // "auto" = include Claude desktop-synced plugins only inside desktop sessions
  desktopPlugins: 'auto',
  // ids or plugin names the router must never suggest
  ignore: [],
  // ids that win ties inside an overlap group; earlier entries beat later ones
  prefer: [],
  // ids that should only be picked when nothing else fits
  avoid: [],
  // re-scan installed skills at least this often even if nothing looks changed
  maxIndexAgeHours: 12,
};

function dataDir() {
  const dir = process.env.SKILL_ROUTER_HOME || path.join(claudeDir(), 'skill-router');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  const user = readJSON(path.join(dataDir(), 'config.json'), {});
  return { ...DEFAULT_CONFIG, ...user };
}

function saveConfig(cfg) {
  const out = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_CONFIG[k])) out[k] = v;
  }
  fs.writeFileSync(path.join(dataDir(), 'config.json'), JSON.stringify(out, null, 2) + '\n');
}

function loadUsage() { return readJSON(path.join(dataDir(), 'usage.json'), { counts: {}, total: 0 }); }

function recordUsage(id) {
  if (!id) return;
  const file = path.join(dataDir(), 'usage.json');
  const u = loadUsage();
  u.counts[id] = (u.counts[id] || 0) + 1;
  u.total = (u.total || 0) + 1;
  u.updatedAt = new Date().toISOString();
  try { writeJSON(file, u); } catch {}
}

module.exports = { DEFAULT_CONFIG, dataDir, readJSON, writeJSON, loadConfig, saveConfig, loadUsage, recordUsage };
