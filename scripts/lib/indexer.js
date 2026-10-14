'use strict';
// Builds and caches the searchable index of installed skills.

const path = require('path');
const fs = require('fs');
const { discover, fingerprint, ancestors } = require('./discover');
const { tokens, rawWords, quotedPhrases, counts, stem } = require('./text');
const store = require('./store');

const INDEX_VERSION = 8;
const NAME_WEIGHT = 3;   // a word in the skill's name says more than one in its description
const PLUGIN_WEIGHT = 1; // plugin name ("gsap-skills", "supabase") is a strong domain hint

// Generic words in plugin names ("anthropic-skills", "gsap-skills", "audit-suite") say
// nothing about what a skill does; only the distinctive part is indexed.
const GENERIC_PLUGIN_WORDS = /\b(skills?|plugins?|agents?|suite|kit|tools?|claude|anthropic|official|mcp|marketplace)\b/g;
function pluginWords(plugin) {
  return String(plugin).replace(/[-_]/g, ' ').replace(GENERIC_PLUGIN_WORDS, ' ');
}

function docTerms(e) {
  const tf = new Map();
  const add = (list, w) => { for (const [t, c] of counts(list)) tf.set(t, (tf.get(t) || 0) + c * w); };
  const nameWords = String(e.name).replace(/[:/_]/g, ' ');
  add(tokens(nameWords), NAME_WEIGHT);
  if (e.plugin) add(tokens(pluginWords(e.plugin)), PLUGIN_WEIGHT);
  add(tokens(e.description), 1);
  if (e.whenToUse) add(tokens(e.whenToUse), 1);
  return tf;
}

function build({ cwd = process.cwd(), config = store.loadConfig() } = {}) {
  const t0 = Date.now();
  const entries = discover({ cwd, config });
  const docs = [];
  const df = new Map();
  let totalLen = 0;
  for (const e of entries) {
    if (!e.modelInvocable && e.kind === 'skill') continue;
    const tf = docTerms(e);
    let len = 0;
    for (const v of tf.values()) len += v;
    totalLen += len;
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    docs.push({
      id: e.id,
      name: e.name,
      kind: e.kind,
      plugin: e.plugin,
      source: e.source,
      aliases: e.aliases || undefined,
      desc: e.description.slice(0, 240),
      phrases: quotedPhrases(e.description + ' ' + (e.whenToUse || '')).slice(0, 25),
      nameWords: rawWords(e.name.replace(/[:/_]/g, ' ')).filter((w) => w.length > 2),
      nameStems: [...new Set(tokens(e.name.replace(/[:/_]/g, ' '), { synonyms: false }))],
      len,
      tf: Object.fromEntries(tf),
    });
  }
  // pre-compute tf-idf vector norms so overlap checks at prompt time are a single dot product
  const N = docs.length;
  for (const d of docs) {
    let n = 0;
    for (const [t, v] of Object.entries(d.tf)) {
      const w = v * Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      n += w * w;
    }
    d.norm = Math.sqrt(n);
  }
  const index = {
    version: INDEX_VERSION,
    fingerprint: fingerprint({ cwd, config }),
    builtAt: Date.now(),
    buildMs: Date.now() - t0,
    N: docs.length,
    avgLen: docs.length ? totalLen / docs.length : 1,
    df: Object.fromEntries(df),
    docs,
  };
  return index;
}

// One cache file per (desktop|cli) x (set of project .claude folders in scope). Sessions in
// folders without project-level skills share the global index instead of rebuilding.
function indexFile(config, cwd = process.cwd()) {
  const mode = /desktop/i.test(process.env.CLAUDE_CODE_ENTRYPOINT || '') || config.desktopPlugins === true ? 'desktop' : 'cli';
  const projects = ancestors(cwd).filter((d) => {
    try { return fs.statSync(path.join(d, '.claude')).isDirectory(); } catch { return false; }
  });
  const scope = projects.length
    ? '-' + require('crypto').createHash('sha1').update(projects.join('|')).digest('hex').slice(0, 8)
    : '';
  return path.join(store.dataDir(), `index-${mode}${scope}.json`);
}

// Returns a fresh-enough index, rebuilding when installed skills changed.
function load({ cwd = process.cwd(), config = store.loadConfig(), force = false } = {}) {
  const file = indexFile(config, cwd);
  if (!force) {
    const cached = store.readJSON(file, null);
    const maxAge = (config.maxIndexAgeHours || 12) * 3600e3;
    if (cached && cached.version === INDEX_VERSION && Date.now() - cached.builtAt < maxAge &&
        cached.fingerprint === fingerprint({ cwd, config })) {
      return cached;
    }
  }
  const index = build({ cwd, config });
  try { store.writeJSON(file, index); } catch {}
  return index;
}

module.exports = { build, load, indexFile, docTerms, INDEX_VERSION };
