'use strict';
// Shared plumbing for hook entry points: read the hook payload from stdin, never throw,
// never block the user's prompt for long.

function readStdin(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    };
    if (process.stdin.isTTY) return finish();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, timeoutMs).unref();
  });
}

function emit(event, additionalContext) {
  if (!additionalContext) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }));
}

// Hooks must not break the session: log the problem for `cli.js doctor` and exit 0.
function guard(fn) {
  fn().catch((err) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const { dataDir } = require('../lib/store');
      fs.appendFileSync(path.join(dataDir(), 'errors.log'), `${new Date().toISOString()} ${err && err.stack || err}\n`);
    } catch {}
  }).finally(() => { process.exitCode = 0; });
}

module.exports = { readStdin, emit, guard };
