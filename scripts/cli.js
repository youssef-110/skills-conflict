#!/usr/bin/env node
'use strict';
// skill-router command line.
//
//   node cli.js route "<prompt>" [--json]   show what the hook would inject for a prompt
//   node cli.js audit [--threshold 0.4] [--out file.md]
//                                          list groups of installed skills that do the same job
//   node cli.js prefer <id> [<id>...]      make these win inside their overlap groups
//   node cli.js avoid <id> | ignore <id>   demote / never suggest
//   node cli.js unprefer|unavoid|unignore <id>
//   node cli.js config [key value]         show or set a config value
//   node cli.js rebuild                    force a re-scan of installed skills
//   node cli.js stats                      what was indexed, from where, top used skills
//   node cli.js doctor                     check that the hooks are wired up

const fs = require('fs');
const path = require('path');
const store = require('./lib/store');
const indexer = require('./lib/indexer');
const router = require('./lib/router');

const args = process.argv.slice(2);
const cmd = args.shift() || 'help';
const flag = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

function loadAll(force) {
  const config = store.loadConfig();
  const index = indexer.load({ config, force });
  return { config, index, usage: store.loadUsage() };
}

function cmdRoute() {
  const json = has('json');
  const prompt = args.join(' ');
  const { config, index, usage } = loadAll();
  const res = router.route(prompt, index, config, usage);
  if (json) {
    const slim = (r) => ({ id: r.doc.id, kind: r.doc.kind, score: +r.score.toFixed(2), why: router.why(r), overlapsWith: r.overlapsWith });
    console.log(JSON.stringify({ confidence: +res.confidence.toFixed(3), reason: res.reason, picks: res.picks.map(slim), skipped: res.skipped.map(slim),
      candidates: (res.candidates || []).map(slim) }, null, 2));
    return;
  }
  const ctx = router.formatContext(res, index);
  if (ctx) console.log(ctx);
  else {
    console.log(`(no injection: ${res.reason}, confidence ${Math.round(res.confidence * 100)}%)`);
    for (const c of res.candidates || []) console.log(`  candidate ${c.doc.id}  score ${c.score.toFixed(2)}  ${router.why(c)}`);
  }
}

// Groups skills whose descriptions are near-duplicates. Seed-based (not single-link) so
// groups stay tight: the skill with the most look-alikes seeds a group, and only skills that
// closely match that seed join it.
function overlapGroups(index, threshold) {
  const docs = index.docs.filter((d) => d.kind !== 'command');
  const sim = (i, j) => (docs[i].id.split(':').pop() === docs[j].id.split(':').pop() ? 1 : router.cosine(docs[i], docs[j], index));
  const neighbors = docs.map(() => []);
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (router.family(docs[i]) === router.family(docs[j])) continue; // siblings are a team
      const c = sim(i, j);
      if (c >= threshold) { neighbors[i].push([j, c]); neighbors[j].push([i, c]); }
    }
  }
  const order = docs.map((_, i) => i).sort((a, b) => neighbors[b].length - neighbors[a].length);
  const taken = new Set();
  const out = [];
  for (const seed of order) {
    if (taken.has(seed) || !neighbors[seed].length) continue;
    const members = [seed, ...neighbors[seed].filter(([j]) => !taken.has(j)).sort((a, b) => b[1] - a[1]).map(([j]) => j)]
      .slice(0, 8);
    if (members.length < 2) continue;
    members.forEach((m) => taken.add(m));
    const pairs = members.slice(1).map((j) => ({ a: docs[seed].id, b: docs[j].id, sim: sim(seed, j) }));
    out.push({ members: members.map((m) => docs[m]), pairs });
  }
  out.sort((a, b) => b.members.length - a.members.length || b.pairs[0].sim - a.pairs[0].sim);
  return out;
}

