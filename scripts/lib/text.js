'use strict';
// Tokenizing, stemming and phrase helpers shared by the indexer and the router.
// Kept dependency-free so the prompt hook starts in a few milliseconds.

const STOPWORDS = new Set(`a about above after again against all also am an and any are aren't as at be because been
before being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down
during each etc few for from further get gets getting go going got had hadn't has hasn't have haven't having he her
here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it it's its itself just let let's like
make makes me more most much must my myself need needs no nor not now of off on once one only or other ought our ours
ourselves out over own please really same say says she should shouldn't so some such than that that's the their theirs
them themselves then there there's these they they'd they'll they're they've this those through thus to too under
until up us use used uses using very via want wants was wasn't way we we'd we'll we're we've were weren't what what's
when when's where where's whether which while who who's whom why why's will with without won't would wouldn't yes yet
you you'd you'll you're you've your yours yourself yourselves can't hey hi ok okay thanks thank pls lol im ive dont
ahead something anything everything thing things stuff help able new old good great best better lot lots kind sort maybe
user users trigger triggers triggered invoke invoked invoking task tasks asks ask asked request
requests mention mentions mentioned whenever including include includes e g eg ie specific specifically`.split(/\s+/));

// Ordered longest-first; the first matching suffix wins. Deliberately aggressive:
// "animation", "animate", "animating" and "animated" all collapse to "anim".
const SUFFIXES = [
  ['izations', ''], ['ization', ''], ['isation', ''], ['ational', ''], ['fulness', ''], ['ousness', ''],
  ['iveness', ''], ['ations', ''], ['ation', ''], ['ments', ''], ['ment', ''], ['ness', ''], ['ities', ''],
  ['ity', ''], ['ures', ''], ['ure', ''], ['ances', ''], ['ance', ''], ['ences', ''], ['ence', ''], ['ated', ''], ['ating', ''], ['ings', ''], ['ing', ''], ['ies', 'y'], ['ied', 'y'], ['ers', ''], ['er', ''], ['ed', ''],
  ['ions', ''], ['ion', ''], ['ives', ''], ['ive', ''], ['izes', ''], ['ize', ''], ['ises', ''], ['ise', ''],
  ['ates', ''], ['ate', ''], ['ly', ''], ['al', ''], ['es', ''], ['s', ''], ['e', ''],
];

const stemCache = new Map();
function stem(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  const hit = stemCache.get(word);
  if (hit) return hit;
  let out = word;
  for (let pass = 0; pass < 2; pass++) {
    const before = out;
    for (const [suf, rep] of SUFFIXES) {
      if (out.endsWith(suf) && out.length - suf.length >= 3) { out = out.slice(0, -suf.length) + rep; break; }
    }
    if (out === before) break;
  }
  // collapse a trailing doubled consonant ("debugg" -> "debug", "plann" -> "plan")
  if (/([bcdfgklmnprtvz])\1$/.test(out)) out = out.slice(0, -1);
  stemCache.set(word, out);
  return out;
}

