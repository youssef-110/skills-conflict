'use strict';
// Finds every skill, slash command and subagent the current Claude Code session can use.
//
// Sources, in priority order (earlier wins when two entries share an id):
//   1. project   <cwd and parents>/.claude/{skills,commands,agents}
//   2. user      ~/.claude/{skills,commands,agents}
//   3. plugins   enabled entries of ~/.claude/plugins/installed_plugins.json
//   4. desktop   plugins synced by the Claude desktop app (only inside desktop sessions)
//   5. builtin   skills bundled with Claude Code itself (data/builtin.json)
//
// Only the locations Claude Code actually loads are read. Marketplace checkouts, old cache
// versions and .trash folders are skipped so uninstalled plugins never get recommended.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { parseFrontmatter } = require('./frontmatter');

const MAX_DESC = 1200;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function ls(p) { try { return fs.readdirSync(p); } catch { return []; } }
function mtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function readEntry(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const { data, body } = parseFrontmatter(src);
  let description = data.description || '';
  if (!description) {
    // fall back to the first prose paragraph so un-annotated files still get indexed
    const para = body.split(/\r?\n\s*\r?\n/).map((s) => s.replace(/^#+.*$/gm, '').trim()).find((s) => s.length > 20);
    description = para || '';
  }
  description = description.replace(/\s+/g, ' ').trim().slice(0, MAX_DESC);
  return {
    name: (data.name || '').trim(),
    description,
    whenToUse: (data['when_to_use'] || data['when-to-use'] || '').slice(0, 600),
    modelInvocable: !/^(true|yes)$/i.test(String(data['disable-model-invocation'] || '')),
  };
}

// Claude Code invokes a skill by its folder name; a different `name:` in the frontmatter is
// shown as an alias ("redesign-skill (redesign-existing-projects)"). Both are kept so the
// router can match either and always tells Claude the invocable one.
function skillEntry(e, dirName, { plugin, prefix, source, priority, path: file }) {
  const fmName = e.name && e.name !== dirName ? e.name : null;
  return {
    ...e,
    id: prefix + dirName,
    name: fmName ? `${dirName} ${fmName}` : dirName,
    aliases: fmName ? [prefix + fmName] : undefined,
    kind: 'skill', plugin, source, priority, path: file,
  };
}

// Recursively collect SKILL.md files below a skills/ directory (some plugins nest them).
function findSkillFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  for (const name of ls(dir)) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (name === 'SKILL.md' && isFile(p)) out.push(p);
    else if (isDir(p)) findSkillFiles(p, depth + 1, out);
  }
  return out;
}

function mdFiles(dir, depth = 0, out = []) {
  if (depth > 2) return out;
  for (const name of ls(dir)) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    if (name.toLowerCase().endsWith('.md') && name.toLowerCase() !== 'readme.md' && isFile(p)) out.push(p);
    else if (isDir(p)) mdFiles(p, depth + 1, out);
  }
  return out;
}

// Collects skills/commands/agents from a root that has skills/, commands/, agents/ folders.
function collectRoot(root, { plugin = null, source, priority, skipSkillDirs = [] }) {
  const out = [];
  const prefix = plugin ? plugin + ':' : '';
  const skillsDir = path.join(root, 'skills');
  for (const file of findSkillFiles(skillsDir)) {
    const rel = path.relative(skillsDir, file);
    if (skipSkillDirs.some((s) => rel.startsWith(s + path.sep))) continue;
    const e = readEntry(file);
    if (!e) continue;
    const dirName = path.basename(path.dirname(file));
    out.push(skillEntry(e, dirName, { plugin, prefix, source, priority, path: file }));
  }
  for (const [sub, kind] of [['commands', 'command'], ['agents', 'agent']]) {
    const dir = path.join(root, sub);
    for (const file of mdFiles(dir)) {
      const e = readEntry(file);
      if (!e) continue;
      const rel = path.relative(dir, file).replace(/\.md$/i, '').split(path.sep);
      const base = kind === 'agent' && e.name ? e.name : rel.join(':');
      out.push({ id: prefix + base, name: base, kind, plugin, source, priority, path: file, ...e, name: base });
    }
  }
  return out;
}

function pluginName(root, fallback) {
  const pj = readJSON(path.join(root, '.claude-plugin', 'plugin.json'));
  return (pj && pj.name) || fallback;
}

