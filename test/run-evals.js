#!/usr/bin/env node
'use strict';
// Runs routing evals against the skills installed on this machine.
//   node test/run-evals.js [evals.json] [--verbose] [--sweep]
// Reports: primary hit rate (pick #1 acceptable), any-pick hit rate, silence rate on
// no-skill prompts, and hook latency.

const fs = require('fs');
const path = require('path');
const store = require('../scripts/lib/store');
const indexer = require('../scripts/lib/indexer');
const router = require('../scripts/lib/router');

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const sweep = argv.includes('--sweep');
const file = argv.find((a) => !a.startsWith('--')) || path.join(__dirname, 'evals', 'local-routing.json');
const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));

const baseConfig = store.loadConfig();
const index = indexer.load({ config: baseConfig });
// a skill can be named by its id or by its frontmatter alias
const canonical = new Map();
for (const d of index.docs) { canonical.set(d.id, d.id); for (const a of d.aliases || []) if (!canonical.has(a)) canonical.set(a, d.id); }
const installed = new Set(canonical.keys());

function run(config, print) {
  let prim = 0, any = 0, pos = 0, silent = 0, neg = 0, skipped = 0, noStrong = 0, strong = 0, strongOk = 0;
  const t0 = process.hrtime.bigint();
  for (const c of cases) {
    const res = router.route(c.prompt, index, config, { counts: {} });
    const picks = res.picks.map((p) => p.doc.id);
    if (c.none) {
      neg++;
      const ok = picks.length === 0;
      if (ok) silent++;
      if (res.tier !== 'strong' && res.tier !== 'explicit') noStrong++;
      if (print && (!ok || verbose)) console.log(`${ok ? 'ok  ' : res.tier === 'suggest' ? 'soft' : 'FAIL'} [none] ${c.prompt}  -> ${res.tier} ${picks.join(', ') || '-'} (${(res.confidence * 100).toFixed(0)}%)`);
      continue;
    }
    const accept = [...new Set(c.accept.filter((id) => installed.has(id)).map((id) => canonical.get(id)))];
    if (!accept.length) { skipped++; continue; }
    pos++;
    const p1 = accept.includes(picks[0]);
    const pa = picks.some((id) => accept.includes(id));
    if (p1) prim++;
    if (pa) any++;
    if (res.tier === 'strong') { strong++; if (p1) strongOk++; }
    if (print && (!p1 || verbose)) {
      console.log(`${p1 ? 'ok  ' : pa ? 'half' : 'FAIL'} ${c.prompt}\n      -> ${picks.join(', ') || '(nothing: ' + res.reason + ', ' + (res.confidence * 100).toFixed(0) + '%)'}` +
        (p1 ? '' : `\n      want ${accept.slice(0, 4).join(' | ')}`) +
        (res.candidates ? `\n      cands ${res.candidates.slice(0, 4).map((x) => x.doc.id + ' ' + x.score.toFixed(1)).join(', ')}` : '') +
        (res.skipped.length ? `\n      skip ${res.skipped.map((s) => s.doc.id).join(', ')}` : ''));
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / cases.length;
  return { prim: prim / pos, any: any / pos, silent: silent / neg, noStrong: noStrong / neg, strongPrec: strong ? strongOk / strong : 1, strong, pos, neg, skipped, ms };
}

if (sweep) {
  const rows = [];
  for (const minConfidence of [0.25, 0.3, 0.35, 0.4, 0.45]) {
    for (const overlapThreshold of [0.22, 0.28, 0.35]) {
      const r = run({ ...baseConfig, minConfidence, overlapThreshold }, false);
      rows.push({ minConfidence, overlapThreshold, ...r, f: (r.prim + r.any * 2 + r.silent + r.noStrong * 2) / 6 });
    }
  }
  rows.sort((a, b) => b.f - a.f);
  for (const r of rows.slice(0, 10)) console.log(`conf ${r.minConfidence} overlap ${r.overlapThreshold}  primary ${(r.prim * 100).toFixed(0)}%  any ${(r.any * 100).toFixed(0)}%  silent ${(r.silent * 100).toFixed(0)}%`);
} else {
  const r = run(baseConfig, true);
  console.log(`\n${index.N} indexed | ${r.pos} task cases (${r.skipped} skipped: not installed), ${r.neg} no-skill cases`);
  console.log(`primary correct ${(r.prim * 100).toFixed(1)}% | correct skill in output ${(r.any * 100).toFixed(1)}% | ` +
    `strong-tier precision ${(r.strongPrec * 100).toFixed(1)}% (${r.strong} strong) | no-skill prompts: silent ${(r.silent * 100).toFixed(1)}%, never strong ${(r.noStrong * 100).toFixed(1)}% | ${r.ms.toFixed(1)} ms/route`);
  if (process.env.EVAL_MIN_PRIMARY && r.prim < Number(process.env.EVAL_MIN_PRIMARY)) process.exitCode = 1;
}
