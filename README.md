# Patina

[![npm version](https://img.shields.io/npm/v/@lcvbeek/patina.svg)](https://www.npmjs.com/package/@lcvbeek/patina)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Test coverage](https://img.shields.io/coverallsCoverage/github/lcvbeek/patina)

**Keep Claude's harness _buffed._**

Patina is the retro loop for Claude Code that layers every session,
near-miss, and team agreement into `PATINA.md` — an AI constitution loaded
into every session, owned by the whole team, polished one cycle at a time.

Each retro deposits one deliberate layer. Works solo; shines on a team.

---

## The loop

```text
patina capture   Record a notable moment while it's fresh.
                 UUID-named JSON — no merge conflicts.

patina reflect   Answer the questions your team picked. Async.
                 Every voice lands in the shared data dir.

patina run       Claude ingests logs, captures, and reflections
                 and applies the next layer to PATINA.md.
```

Review with `git diff PATINA.md`, commit. Next session, everyone works from
the updated instructions.

---

## Why this matters

- **Things only humans witness.** Near-misses, frustrations, team
  agreements — context your codebase can never explain to an agent.
- **Synthesised, not averaged.** Each teammate runs `patina reflect` on
  their own machine before the retro; every voice lands in the synthesis.
- **Nothing lands without review.** Claude proposes one concrete diff.
  `patina run` writes it to `PATINA.md`; a human reads it, approves it,
  commits it.
- **Stays small** (~50 lines). The synthesis prompt trims as well as adds
  and flags stale entries each cycle.

---

## Requirements

- Node.js 18+
- Access to Claude via one of:
  - **Claude Code CLI** (recommended) — install at
    [claude.ai/code](https://claude.ai/code), authenticate once, and Patina
    uses it automatically. Respects your existing plan including Claude Max.
  - **Anthropic API key** — set `ANTHROPIC_API_KEY` in your environment.
    Patina falls back to this if the CLI isn't found. Billed separately per token.

---

## Install

```bash
npm install -g @lcvbeek/patina
```

---

## Team setup (using git)

**First, create an empty git repo.** This will just hold the data. JSON files – no code, no builds. GitHub, GitLab, wherever.

**One person bootstraps:**

```bash
cd your-project
patina init --data-repo git@github.com:your-org/patina-data.git
patina run                # onboarding questions; first layer auto-applied
git diff PATINA.md        # review your first PATINA.md
git commit -am "First patina layer"
```

`--data-repo` clones the shared data repo as a sibling directory
(`../<repo-name>/`), writes a portable relative `dataDir` to
`.patina/config.json`, and enables automatic `git pull`/`push`.
UUID-named files mean concurrent writes never collide.

**Each teammate runs the same command once** after pulling the project:

```bash
patina init --data-repo git@github.com:your-org/patina-data.git
```

From then on, `dataDir` syncs automatically on every `patina` command.

Without `--data-repo`, data stays local — fine for solo, but teammates'
captures and reflections won't be included.

---

## Commands

| Command          | What it does                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`           | Scaffold `.patina/` in the current directory, create `PATINA.md`. Use `--data-repo <url>` to clone a shared data repo; `--skill` to install the `/patina` Claude Code skill |
| `capture`        | Capture a notable moment while it's fresh. Use `--synth` for an immediate Claude interpretation without waiting for the next retro                                          |
| `reflect`        | Answer reflection questions before the retro — saved locally, loaded by `patina run`. Press Enter to skip any question                                                      |
| `run`            | Run the retro — auto-ingests logs, loads all captures + reflections from the team, calls Claude for synthesis, applies the proposed change to `PATINA.md`                   |
| `status`         | Show metrics: token spend, rework rate, tool usage, trends across cycles. Shows a breakdown by project so you can verify which repos are being included                     |
| `layers`         | Visualise the patina the team has built — one ASCII layer per retro cycle. Shows 5 most recent by default; use `-n 10` for more or `-n 0` for all                           |
| `ask`            | Low-level command used by the `/patina` Claude Code skill — not intended for direct use                                                                                     |
| `ingest`         | Manually parse Claude Code logs (optional — `patina run` does this automatically)                                                                                           |
| `buff` / `apply` | _Deprecated._ `patina run` now applies changes automatically. Kept for backwards compatibility.                                                                             |

### patina init

```bash
patina init
patina init --skill                                     # also install the /patina Claude Code skill
patina init --data-repo git@github.com:org/retro.git    # clone and wire up a shared data repo
```

Creates `.patina/` with `PATINA.md`, `config.json`, `context/`, and `cycles/`,
and adds `@.patina/PATINA.md` to `CLAUDE.md` (creating it if needed).

- `--skill` installs the `/patina` Claude Code skill to `~/.claude/skills/patina/`
  so any team member can answer reflection questions from inside a Claude Code session.
- `--data-repo <url>` clones the given git repo as a sibling directory
  (`../<repo-name>/`), writes a portable relative `dataDir` to `.patina/config.json`,
  and enables automatic `git pull`/`push` sync on each `patina` command — the
  easiest way to share captures, reflections, and sessions across a team.

Safe to run once per project.

### patina capture

```bash
patina capture          # interactive mode
patina capture "agent almost pushed directly to main — need an approval gate rule"
patina capture --tag near-miss "agent almost pushed directly to main"
patina capture --synth "Claude tried to commit an API key"  # immediate synthesis
```

Tags: `near-miss` (`n`) / `went-well` (`w`) / `frustration` (`f`) / `pattern` (`p`) / `other` (`o`)

Captures are UUID-named JSON files in `dataDir` — no merge conflicts,
anyone can write anytime. Author comes from `git config user.name`.

`--synth` calls Claude immediately, pattern-matches against recent
captures and `PATINA.md`, prints an insight, and queues a proposed
instruction change for the next `patina run` to apply.

### patina reflect

```bash
patina reflect
```

Walks through the reflection questions and saves answers to `dataDir`.
Press Enter to skip. Each teammate runs this before the retro; `patina run`
aggregates every answer since the last cycle.

Customise questions by committing `.patina/questions.json`.

### /patina skill (Claude Code)

`patina init --skill` installs a Claude Code skill at
`~/.claude/skills/patina/` so teammates can reflect and capture without
leaving a Claude Code session:

```bash
/patina next                           # next unanswered question
/patina reflect felt good overall      # record an answer
/patina capture near-miss: almost...   # capture a moment
/patina status                         # cycle metrics
```

The skill auto-advances to the next question after each answer, so a
teammate can clear reflections in one conversation. `patina ask` backs the
skill and isn't meant for direct use.

### patina run

```bash
patina run
patina run --onboard # force onboarding questions
```

Auto-ingests Claude Code logs, loads all captures and reflections since
the last cycle, synthesises, writes the report to `.patina/cycles/<date>.md`,
and applies the proposed change to the correct file (core or spoke, by
section number). Review with `git diff` before committing. First run asks
onboarding questions to establish baseline agreements.

### patina buff / patina apply (deprecated)

`patina run` now applies changes automatically. `buff` and `apply` remain
as aliases for the pending-diff flow but aren't part of the loop anymore.

### patina status

Token spend, rework rate, tool usage, and trends across cycles, with a
per-project breakdown so you can verify which repos are contributing.

### patina layers

```bash
patina layers        # 5 most recent cycles
patina layers -n 10  # last 10
patina layers -n 0   # all
```

One ASCII layer per retro — a quick visual of how the patina has built up.
Useful to share at the start of a retro.

### patina ingest

Manually parses Claude Code JSONL logs. `patina run` does this
automatically; use `ingest` to pre-populate metrics or debug. Only the
current project's sessions are ingested by default (slug derived from
`cwd`, matched against `~/.claude/projects/`).

---

## Data directory

Operational data (sessions, captures, reflections, metrics, pending diffs)
lives outside the project repo. Default location, per machine:

```bash
~/.patina/projects/<slug>/
  sessions/
  captures/
  reflections/
  metrics.json
  pending-diff.json
```

For team retros, set `dataDir` in `.patina/config.json` — or use
`patina init --data-repo <url>` to have it set up for you.

`dataDir` supports three formats:

```json
{ "dataDir": "../patina-data" }        // relative to project root (recommended)
{ "dataDir": "../../shared/retro" }    // deeper relative path — resolved from project root
{ "dataDir": "~/my-patina-data" }      // home-directory expansion
```

Absolute paths work too. `patina init --data-repo` always writes a relative path.

Example:

```json
{
  "include": [],
  "exclude": [],
  "dataDir": "../patina-data"
}
```

| Field     | Type       | Default                      | Description                                                                   |
| --------- | ---------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `include` | `string[]` | `[]`                         | Slug substrings of additional projects to ingest (e.g. `["api", "frontend"]`) |
| `exclude` | `string[]` | `[]`                         | Slug substrings to exclude — takes precedence over `include`                  |
| `dataDir` | `string`   | `~/.patina/projects/<slug>/` | Path to shared data directory. Set this for team retros                       |

Set `PATINA_DATA_DIR` to override `dataDir` per-session (useful for testing).

### Multiple repos, one constitution

When a team works across multiple repos sharing the same `PATINA.md`
(e.g. backend + frontend), pull all their session data into one retro via
`include`:

```json
{
  "include": ["my-backend", "my-frontend"],
  "dataDir": "../patina-data"
}
```

`include` matches substrings against the project slug, so it works across
machines. `config.json` is committed — it's a team decision. Use
`patina status` to verify what's being counted.

---

## What gets committed

Everything in `.patina/` is committed — there's nothing to gitignore:

| Path                  | Why                                                          |
| --------------------- | ------------------------------------------------------------ |
| `.patina/PATINA.md`   | The shared AI operating document (slim core)                 |
| `.patina/config.json` | Project include list — team decision, shared across machines |
| `.patina/context/`    | Spoke files — extended context loaded on demand              |
| `.patina/cycles/`     | Each layer — full cycle reports the whole team can read      |

All operational data (sessions, reflections, captures, metrics, pending diffs)
lives in `~/.patina/projects/<slug>/` — machine-local by default, never
committed. Use `dataDir` in `config.json` to share it with the team.

---

## What `PATINA.md` is

Your team's AI operating constitution. The slim core (~50 lines) holds
working agreements, a behavior contract, and hard guardrails. Extended
sections (autonomy map, incident log, eval framework, cycle history) live
in `.patina/context/` as spoke files, loaded on demand.

Any team member can edit it directly. `patina run` routes proposed changes
to the correct file based on section number.

### How agents read it

`patina init` adds `@.patina/PATINA.md` to `CLAUDE.md`. Claude Code's
`@filename` import means every session gets the latest contents
automatically — no restart needed.

---

## Privacy

Everything stays local. Nothing leaves your machine except what you send
to Claude during `patina run`.

Ingested from Claude Code logs: session timestamps, project names, token
estimates, tool-call names and frequencies, rework flags (heuristic).

Never sent to Claude: conversation transcripts, raw session content,
anything outside `.patina/`.

---

## Why it's different

|                 | Where it lives                | Ownership          | Review               |
| --------------- | ----------------------------- | ------------------ | -------------------- |
| `/insights`     | `~/.claude/`, solo            | One person         | None                 |
| `CLAUDE.md`     | In repo                       | Whoever edits last | Sometimes            |
| **`PATINA.md`** | In repo, loaded every session | Whole team         | Always, via git diff |

`/insights` produces a personal HTML report that disappears when the
session ends. `CLAUDE.md` rots while nobody's watching. `PATINA.md`
compounds — every retro adds one deliberate layer, based on the previous
layer and the whole team's learnings.

---

## Early software

Rough edges to expect:

- 120-second timeout on the `claude` CLI call in `patina run`; reflections
  are already saved, so retrying costs nothing
- Session ingestion depends on Claude Code's JSONL format — Anthropic
  changing it will break ingest
- Token estimates are heuristic

Bad diffs and breakage are useful signal — open an issue or ping me.

---

## Context architecture

Patina uses a **hub+spoke** model to keep agent context lean:

```text
.patina/
  PATINA.md              ← slim core (~50 lines, ~500 tokens). Always loaded.
  context/
    autonomy-detail.md   ← full autonomy map with routine scenarios
    incident-log.md      ← past agent incidents
    eval-framework.md    ← eval criteria and pass thresholds
    cycle-history.md     ← retro cycle history
    opportunity-backlog.md ← improvement ideas
```

The **core** (`PATINA.md`) holds only the highest-value content — working
agreements, behavior contract, hard guardrails — loaded every session.
**Spoke files** hold content useful in specific activities (debugging,
testing, retro reviews) and are read on demand. The core has a comment
index pointing to each spoke.

`patina run` routes proposed changes to the correct file by section number.

### Why this matters

Context pollution reduces model precision. The always-loaded core stays
under 80 lines / 3,200 chars, so the constitution never becomes a tax on
agent performance — even after dozens of cycles.

The synthesis prompt enforces the style: imperative, one clause per
bullet, no hedging, no duplicates. Stale entries are flagged for removal
each cycle.

---

## Design decisions

<details>
<summary><b>Why are cycle reports committed but captures and reflections are not?</b></summary>

Input vs. output. Captures, reflections, and session logs are raw material,
ephemeral once the cycle runs. Cycle reports are the permanent team record
— the synthesised insight, proposed change, and metrics per retro — and
belong in git like commit history does.

</details>

<details>
<summary><b>Why <code>PATINA.md</code> instead of editing CLAUDE.md directly?</b></summary>

`PATINA.md` is a structured format Patina can parse, section-match, and
edit safely. `patina init` wires it into `CLAUDE.md` via
`@.patina/PATINA.md`, so Patina never risks corrupting your hand-written
`CLAUDE.md`.

</details>

<details>
<summary><b>Why hub+spoke instead of one file?</b></summary>

A monolithic file grows unboundedly. After 10+ cycles, sections like
incident log and cycle history add hundreds of tokens that are rarely
relevant. Hub+spoke keeps always-loaded context at ~500 tokens while
preserving everything in spoke files for when it's needed.

</details>

<details>
<summary><b>Why the <code>claude</code> CLI instead of the API directly?</b></summary>

No separate API key — respects each teammate's existing Claude Code
authentication and model access. Falls back to `ANTHROPIC_API_KEY` if the
CLI isn't installed.

</details>

<details>
<summary><b>Solo vs. team vs. multi-project — how the same commands scale</b></summary>

**Solo.** `patina reflect` then `patina run`. Everything stays in
`~/.patina/projects/<slug>/`. No config needed.

**Team.** `patina init --data-repo <url>` clones a shared data repo and
wires it up. Everyone captures and reflects; one person runs `patina run`
and the synthesis lands in `PATINA.md`.

**Multiple repos, one constitution.** Add slugs to `include` in
`config.json` to pull session data from all related repos into the same
retro:

```json
{
  "include": ["api", "frontend"],
  "exclude": ["api-legacy"],
  "dataDir": "../patina-data"
}
```

</details>
