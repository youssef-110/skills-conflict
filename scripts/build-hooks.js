#!/usr/bin/env node
'use strict';
// Regenerates hooks/hooks.json (the plugin's hook wiring). Hand-escaping the shell inside
// JSON is error-prone, so the file is generated from here.
//
// The command converts a Git Bash style plugin root (/c/Users/...) to C:/Users/... before
// handing it to node, and exits quietly when node is missing so a session never breaks.

const fs = require('fs');
const path = require('path');

const SED_DRIVE = String.raw`sed 's|^/\([a-zA-Z]\)/|\1:/|'`;
const cmd = (file) =>
  'command -v node >/dev/null 2>&1 || exit 0; R=$(printf %s "${CLAUDE_PLUGIN_ROOT}" | ' + SED_DRIVE +
  '); node "$R/scripts/hooks/' + file + '"';

const hooks = {
  description: 'skill-router: index installed skills at session start, route every prompt, learn from skill usage',
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: cmd('session-start.js'), timeout: 20 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: cmd('prompt.js'), timeout: 15 }] }],
    PostToolUse: [{ matcher: 'Skill|Agent|Task', hooks: [{ type: 'command', command: cmd('skill-used.js'), timeout: 5 }] }],
  },
};

const out = path.join(__dirname, '..', 'hooks', 'hooks.json');
fs.writeFileSync(out, JSON.stringify(hooks, null, 2) + '\n');
console.log('wrote', out);