// Small synonym table (raw word -> raw related words). Maps everyday words onto the
// vocabulary skill authors tend to use. Values are stemmed at load time, and the table
// is consulted for both prompts and skill text, so it only ever widens matches.
const RAW_SYNONYMS = {
  ui: 'interface frontend', ux: 'interface usability', frontend: 'interface ui',
  website: 'web site page', webpage: 'web page', landing: 'page website', site: 'web website',
  bug: 'debug fix', broken: 'bug fix', crash: 'bug debug', error: 'bug debug', failing: 'bug debug test',
  slow: 'performance optimize', speed: 'performance', fast: 'performance',
  motion: 'animation', animation: 'motion', animate: 'motion', transition: 'animation',
  pr: 'pull review', diff: 'review change', audit: 'review', critique: 'review',
  deploy: 'ship release hosting', ship: 'deploy release', publish: 'deploy release',
  test: 'verify', tests: 'verify', tdd: 'test',
  db: 'database', sql: 'database query', postgres: 'database sql', postgresql: 'database sql',
  email: 'mail inbox', emails: 'mail inbox', gmail: 'mail inbox email', inbox: 'mail email',
  slides: 'deck presentation', deck: 'slides presentation', powerpoint: 'pptx slides', ppt: 'pptx slides',
  excel: 'xlsx spreadsheet', spreadsheet: 'xlsx', word: 'docx', pdf: 'document',
  chart: 'visualization graph', graph: 'chart', dashboard: 'chart visualization metrics',
  seo: 'search ranking keyword', ads: 'advertising campaign', ad: 'advertising campaign',
  instagram: 'ig social', ig: 'instagram', reel: 'video', reels: 'video', tiktok: 'video social',
  refactor: 'clean simplify', cleanup: 'refactor simplify', messy: 'refactor clean',
  security: 'vulnerability', vulnerabilities: 'security', hack: 'security', pentest: 'security penetration',
  commit: 'git', branch: 'git', merge: 'git',
  brainstorm: 'idea design', ideas: 'brainstorm',
  mobile: 'ios android native', ios: 'mobile swift', android: 'mobile', iphone: 'ios mobile',
  logo: 'brand', branding: 'brand', palette: 'color theme', colour: 'color',
  font: 'typography', fonts: 'typography', typography: 'font', css: 'style', tailwind: 'css style',
  ugly: 'design polish', polish: 'design refine', prettier: 'design polish', beautiful: 'design',
  plan: 'planning', roadmap: 'plan', architecture: 'design system',
  viz: 'visualization chart', dataviz: 'visualization chart', plot: 'chart visualization',
  remind: 'memory remember', remember: 'memory', earlier: 'previous past history', previous: 'past history',
  decided: 'decision', recall: 'memory search', unit: 'test', jest: 'test', vitest: 'test', pytest: 'test',
  pretooluse: 'hook settings', posttooluse: 'hook settings', userpromptsubmit: 'hook settings',
  sessionstart: 'hook settings', hook: 'hooks settings', hooks: 'hook settings', shortcut: 'keybinding', hotkey: 'keybinding',
  photo: 'image photoshoot', photos: 'image photoshoot', picture: 'image', pictures: 'image', screenshot: 'image',
  mockup: 'image design', satisfying: 'polish feel delight interaction', click: 'interaction', hover: 'interaction',
  button: 'interface component', buttons: 'interface component', snappy: 'animation feel', smooth: 'animation polish',
  janky: 'animation performance', codebase: 'repository architecture structure', repo: 'repository codebase',
  joined: 'onboarding', structured: 'structure architecture', newcomer: 'onboarding',
  cron: 'schedule recurring', hourly: 'schedule recurring', daily: 'schedule recurring', nightly: 'schedule recurring',
  recurring: 'schedule loop', periodically: 'schedule loop', interval: 'schedule loop',
};

const SYNONYMS = {};
for (const [k, v] of Object.entries(RAW_SYNONYMS)) {
  const vals = v.split(/\s+/).map((x) => stem(x));
  SYNONYMS[k] = vals;
  if (!SYNONYMS[stem(k)]) SYNONYMS[stem(k)] = vals;
}

function rawWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[`*_>#|]/g, ' ')
    .split(/[^a-z0-9+#.-]+/)
    .flatMap((w) => w.split(/[-.]+/))
    .filter(Boolean);
}

function tokens(text, { synonyms = true } = {}) {
  const out = [];
  for (const w of rawWords(text)) {
    if (w.length < 2 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    out.push(s);
    if (synonyms) {
      const syn = SYNONYMS[w] || SYNONYMS[s];
      if (syn) for (const x of syn) out.push(x);
    }
  }
  return out;
}

// Quoted phrases inside a description ("deploy my app", 'audit accessibility') are the
// author's own trigger examples, so the router gives exact phrase hits a large bonus.
function quotedPhrases(text) {
  const out = [];
  const re = /["“”']([^"“”'\n]{4,80})["“”']/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const p = m[1].trim().toLowerCase();
    if (p.split(/\s+/).length >= 1 && /[a-z]/.test(p)) out.push(p);
  }
  return out;
}

function counts(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

module.exports = { tokens, stem, quotedPhrases, counts, rawWords, STOPWORDS };