function enabledPluginKeys(cwd) {
  const files = [
    path.join(claudeDir(), 'settings.json'),
    path.join(claudeDir(), 'settings.local.json'),
  ];
  for (const dir of ancestors(cwd)) {
    files.push(path.join(dir, '.claude', 'settings.json'), path.join(dir, '.claude', 'settings.local.json'));
  }
  const enabled = new Map();
  for (const f of files) {
    const s = readJSON(f);
    if (s && s.enabledPlugins) for (const [k, v] of Object.entries(s.enabledPlugins)) enabled.set(k, !!v);
  }
  return enabled;
}

function ancestors(start) {
  const out = [];
  let dir = path.resolve(start || process.cwd());
  const home = path.resolve(os.homedir());
  for (let i = 0; i < 12; i++) {
    if (dir !== home) out.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function cliPlugins(cwd) {
  const out = [];
  const installed = readJSON(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  if (!installed || !installed.plugins) return out;
  const enabled = enabledPluginKeys(cwd);
  for (const [key, installs] of Object.entries(installed.plugins)) {
    if (enabled.get(key) === false) continue;
    if (!enabled.has(key)) continue; // installed but never enabled
    const list = Array.isArray(installs) ? installs : [installs];
    const inst = list.filter((x) => x && x.installPath && isDir(x.installPath)).pop();
    if (!inst) continue;
    const name = pluginName(inst.installPath, key.split('@')[0]);
    out.push(...collectRoot(inst.installPath, { plugin: name, source: 'plugin', priority: 3 }));
  }
  return out;
}

function desktopBases() {
  const home = os.homedir();
  const bases = [];
  if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'Claude'));
  if (process.env.LOCALAPPDATA) {
    const pk = path.join(process.env.LOCALAPPDATA, 'Packages');
    for (const n of ls(pk)) if (/^Claude_/i.test(n)) bases.push(path.join(pk, n, 'LocalCache', 'Roaming', 'Claude'));
  }
  bases.push(path.join(home, 'Library', 'Application Support', 'Claude'));
  bases.push(path.join(home, '.config', 'Claude'));
  return bases.filter(isDir);
}

function inDesktopSession(config) {
  const mode = config.desktopPlugins || 'auto';
  if (mode === true || mode === 'always') return true;
  if (mode === false || mode === 'never') return false;
  return /desktop/i.test(process.env.CLAUDE_CODE_ENTRYPOINT || '');
}

function desktopPlugins() {
  const out = [];
  const acct = process.env.CLAUDE_CODE_ACCOUNT_UUID;
  const org = process.env.CLAUDE_CODE_ORGANIZATION_UUID;
  const roots = [];
  for (const base of desktopBases()) {
    const sessions = path.join(base, 'local-agent-mode-sessions');
    for (const a of ls(sessions)) {
      if (a === 'skills-plugin') {
        for (const o of ls(path.join(sessions, a))) {
          if (org && o !== org) continue;
          for (const b of ls(path.join(sessions, a, o))) roots.push(path.join(sessions, a, o, b));
        }
        continue;
      }
      if (acct && a !== acct) continue;
      for (const o of ls(path.join(sessions, a))) {
        if (org && o !== org) continue;
        const rpm = path.join(sessions, a, o, 'rpm');
        for (const p of ls(rpm)) if (isDir(path.join(rpm, p))) roots.push(path.join(rpm, p));
      }
    }
  }
  // ~/.claude/plugins/synced/<bucket>/<id>[~gN]: keep only the live generation of each id
  const synced = path.join(claudeDir(), 'plugins', 'synced');
  for (const bucket of ls(synced)) {
    const dir = path.join(synced, bucket);
    const best = new Map();
    for (const n of ls(dir)) {
      const p = path.join(dir, n);
      if (!isDir(p)) continue;
      const m = /^(.*?)(?:~g(\d+))?$/.exec(n);
      const score = (isFile(path.join(p, '.in_use')) ? 1e6 : 0) + Number(m[2] || 0);
      const prev = best.get(m[1]);
      if (!prev || score > prev.score) best.set(m[1], { p, score });
    }
    for (const { p } of best.values()) roots.push(p);
  }
  const seen = new Set();
  for (const root of roots) {
    if (!isFile(path.join(root, '.claude-plugin', 'plugin.json'))) continue;
    const name = pluginName(root, path.basename(root));
    if (seen.has(name)) continue; // rpm copy wins over synced copy of the same plugin
    seen.add(name);
    out.push(...collectRoot(root, { plugin: name, source: 'desktop', priority: 4 }));
  }
  return out;
}

function userEntries() {
  const dir = claudeDir();
  const out = [];
  const skills = path.join(dir, 'skills');
  for (const n of ls(skills)) {
    const p = path.join(skills, n);
    if (!isDir(p) || n.startsWith('.')) continue;
    if (isFile(path.join(p, '.claude-plugin', 'plugin.json'))) {
      // `claude plugin init` scaffolds plugins here; they load as <name>@skills-dir
      out.push(...collectRoot(p, { plugin: pluginName(p, n), source: 'plugin', priority: 3 }));
    } else if (isFile(path.join(p, 'SKILL.md'))) {
      const e = readEntry(path.join(p, 'SKILL.md'));
      if (e) out.push(skillEntry(e, n, { plugin: null, prefix: '', source: 'user', priority: 2, path: path.join(p, 'SKILL.md') }));
    } else if (n === 'synced') {
      // claude.ai-synced skills; usually duplicates of the anthropic-skills plugin
      for (const f of findSkillFiles(p)) {
        const e = readEntry(f);
        if (e) {
          out.push(skillEntry(e, path.basename(path.dirname(f)), { plugin: null, prefix: '', source: 'synced', priority: 5, path: f }));
        }
      }
    }
  }
  out.push(...collectRoot(dir, { source: 'user', priority: 2, skipSkillDirs: ls(skills) }).filter((e) => e.kind !== 'skill'));
  return out;
}

function projectEntries(cwd) {
  const out = [];
  for (const dir of ancestors(cwd)) {
    const root = path.join(dir, '.claude');
    if (isDir(root)) out.push(...collectRoot(root, { source: 'project', priority: 1 }));
  }
  return out;
}

function builtinEntries() {
  const data = readJSON(path.join(__dirname, '..', '..', 'data', 'builtin.json')) || [];
  return data.map((b) => ({ ...b, id: b.name, plugin: null, source: 'builtin', priority: 6, path: null, modelInvocable: true }));
}

function descKey(e) {
  return crypto.createHash('sha1').update(e.name + '|' + e.description.slice(0, 200)).digest('hex').slice(0, 12);
}

function discover({ cwd = process.cwd(), config = {} } = {}) {
  const all = [
    ...projectEntries(cwd),
    ...userEntries(),
    ...cliPlugins(cwd),
    ...(inDesktopSession(config) ? desktopPlugins() : []),
    ...builtinEntries(),
  ];
  // Dedupe: same id -> keep highest priority. Identical name+description under different ids
  // (e.g. a synced copy of a plugin skill) -> keep the plugin-qualified one, record the alias.
  all.sort((a, b) => a.priority - b.priority);
  const byId = new Map();
  for (const e of all) if (!byId.has(e.id)) byId.set(e.id, e);
  const byDesc = new Map();
  const result = [];
  for (const e of byId.values()) {
    if (e.kind !== 'skill' || !e.description) { result.push(e); continue; }
    const k = descKey(e);
    const prev = byDesc.get(k);
    if (prev) {
      const keepNew = prev.source === 'synced' && e.source !== 'synced';
      const [keep, drop] = keepNew ? [e, prev] : [prev, e];
      keep.aliases = [...(keep.aliases || []), drop.id, ...(drop.aliases || [])];
      if (keepNew) { result[result.indexOf(prev)] = e; byDesc.set(k, e); }
      continue;
    }
    byDesc.set(k, e);
    result.push(e);
  }
  const ignore = new Set((config.ignore || []).map((s) => s.toLowerCase()));
  return result.filter((e) => e.description && !ignore.has(e.id.toLowerCase()) && !ignore.has((e.plugin || '').toLowerCase()));
}

// Cheap fingerprint of every location discover() reads; used to decide when to re-index.
function fingerprint({ cwd = process.cwd(), config = {} } = {}) {
  const dir = claudeDir();
  const parts = [
    mtime(path.join(dir, 'skills')),
    mtime(path.join(dir, 'commands')),
    mtime(path.join(dir, 'agents')),
    mtime(path.join(dir, 'plugins', 'installed_plugins.json')),
    mtime(path.join(dir, 'settings.json')),
    mtime(path.join(dir, 'plugins', 'synced')),
    inDesktopSession(config) ? 'd' : 'c',
    JSON.stringify(config.ignore || []),
  ];
  for (const n of ls(path.join(dir, 'skills'))) parts.push(mtime(path.join(dir, 'skills', n)));
  for (const a of ancestors(cwd)) {
    const r = path.join(a, '.claude');
    if (isDir(r)) parts.push(a, mtime(path.join(r, 'skills')), mtime(path.join(r, 'commands')), mtime(path.join(r, 'agents')), mtime(path.join(r, 'settings.json')));
  }
  if (inDesktopSession(config)) for (const b of desktopBases()) parts.push(mtime(path.join(b, 'local-agent-mode-sessions')));
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
}

module.exports = { discover, fingerprint, claudeDir, readJSON, ancestors };
