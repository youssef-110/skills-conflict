---
name: skill-router
description: Manages the automatic skill router that picks the best installed skills for every request and blocks overlapping ones. Use when the user asks which skill or plugin to use for something, why a skill was or was not picked, which installed skills overlap, duplicate or conflict, says they have too many skills, wants to always prefer one skill over another, wants to stop a skill from being suggested, or wants to turn the router on or off. Also use when a <skill-router> note looks wrong.
allowed-tools: Bash(node *skills-conflict*scripts/cli.js*), Bash(node *skills-conflict*scripts\cli.js*)
---

# Skill router

A hook already runs before every prompt. It scans every installed skill, plugin skill, slash command
and subagent, scores them against the request, and adds a `<skill-router>` note naming the best picks
and the overlapping ones to skip. Nothing has to be invoked for that to work. This skill is for
inspecting and steering it.

All commands go through one script. The exact command is in this session's "skill-router is active"
startup note (`node "<path>/scripts/cli.js" <command>`). If that note is missing, the script is
`../../scripts/cli.js` relative to this skill's base directory. Do not search the disk for it.

```bash
node "<path>/scripts/cli.js" <command>
```

## What the user wants, and the command for it

| Request | Command |
|---|---|
| "which skill should I use for X?" / "why did it pick Y?" | `route "<their task, verbatim>"` (add `--json` for scores) |
| "which of my skills overlap / conflict / are duplicates?" | `audit` (or `audit --out skill-audit.md` for a file) |
| "always use X instead of Y" | `prefer X` (accepts several ids, first wins) |
| "stop suggesting X" / "never use X" | `ignore X` (also takes a whole plugin name) |
| "only use X as a last resort" | `avoid X` |
| undo any of those | `unprefer X`, `unignore X`, `unavoid X` |
| "turn the router off / on" | `off` / `on` |
| "is it working?" | `doctor` |
| "how many skills does it know about?" / "what do I use most?" | `stats` |
| just installed or removed skills | nothing: the index refreshes itself; `rebuild` forces it |
| tune sensitivity | `config minConfidence 0.35` (higher = fewer notes), `config maxPicks 2` |

Ids are exactly what the router prints, for example `superpowers:brainstorming`, `taste-skill`,
`engineering:debug`. If an id is wrong, the command lists close matches. Use one of those instead of
guessing.

## Answering well

- For "which skill for X", run `route` and explain the pick in a sentence. Name the overlapping skills
  it rejected and why. Do not paste raw JSON.
- For an audit, lead with the 3 to 5 biggest overlap groups, say which member the router currently
  favours, and offer `prefer` commands for the user to accept. Do not set preferences the user did not ask for.
- After changing preferences, run `route` again on the user's example to show the new behaviour.
- When the note was wrong for a request, check `route --json` to see what matched. Usually one of
  these fixes it: `prefer` the right skill, `ignore` a noisy one, or raise `minConfidence`.

## How it decides (for explaining to users)

1. **Index.** Reads SKILL.md, command and agent frontmatter from project `.claude/`, `~/.claude/`,
   every enabled plugin and Claude-desktop plugins. Only folders Claude Code really loads count, so
   uninstalled plugins are never suggested.
2. **Score.** BM25 over names and descriptions. Task words such as "debug", "review" and "deploy"
   outweigh context nouns. Words in a skill's own name, the author's quoted trigger phrases, and
   explicit mentions ("use taste-skill") get large boosts.
3. **De-duplicate.** Two candidates from different plugins whose descriptions are too similar
   (tf-idf cosine) do the same job. Only the higher-scoring one is kept and the other goes on the
   "do not also load" list. Skills from the same plugin are treated as a team, never as rivals.
4. **Decide.** A confident match becomes a directive ("USE FIRST"). A weaker one becomes a short
   list for Claude to choose from. Chit-chat, "continue", slash commands and simple look-ups get
   nothing.
5. **Learn.** Every Skill and Agent call is counted. Inside an overlap group, the skills you actually
   use win ties.
