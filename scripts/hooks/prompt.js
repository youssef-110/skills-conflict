#!/usr/bin/env node
'use strict';
// UserPromptSubmit hook: picks the best installed skills for the prompt and injects them,
// with the overlapping alternatives to skip, as context for Claude.

const path = require('path');
const { readStdin, emit, guard } = require('./common');

guard(async () => {
  const input = await readStdin();
  const prompt = String(input.prompt || '');
  if (!prompt.trim()) return;

  const store = require('../lib/store');
  const config = store.loadConfig();
  if (config.enabled === false) return;

  // A typed slash command is the user choosing a skill themselves: learn from it, add nothing.
  const slash = /^\/([A-Za-z0-9][\w:.-]*)/.exec(prompt.trim());
  if (slash) { store.recordUsage(slash[1]); return; }

  const indexer = require('../lib/indexer');
  const router = require('../lib/router');
  const cwd = input.cwd || process.cwd();
  const index = indexer.load({ cwd, config });
  const res = router.route(prompt, index, config, store.loadUsage());
  if (!res.picks.length) return;

  // Same picks as the previous prompt in this session: a one-line reminder is enough.
  const ids = res.picks.map((p) => p.doc.id);
  const lastFile = path.join(store.dataDir(), 'last-route.json');
  const last = store.readJSON(lastFile, {});
  const session = input.session_id || 'none';
  const repeat = last.session === session && JSON.stringify(last.ids) === JSON.stringify(ids) && Date.now() - last.at < 30 * 60e3;
  try {
    store.writeJSON(lastFile, { session, ids, at: Date.now(), tier: res.tier, confidence: res.confidence, prompt: prompt.slice(0, 200),
      skipped: res.skipped.map((s) => s.doc.id) });
  } catch {}

  if (repeat) {
    emit('UserPromptSubmit', `<skill-router>Same skills as the previous request still apply: ${ids.join(', ')}. Keep using the one already loaded; do not load overlapping alternatives.</skill-router>`);
    return;
  }
  emit('UserPromptSubmit', router.formatContext(res, index));
});
