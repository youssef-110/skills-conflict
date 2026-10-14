#!/usr/bin/env node
'use strict';
// PostToolUse hook (Skill / Agent tools): counts which skills actually get used so the
// router can break ties inside an overlap group in favour of the ones you rely on.

const { readStdin, guard } = require('./common');

guard(async () => {
  const input = await readStdin();
  const ti = input.tool_input || {};
  const id = ti.skill || ti.command || ti.subagent_type;
  if (typeof id === 'string' && id.trim()) require('../lib/store').recordUsage(id.trim().replace(/^\//, ''));
});
