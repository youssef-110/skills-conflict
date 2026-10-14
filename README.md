# skills-conflict

**Automatic skill routing for Claude Code.** Install it once. Before every prompt it finds the best
skills for the job among everything you have installed, and it stops Claude from loading several
skills that do the same thing.

```
you:    my login form throws a TypeError when I submit, can you debug it

        <skill-router>
        Best skills for this request (auto-selected from 695 installed, confidence 54%):
        1. engineering:debug [skill, USE FIRST] -> Skill tool, skill "engineering:debug". Structured
           debugging session: reproduce, isolate, diagnose, and fix...
        Load #1 before doing the work.
        Do not also load these; they do the same job as a pick above and would duplicate or conflict:
        superpowers:systematic-debugging (~engineering:debug), hzblj-skills:error-handling (~engineering:debug)...
        </skill-router>
```

You never type a command. The note is added to Claude's context, not to your screen.

## Why

Once you have a few dozen plugins, three things go wrong:

- **Skills don't trigger.** Claude sees hundreds of one-line descriptions and often picks none.
- **The wrong skill triggers.** A vaguely related skill wins over the one built for the task.
- **Overlapping skills fight.** Five "frontend design" skills and three "code review" skills from
  different plugins give conflicting instructions, and loading several of them burns context.

skills-conflict fixes all three with a local, dependency-free router. It runs in about 10 ms per
prompt, makes no network calls and uses no API key.

## Install

### As a plugin (recommended)

```bash
claude plugin marketplace add youssef-110/skills-conflict
```

```bash
claude plugin install skills-conflict@skills-conflict
```

Or, inside Claude Code, run `/plugin marketplace add youssef-110/skills-conflict` and then
`/plugin install skills-conflict@skills-conflict`. Start a new session and it is active.

### Without the plugin system

```bash
git clone https://github.com/youssef-110/skills-conflict.git ~/.claude/skills-conflict
```

```bash
node ~/.claude/skills-conflict/install.js
```

`install.js` backs up `settings.json`, then adds three hooks that point at the clone and copies the
`skill-router` skill into place. `node install.js --uninstall` reverses it.

Requires Node.js 16 or newer, which Claude Code already relies on.

## What it does

| When | Hook | What happens |
|---|---|---|
| Session starts | `SessionStart` | Re-indexes installed skills if anything changed (about 1 s for 700 skills; otherwise a cached load in about 30 ms). Tells Claude how to read router notes. |
| You send a prompt | `UserPromptSubmit` | Scores every skill, slash command and subagent against the prompt, then injects the best picks plus the overlapping ones to skip. |
| Claude uses a skill | `PostToolUse` (`Skill`, `Agent`) | Counts usage, so skills you actually use win ties inside an overlap group. |

**What gets indexed:** project `.claude/skills`, `commands` and `agents`; the same folders under
`~/.claude`; every enabled plugin from `installed_plugins.json`; plugins synced by the Claude desktop
app (only in desktop sessions); and Claude Code's built-in skills. Disabled plugins, old cached
versions, marketplace checkouts and `.trash` folders are skipped, so uninstalled skills are never
suggested.

**How it ranks:**

1. **BM25** over each skill's name and description. Words in a skill's own name count three times.
2. **Task words** ("debug", "review", "deploy", "animate"...) outweigh context nouns ("my login form").
   Error-shaped words (`TypeError`, `traceback`, "started failing") imply debugging.
3. **Trigger phrases** that authors quote in their descriptions (`"deploy my app"`) give a large boost.
4. **Explicit mentions** ("use taste-skill for this") always win.
5. **Overlap removal.** Candidates from different plugins with near-duplicate descriptions (tf-idf
   cosine >= 0.28) do the same job. The best one is kept and the rest are listed as "do not also
   load". Skills from the same plugin or name family (`remotion-*`) are a team, never rivals.
6. **Two tiers.** High confidence gives a directive ("USE FIRST"). Medium confidence gives a short
   list that Claude picks from or ignores. Low confidence gives nothing. Fast lexical retrieval
   supplies the recall and Claude supplies the judgement.
7. **Stays quiet** on "yes", "thanks", "continue with step 2", `/slash` commands and simple
   look-ups ("can you read src/index.ts").

## Steering it

Ask Claude in plain words. The bundled `skill-router` skill handles requests like "which of my
skills overlap?", "always use taste-skill instead of soft-skill" or "stop suggesting arcads". You
can also call the CLI directly:

```bash
node scripts/cli.js route "build a landing page with scroll animations"
```

| Command | Effect |
|---|---|
| `route "<prompt>" [--json]` | Show exactly what would be injected and why |
| `audit [--out file.md]` | List groups of installed skills from different sources that do the same job |
| `prefer <id>...` / `unprefer <id>` | Make a skill win its overlap group |
| `avoid <id>` / `unavoid <id>` | Pick only when nothing else fits |
| `ignore <id or plugin>` / `unignore` | Never suggest it |
| `config [key value]` | `minConfidence` (default 0.3), `strongConfidence` (0.5), `maxPicks` (3), `overlapThreshold` (0.28), `includeAgents`, `includeCommands`, `desktopPlugins` (`auto`, `always`, `never`) |
| `off` / `on` | Pause injection without uninstalling |
| `stats` / `doctor` / `rebuild` | Inspect the index, check the install, force a re-scan |

State lives in `~/.claude/skill-router/` (`config.json`, `usage.json`, index cache). Delete the
folder to reset.

## Accuracy

Measured on a real install with **695 skills, agents and commands from 51 plugins**:

| Eval set | Primary pick correct | Correct skill in the note | No-skill prompts left alone |
|---|---|---|---|
| Tuning set (45 prompts) | 95% | 100% | 100% |
| Held-out set (25 prompts) | 81% | 86% | 100% |
| Blind set (19 prompts), first and only untuned run | 80% | 87% | 75% silent, 100% never given a directive |

The blind set's failures pointed to general flaws, now fixed: common-word skill names, "why did you…"
read as a bug report, and recurrence words ("every hour"). The numbers above are from before those
fixes, so they are an honest estimate for prompts nobody has tuned on.

When two skills are a near tie for the same job, the note asks Claude to load whichever fits better,
never both, so a weak lexical pick cannot hide the right skill.

Run them on your own machine (cases whose skills you don't have are skipped automatically):

```bash
npm test
```

```bash
npm run evals
```

## Limits

- Ranking is lexical. A skill with a vague description ("helps with stuff") is hard to route to.
  Good descriptions help everyone, and the router rewards them.
- Claude Code's own built-in skill list is hard-coded in `data/builtin.json`. Add entries there if
  your version ships others.
- Hooks inject context; they cannot force a tool call. In practice Claude follows a
  "USE FIRST" directive reliably. Use `prefer` when you want stricter control.

## License

MIT