function cmdAudit() {
  const threshold = Number(flag('threshold', '0.35'));
  const outFile = flag('out', null);
  const { config, index, usage } = loadAll();
  const groups = overlapGroups(index, threshold);
  const lines = [];
  lines.push(`# Skill overlap audit`);
  lines.push('');
  lines.push(`${index.N} skills, agents and commands indexed. ${groups.length} groups of skills from different sources do the same job (similarity >= ${threshold}).`);
  lines.push(`The router already picks one per group automatically. Use \`prefer\` to choose the winner yourself, or \`ignore\` to drop one for good.`);
  lines.push('');
  const prefer = (config.prefer || []).map((s) => s.toLowerCase());
  groups.forEach((g, gi) => {
    const ranked = [...g.members].sort((a, b) => {
      const pa = prefer.indexOf(a.id.toLowerCase()), pb = prefer.indexOf(b.id.toLowerCase());
      if (pa !== pb) return (pa < 0 ? 1e9 : pa) - (pb < 0 ? 1e9 : pb);
      return (usage.counts[b.id] || 0) - (usage.counts[a.id] || 0);
    });
    const topic = topTerms(g.members, index).join(', ');
    lines.push(`## ${gi + 1}. ${topic} (${g.members.length} skills)`);
    for (const m of ranked) {
      const u = usage.counts[m.id] ? `, used ${usage.counts[m.id]}x` : '';
      const p = prefer.includes(m.id.toLowerCase()) ? ' **preferred**' : '';
      lines.push(`- \`${m.id}\` (${m.kind}, ${m.source}${u})${p}: ${m.desc.slice(0, 120)}`);
    }
    const strongest = g.pairs.sort((a, b) => b.sim - a.sim).slice(0, 3)
      .map((p) => `${p.a} ~ ${p.b} ${(p.sim * 100).toFixed(0)}%`).join('; ');
    lines.push(`  Closest pairs: ${strongest}`);
    lines.push('');
  });
  const md = lines.join('\n');
  if (outFile) { fs.writeFileSync(outFile, md); console.log(`Wrote ${outFile} (${groups.length} groups)`); }
  else console.log(md);
}

