#!/usr/bin/env node
'use strict';
// SessionStart hook: refreshes the skill index (only when installed skills changed) so the
// first prompt is fast, and tells Claude how to read the router's notes.

const { readStdin, emit, guard } = require('./common');

guard(async () => {
  const input = await readStdin();
  const store = require('../lib/store');
  const config = store.loadConfig();
  if (config.enabled === false) return;
  const index = require('../lib/indexer').load({ cwd: input.cwd || process.cwd(), config });
  // Subagents and compaction restarts already have this; only brief fresh sessions.
  if (input.source && !/^(startup|clear)$/.test(input.source)) return;
  emit('SessionStart',
    `skill-router is active (${index.N} skills, agents and commands indexed). Before each request it may add a ` +
    `<skill-router> note naming the best-fitting installed skills and the overlapping ones to skip. Treat it as a strong ` +
    `hint: load the first pick with the Skill tool (or Agent tool for agents) before starting, do not load several skills ` +
    `that do the same job, and ignore the note when it clearly does not fit. The user can ask "which skills overlap" ` +
    `or "always prefer X over Y" and the skill-router skill handles it.`);
});
