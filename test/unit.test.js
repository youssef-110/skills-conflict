'use strict';
// Self-contained tests: builds a fake ~/.claude with known skills and checks discovery,
// routing, overlap handling and preferences. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-router-test-'));
const claude = path.join(root, '.claude');
process.env.CLAUDE_CONFIG_DIR = claude;
process.env.SKILL_ROUTER_HOME = path.join(root, 'router');
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';

function write(rel, body) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}
const skill = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n`;

// user skills
write('.claude/skills/deploy-helper/SKILL.md', skill('deploy-helper', 'Deploy applications to Vercel. Use when the user says "deploy my app" or wants a preview deployment link.'));
write('.claude/skills/pretty-ui/SKILL.md', skill('pretty-ui-design', 'Design distinctive frontend interfaces, landing pages and websites that do not look templated. Typography, color, layout.'));
write('.claude/skills/remotion-captions/SKILL.md', skill('remotion-captions', 'Add animated captions and subtitles to Remotion videos.'));
write('.claude/skills/remotion-render/SKILL.md', skill('remotion-render', 'Render and export Remotion videos to mp4.'));
write('.claude/skills/manual-only/SKILL.md', skill('manual-only', 'Deploy applications manually.', 'disable-model-invocation: true\n'));
write('.claude/commands/standup.md', '---\ndescription: Write my daily standup summary from git commits\n---\nbody');
write('.claude/agents/sql-expert.md', '---\nname: sql-expert\ndescription: Writes and optimizes SQL queries for Postgres databases\n---\nbody');

// an enabled plugin with an overlapping design skill, and a disabled plugin
const pluginA = path.join(root, 'cache', 'acme', 'design-kit', '1.0.0');
write('cache/acme/design-kit/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'design-kit' }));
write('cache/acme/design-kit/1.0.0/skills/frontend-design/SKILL.md', skill('frontend-design', 'Design distinctive frontend interfaces and landing pages that avoid generic templated looks. Typography, color and layout choices.'));
write('cache/acme/design-kit/1.0.0/skills/debugging/SKILL.md', skill('debugging', 'Systematic debugging. Use when encountering any bug, error, crash or test failure.'));
const pluginB = path.join(root, 'cache', 'acme', 'old-plugin', '1.0.0');
write('cache/acme/old-plugin/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'old-plugin' }));
write('cache/acme/old-plugin/1.0.0/skills/ghost/SKILL.md', skill('ghost', 'Deploy applications to Vercel with ghost mode.'));
write('.claude/plugins/installed_plugins.json', JSON.stringify({
  version: 2,
  plugins: {
    'design-kit@acme': [{ scope: 'user', installPath: pluginA }],
    'old-plugin@acme': [{ scope: 'user', installPath: pluginB }],
  },
}));
write('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'design-kit@acme': true, 'old-plugin@acme': false } }));

const { discover } = require('../scripts/lib/discover');
const indexer = require('../scripts/lib/indexer');
const router = require('../scripts/lib/router');
const store = require('../scripts/lib/store');

const cwd = path.join(root, 'project');
fs.mkdirSync(cwd, { recursive: true });
const ids = () => discover({ cwd }).map((e) => e.id);

test('discovers user skills, commands, agents and enabled plugins only', () => {
  const found = ids();
  for (const id of ['deploy-helper', 'pretty-ui', 'remotion-captions', 'standup', 'sql-expert', 'design-kit:frontend-design', 'design-kit:debugging']) {
    assert.ok(found.includes(id), `missing ${id}`);
  }
  assert.ok(!found.includes('old-plugin:ghost'), 'disabled plugin must not be indexed');
});

test('skill id is the folder name; a different frontmatter name becomes an alias', () => {
  const e = discover({ cwd }).find((x) => x.id === 'pretty-ui');
  assert.deepStrictEqual(e.aliases, ['pretty-ui-design']);
});

test('skills with disable-model-invocation are not routed', () => {
  const index = indexer.build({ cwd, config: store.loadConfig() });
  assert.ok(!index.docs.some((d) => d.id === 'manual-only'));
});

const index = indexer.build({ cwd, config: store.loadConfig() });
const route = (p, cfg = {}) => router.route(p, index, { ...store.DEFAULT_CONFIG, ...cfg });

test('routes a trigger phrase to its skill', () => {
  const r = route('deploy my app to vercel please');
  assert.strictEqual(r.picks[0].doc.id, 'deploy-helper');
});

test('overlapping skills from different sources: one picked, the other flagged', () => {
  const r = route('design a distinctive landing page with great typography and color');
  const picked = r.picks.map((p) => p.doc.id);
  const skipped = r.skipped.map((s) => s.doc.id);
  const pair = ['pretty-ui', 'design-kit:frontend-design'];
  assert.strictEqual(picked.filter((id) => pair.includes(id)).length, 1, 'exactly one of the twins is picked');
  assert.strictEqual(skipped.filter((id) => pair.includes(id)).length, 1, 'the other twin is flagged as overlap');
});

test('prefer flips the winner of an overlap group', () => {
  const r = route('design a distinctive landing page with great typography and color', { prefer: ['design-kit:frontend-design'] });
  assert.strictEqual(r.picks[0].doc.id, 'design-kit:frontend-design');
});

test('siblings from one family are never flagged as overlapping each other', () => {
  const r = route('add animated captions to my remotion video and render it to mp4');
  const skippedIds = r.skipped.map((s) => s.doc.id);
  assert.ok(!(skippedIds.includes('remotion-render') && r.picks.some((p) => p.doc.id === 'remotion-captions')));
});

test('error-shaped prompts route to debugging', () => {
  const r = route('getting a TypeError: cannot read properties of undefined in checkout.js');
  assert.strictEqual(r.picks[0] && r.picks[0].doc.id, 'design-kit:debugging');
});

test('explicit mention wins', () => {
  const r = route('use pretty-ui for the pricing section');
  assert.strictEqual(r.picks[0].doc.id, 'pretty-ui');
  assert.strictEqual(r.tier, 'explicit');
});

test('chatter, continuations, slash commands and look-ups stay silent', () => {
  for (const p of ['yes', 'ok go ahead', 'thanks, that worked', 'sounds good, continue with step 2', '/standup', 'can you read src/index.ts']) {
    assert.strictEqual(route(p).picks.length, 0, p);
  }
});

test('ignore removes a skill from the index', () => {
  const idx = indexer.build({ cwd, config: { ...store.loadConfig(), ignore: ['deploy-helper'] } });
  assert.ok(!idx.docs.some((d) => d.id === 'deploy-helper'));
});

test('context note names invocation and skip list', () => {
  const r = route('design a distinctive landing page with great typography and color');
  const ctx = router.formatContext(r, index);
  assert.match(ctx, /<skill-router>/);
  assert.match(ctx, /Skill tool, skill "/);
  assert.match(ctx, /Do not also load|never both/);
});

test('prompt hook emits valid hook JSON and stays silent on chatter', () => {
  const { execFileSync } = require('child_process');
  const hook = path.join(__dirname, '..', 'scripts', 'hooks', 'prompt.js');
  const run = (prompt) => execFileSync(process.execPath, [hook], { input: JSON.stringify({ prompt, cwd, session_id: 's' }), env: process.env }).toString();
  const out = JSON.parse(run('deploy my app to vercel'));
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /deploy-helper/);
  assert.strictEqual(run('thanks!'), '');
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