function topTerms(members, index) {
  const sum = new Map();
  for (const m of members) for (const [t, v] of Object.entries(m.tf)) {
    if (t.length < 3) continue;
    const df = index.df[t] || 1;
    sum.set(t, (sum.get(t) || 0) + v * Math.log(index.N / df));
  }
  return [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
}

function editList(key, add) {
  const cfg = store.loadConfig();
  const { index } = loadAll();
  const known = new Set(index.docs.map((d) => d.id.toLowerCase()));
  const plugins = new Set(index.docs.map((d) => (d.plugin || '').toLowerCase()));
  let list = [...(cfg[key] || [])];
  for (const raw of args) {
    const id = raw.trim();
    if (add && !known.has(id.toLowerCase()) && !(key === 'ignore' && plugins.has(id.toLowerCase()))) {
      const near = index.docs.filter((d) => d.id.toLowerCase().includes(id.toLowerCase())).slice(0, 5).map((d) => d.id);
      console.error(`Unknown id "${id}".${near.length ? ' Did you mean: ' + near.join(', ') : ''}`);
      process.exitCode = 1;
      continue;
    }
    list = list.filter((x) => x.toLowerCase() !== id.toLowerCase());
    if (add) list.push(id);
  }
  cfg[key] = list;
  store.saveConfig(cfg);
  console.log(`${key}: ${list.length ? list.join(', ') : '(empty)'}`);
  if (key === 'ignore') indexer.load({ config: cfg, force: true });
}

function cmdConfig() {
  const cfg = store.loadConfig();
  if (!args.length) { console.log(JSON.stringify(cfg, null, 2)); return; }
  const [key, ...rest] = args;
  if (!(key in store.DEFAULT_CONFIG)) { console.error(`Unknown key "${key}". Keys: ${Object.keys(store.DEFAULT_CONFIG).join(', ')}`); process.exitCode = 1; return; }
  let val = rest.join(' ');
  try { val = JSON.parse(val); } catch {}
  cfg[key] = val;
  store.saveConfig(cfg);
  console.log(`${key} = ${JSON.stringify(val)}`);
}

function cmdStats() {
  const { index, usage, config } = loadAll();
  const by = {};
  for (const d of index.docs) { const k = `${d.source}/${d.kind}`; by[k] = (by[k] || 0) + 1; }
  console.log(`Index: ${index.N} entries, built ${new Date(index.builtAt).toLocaleString()} in ${index.buildMs} ms`);
  console.log(`File:  ${indexer.indexFile(config)}`);
  for (const [k, v] of Object.entries(by).sort()) console.log(`  ${k.padEnd(18)} ${v}`);
  const top = Object.entries(usage.counts || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  if (top.length) { console.log('Most used:'); for (const [id, n] of top) console.log(`  ${String(n).padStart(4)}  ${id}`); }
}

function cmdDoctor() {
  const ok = (b, msg) => console.log(`${b ? 'OK  ' : 'FAIL'} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 16, `node ${process.versions.node} (need >= 16)`);
  const t0 = Date.now();
  const { index, config } = loadAll(true);
  ok(index.N > 0, `indexed ${index.N} skills/agents/commands in ${Date.now() - t0} ms`);
  const res = router.route('review my pull request for bugs before I merge it', index, config);
  ok(true, `sample route -> ${res.picks.map((p) => p.doc.id).join(', ') || '(nothing)'}`);
  const cdir = require('./lib/discover').claudeDir();
  const settings = store.readJSON(path.join(cdir, 'settings.json'), {});
  const installed = store.readJSON(path.join(cdir, 'plugins', 'installed_plugins.json'), { plugins: {} });
  const pluginKey = Object.keys(installed.plugins || {}).find((k) => /^skills-conflict@/.test(k));
  const viaPlugin = pluginKey && (settings.enabledPlugins || {})[pluginKey] !== false;
  const viaSkillsDir = fs.existsSync(path.join(cdir, 'skills', 'skills-conflict', '.claude-plugin', 'plugin.json'));
  const viaSettings = JSON.stringify(settings.hooks || {}).includes('skills-conflict');
  const how = viaPlugin ? `plugin ${pluginKey}` : viaSkillsDir ? '~/.claude/skills/skills-conflict' : viaSettings ? 'settings.json hooks (install.js)' : null;
  ok(!!how, `hooks registered: ${how || 'not found. Install the plugin or run install.js'}`);
  const errLog = path.join(store.dataDir(), 'errors.log');
  const errs = fs.existsSync(errLog) ? fs.readFileSync(errLog, 'utf8').trim().split('\n').filter(Boolean) : [];
  ok(errs.length === 0, `hook errors logged: ${errs.length}${errs.length ? ' (last: ' + errs[errs.length - 1].slice(0, 160) + ')' : ''}`);
  ok(config.enabled !== false, `router enabled (${config.enabled !== false})`);
  const t1 = Date.now();
  indexer.load({ config });
  ok(Date.now() - t1 < 500, `cached index load ${Date.now() - t1} ms`);
}

const commands = {
  route: cmdRoute,
  audit: cmdAudit,
  prefer: () => editList('prefer', true),
  unprefer: () => editList('prefer', false),
  avoid: () => editList('avoid', true),
  unavoid: () => editList('avoid', false),
  ignore: () => editList('ignore', true),
  unignore: () => editList('ignore', false),
  config: cmdConfig,
  rebuild: () => { const { index } = loadAll(true); console.log(`Re-indexed ${index.N} entries in ${index.buildMs} ms`); },
  stats: cmdStats,
  doctor: cmdDoctor,
  on: () => { const c = store.loadConfig(); c.enabled = true; store.saveConfig(c); console.log('skill-router enabled'); },
  off: () => { const c = store.loadConfig(); c.enabled = false; store.saveConfig(c); console.log('skill-router disabled (hooks stay installed but inject nothing)'); },
};

if (commands[cmd]) commands[cmd]();
else {
  const src = fs.readFileSync(__filename, 'utf8');
  console.log(src.split('\n').slice(2, 16).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}
