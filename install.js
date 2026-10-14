#!/usr/bin/env node
'use strict';
// Fallback installer for setups that do not use Claude Code plugins.
//
//   node install.js            register the hooks in ~/.claude/settings.json and link the skill
//   node install.js --uninstall
//
// The plugin install (see README) is preferred: it updates itself and needs no settings edits.
// This script backs up settings.json before changing it and only touches entries it created.

const fs = require('fs');
const path = require('path');
const os = require('os');

const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const settingsFile = path.join(claudeDir, 'settings.json');
const root = __dirname;
const MARK = 'skills-conflict';
const uninstall = process.argv.includes('--uninstall');

const node = JSON.stringify(process.execPath.replace(/\\/g, '/'));
const script = (f) => `${node} ${JSON.stringify(path.join(root, 'scripts', 'hooks', f).replace(/\\/g, '/'))} # ${MARK}`;
const wanted = {
  SessionStart: { hooks: [{ type: 'command', command: script('session-start.js'), timeout: 20 }] },
  UserPromptSubmit: { hooks: [{ type: 'command', command: script('prompt.js'), timeout: 15 }] },
  PostToolUse: { matcher: 'Skill|Agent|Task', hooks: [{ type: 'command', command: script('skill-used.js'), timeout: 5 }] },
};

let settings = {};
if (fs.existsSync(settingsFile)) {
  const raw = fs.readFileSync(settingsFile, 'utf8');
  try { settings = JSON.parse(raw); } catch (e) {
    console.error(`Could not parse ${settingsFile}: ${e.message}. Fix it first; nothing was changed.`);
    process.exit(1);
  }
  // settings.json can hold tokens in "env"; keep the backup readable by the owner only
  fs.writeFileSync(settingsFile + '.bak-skills-conflict', raw, { mode: 0o600 });
}
settings.hooks = settings.hooks || {};
for (const event of Object.keys(wanted)) {
  const groups = (settings.hooks[event] || [])
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
    .filter((g) => g.hooks.length);
  if (!uninstall) groups.push(wanted[event]);
  if (groups.length) settings.hooks[event] = groups; else delete settings.hooks[event];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');

// Make the skill-router skill available too (a copy whose CLI path points back here).
const skillDir = path.join(claudeDir, 'skills', 'skill-router');
if (uninstall) {
  if (fs.existsSync(path.join(skillDir, '.skills-conflict'))) fs.rmSync(skillDir, { recursive: true, force: true });
} else {
  fs.mkdirSync(skillDir, { recursive: true });
  const src = fs.readFileSync(path.join(root, 'skills', 'skill-router', 'SKILL.md'), 'utf8')
    .split('<path>/scripts/cli.js').join(path.join(root, 'scripts', 'cli.js').replace(/\\/g, '/'));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), src);
  fs.writeFileSync(path.join(skillDir, '.skills-conflict'), root);
}

console.log(uninstall
  ? 'skills-conflict hooks removed from settings.json (backup: settings.json.bak-skills-conflict).'
  : `skills-conflict installed: hooks added to ${settingsFile}, skill at ${skillDir}.\nStart a new Claude Code session; run "node ${path.join(root, 'scripts', 'cli.js')} doctor" to check.`);
