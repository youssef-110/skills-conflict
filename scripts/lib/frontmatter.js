'use strict';
// Minimal YAML-frontmatter reader. Handles the shapes seen in real SKILL.md, command and
// agent files: plain scalars, quoted scalars, folded (>) and literal (|) blocks, and
// indented continuation lines. Anything fancier is ignored rather than throwing.

function unquote(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
    v = v.replace(/\\n/g, ' ').replace(/\\"/g, '"').replace(/''/g, "'");
  }
  return v;
}

function parseFrontmatter(src) {
  const text = String(src || '').replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2];
    const block = /^[|>][+-]?\s*$/.test(val.trim());
    if (block || val.trim() === '') {
      const parts = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        const line = lines[i].trim();
        if (line.startsWith('- ')) parts.push(line.slice(2)); else parts.push(line);
      }
      val = parts.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      // plain scalars may continue on more-indented lines
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]) && !/^\s*[A-Za-z0-9_-]+:\s/.test(lines[i + 1])) {
        i++;
        val += ' ' + lines[i].trim();
      }
      val = unquote(val);
    }
    data[key] = val;
  }
  return { data, body: text.slice(m[0].length) };
}

module.exports = { parseFrontmatter };
