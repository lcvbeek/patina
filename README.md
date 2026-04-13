# Patina

[![npm version](https://img.shields.io/npm/v/@lcvbeek/patina.svg)](https://www.npmjs.com/package/@lcvbeek/patina)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Test coverage](https://img.shields.io/coverallsCoverage/github/lcvbeek/patina)

**Claude doesn't tell you when its instructions are stale. Your team does.**

Patina is the retro loop that keeps your shared AI instructions honest. Every
session, every near-miss, every hard-won team agreement gets captured,
reflected on, and synthesised into `PATINA.md` — a living document owned by
the whole team, versioned in git, and automatically loaded into every Claude
Code session.

Each retro cycle deposits a thin layer. Over time, `PATINA.md` builds into
something with real depth: a shared record of how _your_ team uses AI, shaped
by everyone's voice — including new hires from day one.

Note: you can also use this solo of course, but it shines in a team setting.

---

## The retro loop

```text
patina capture                  # anyone on the team, anytime
  → records a notable moment — near-misses, surprises, patterns

patina reflect                  # each person, before the retro (~10 min)
  → reflection questions (6 included, customizable per team)

patina run                      # one person runs it when the team is ready
  → ingests Claude Code logs from all team members
  → loads every capture and reflection since the last cycle
  → Claude synthesises all voices into a single coaching insight
  → proposes a concrete instruction diff

patina buff                     # the team reviews and applies the diff
  → human approval required before any change lands in PATINA.md
```

Next session, the whole team works from an updated, shared set of instructions.

---

## Why this matters (for teams)

The failure mode of AI instructions isn't bad writing — it's instructions that
duplicate what's already in your codebase, go stale, or reflect one person's
habits instead of the team's. Patina is built around three distinctions:

- **`patina capture`** records things that _happened in sessions_ — surprises,
  near-misses, patterns. These are definitionally non-inferable from reading
  the code, and any teammate can log them, not just the person who was there.
- **`patina reflect`** surfaces institutional knowledge the team holds but
  hasn't written down. Everyone answers before the retro; every voice goes
  into the synthesis.
- **`patina buff`** means a human reviews every proposed change before it's
  committed. Claude proposes; the team decides.
- **`PATINA.md` stays small** (~50 lines). The synthesis prompt trims as well
  as adds, and flags stale entries each cycle.

The result is an instruction file that compounds on real team evidence rather
than generic best-practice boilerplate.

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

## Team setup

**1. One person initialises the project:**

```bash
cd your-project
patina init        # scaffolds .patina/ and wires PATINA.md into CLAUDE.md
patina run         # onboarding questions establish your baseline agreements
patina buff        # review and apply the first proposed changes
git commit -m "First patina layer"
```

**2. Point everyone at a shared data directory:**

Add this to `.patina/config.json` (commit it — it's a team decision):

```json
{
  "dataDir": "../our-patina-data"
}
```

Use a dedicated repo for `dataDir` — files are small, contain no secrets,
and are UUID-named so there are never merge conflicts.

**3. Every cycle from here:**

1. Anyone captures notable moments throughout the cycle with `patina capture`
2. Before the retro, each person runs `patina reflect` on their own machine
3. One person runs `patina run` — it loads all captures and reflections since
   the last cycle and produces a synthesis with every team member's voice
4. Review and apply with `patina buff`, commit the updated `PATINA.md`

Without `dataDir`, data stays local — useful for solo use, but captures and
reflections from other team members won't be included.

---

## Commands

| Command   | What it does                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`    | Scaffold `.patina/` in the current directory, create `PATINA.md`, install the `/patina` Claude Code skill                                               |
| `capture` | Capture a notable moment while it's fresh. Use `--synth` for an immediate Claude interpretation without waiting for the next retro                      |
| `reflect` | Answer reflection questions before the retro — saved locally, loaded by `patina run`. Press Enter to skip any question                                  |
| `run`     | Run the retro — auto-ingests logs, loads all captures + reflections from the team, calls Claude for synthesis                                           |
| `buff`    | Review the proposed instruction change and apply it — shows diff, prompts for confirmation (aliased as `apply`)                                         |
| `status`  | Show metrics: token spend, rework rate, tool usage, trends across cycles. Shows a breakdown by project so you can verify which repos are being included |
| `layers`  | Visualise the patina the team has built — one ASCII layer per retro cycle. Shows 5 most recent by default; use `-n 10` for more or `-n 0` for all       |
| `ask`     | Low-level command used by the `/patina` Claude Code skill — not intended for direct use                                                                 |
| `ingest`  | Manually parse Claude Code logs (optional — `patina run` does this automatically)                                                                       |

### patina init

```bash
patina init
```

Creates `.patina/` with `PATINA.md`, `config.json`, `context/`, and `cycles/`.
Adds `@.patina/PATINA.md` to `CLAUDE.md` (creating it if needed). Also installs
the `/patina` Claude Code skill to `~/.claude/skills/patina/` so any team member
can answer reflection questions from inside any Claude Code session. Safe to run
once per project.

### patina capture

```bash
patina capture "agent almost pushed directly to main — need an approval gate rule"
patina capture --tag near-miss "agent almost pushed directly to main"
patina capture --synth "Claude tried to commit an API key"  # immediate synthesis
patina capture          # interactive mode
```

Tags: `near-miss` / `went-well` / `frustration` / `pattern` / `other`

Anyone on the team can capture at any time — that's the point. Captures are
written to the shared `dataDir` as individual JSON files (one per capture,
UUID-named) so there are never merge conflicts regardless of how many people
are writing simultaneously. Author is read from `git config user.name`.

`--synth` calls Claude immediately after saving the capture — no full retro
cycle needed. It pattern-matches against recent captures and your `PATINA.md`,
prints a concise insight, and queues a proposed instruction change for `patina buff`.

### patina reflect

```bash
patina reflect
```

Walks through the reflection questions and saves answers to the shared data
directory. Press Enter to skip any question. Each person runs this on their
own machine before the retro — `patina run` aggregates all answers recorded
since the last cycle, so no one's perspective is lost.

Reflection questions can be customised by adding `.patina/questions.json`
to the project (committed, so the whole team uses the same set).

### /patina skill (Claude Code)

`patina init` installs a Claude Code skill at `~/.claude/skills/patina/`.
Inside any Claude Code session any team member can answer reflection questions
in chat without switching to a terminal:

```bash
/patina next                           # show the next unanswered question
/patina reflect felt good overall      # record an answer
/patina capture near-miss: almost...   # capture a moment
/patina status                         # cycle metrics
```

After each answer the skill automatically shows the next question, so a
teammate can work through all reflections in a single conversation. The
underlying `patina ask` command is not intended for direct use — it exists
as a machine-readable interface for the skill.

### patina run

```bash
patina run
patina run --onboard # force onboarding questions
```

Auto-ingests Claude Code logs, loads all captures and reflections the team
has recorded since the last cycle, calls Claude for synthesis, and writes the
result to `.patina/cycles/<date>.md` and a pending diff. On first run, asks
onboarding questions to establish your team's baseline agreements.

### patina buff

```bash
patina buff          # show diff, prompt to apply
patina buff --yes    # apply without prompting
patina apply         # alias
```

Shows the pending instruction diff from the last `patina run` — rationale,
target file, and the proposed addition — then prompts for confirmation.
This is the team's moment to review before anything changes. Applies to the
correct file (core or spoke, based on section number) and clears the pending diff.

### patina status

```bash
patina status
```

Shows token spend, rework rate, tool usage, and trends across cycles.
Includes a per-project breakdown so the team can verify which repos are
contributing to shared metrics.

### patina layers

```bash
patina layers        # 5 most recent cycles
patina layers -n 10  # last 10
patina layers -n 0   # all
```

Renders one ASCII layer per retro cycle — a quick visual of how the team's
patina has built up over time. Useful to share at the start of a retro.

### patina ingest

```bash
patina ingest
```

Manually parses Claude Code JSONL logs and writes session summaries to the
data dir. `patina run` does this automatically — use this to pre-populate
metrics or debug ingestion. By default, only sessions from the **current
project** are ingested — Patina derives the project slug from your working
directory and matches it against `~/.claude/projects/`.

---

## Data directory

All operational data — sessions, captures, reflections, metrics, and pending
diffs — lives outside the project repo. By default it goes to each team
member's local machine:

```bash
~/.patina/projects/<slug>/
  sessions/
  captures/
  reflections/
  metrics.json
  pending-diff.json
```

For team retros, set `dataDir` in `.patina/config.json` to a shared location.
Paths starting with `~/` are expanded; other paths are resolved relative to
the project root:

```json
{
  "include": [],
  "exclude": [],
  "dataDir": "../our-patina-data"
}
```

| Field     | Type       | Default                      | Description                                                                   |
| --------- | ---------- | ---------------------------- | ----------------------------------------------------------------------------- |
| `include` | `string[]` | `[]`                         | Slug substrings of additional projects to ingest (e.g. `["api", "frontend"]`) |
| `exclude` | `string[]` | `[]`                         | Slug substrings to exclude — takes precedence over `include`                  |
| `dataDir` | `string`   | `~/.patina/projects/<slug>/` | Path to shared data directory. Set this for team retros                       |

You can also set `PATINA_DATA_DIR` as an environment variable to override
`dataDir` per-session (useful for testing).

### Multiple repos, one shared constitution

If the team works across multiple repos that share the same `PATINA.md`
(e.g. a backend and a frontend), pull their session data into a single retro
using the `include` list:

```json
{
  "include": ["my-backend", "my-frontend"],
  "dataDir": "../our-patina-data"
}
```

Entries in `include` are matched as substrings against the project slug, so
they work across machines regardless of home directory. `config.json` is
committed — it's a team decision, not a personal one. Run `patina status`
to see a breakdown by project and confirm what's being counted.

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

Your team's AI operating constitution. The slim core (~50 lines) has
sections for working agreements, a behavior contract, and hard guardrails —
automatically loaded into every Claude Code session for every team member.
Extended sections (autonomy map, incident log, eval framework, cycle history)
live in `.patina/context/` as spoke files loaded on demand.

`patina buff` routes proposed changes to the correct file.
The file is yours — any team member can edit it directly. Patina treats it
as the source of truth for how your team works with AI and passes it to
Claude during synthesis.

### How agents read it

`patina init` adds the following line to your project's `CLAUDE.md`:

```text
@.patina/PATINA.md
```

Claude Code's `@filename` import syntax means every Claude Code session —
for every team member — automatically gets the contents of `PATINA.md`.
When `patina buff` updates it, Claude picks up the change in the next session.

---

## Privacy

Everything stays local. No data leaves your machine except what you choose
to send to Claude via the `claude` CLI during `patina run`.

What gets ingested from Claude Code logs:

- Session timestamps and project names
- Estimated token counts
- Tool call names and frequencies
- Whether a session contained rework (detected heuristically from the JSONL)

What is never sent to Claude:

- Raw session content or conversation transcripts
- Anything outside `.patina/`

---

## How is this different from Claude Code's `/insights`?

`/insights` produces a personal HTML report in `~/.claude/` — useful
analysis, but it belongs to one person and doesn't persist between sessions.
Patina produces `PATINA.md`, a structured document that lives in your repo,
is versioned with git, and accumulates layers across cycles. Every team
member shapes it; every team member benefits from it. The goal isn't better
analysis — it's a shared artifact the team actually owns and maintains together.

---

## Early software

This is early software. It works, but expect rough edges:

- The `claude` CLI call in `patina run` has a 120-second timeout; if Claude
  is slow the command will fail (reflection answers are already saved by
  `patina reflect`, so any team member can retry `patina run` without re-answering)
- Session ingestion parses Claude Code's JSONL format — if Anthropic changes
  that format, ingestion will break
- Token estimates are heuristic, not exact

If something breaks or the instruction diff Claude produces is bad, that's
useful signal. Open an issue or message me directly.

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

The **core** (`PATINA.md`) contains only the highest-value content: working
agreements, a behavior contract, and hard guardrails. It's loaded into
every Claude Code session via `@.patina/PATINA.md` in `CLAUDE.md`.

**Spoke files** hold content that's useful during specific activities
(debugging, testing, retro reviews) but would waste tokens if loaded every
session. Agents can read them on demand when relevant — the core includes a
comment index pointing to each spoke file.

`patina buff` automatically routes proposed changes to the correct file
based on section number. `patina migrate` splits an existing monolithic
`PATINA.md` into the hub+spoke layout.

### Why this matters

Context pollution reduces model precision. Anthropic's research shows that
the smallest high-signal token set produces the best results. By keeping the
always-loaded core under 80 lines / 3,200 chars, Patina ensures the
constitution never becomes a tax on your team's agent performance — even
after dozens of retro cycles.

The synthesis prompt enforces this: proposed instructions must be imperative,
apply to >50% of sessions, and not duplicate existing entries. Stale entries
are flagged for removal each cycle. Style rules mirror the init template —
one clause per bullet, no inline rationale, no hedging words — so every buff
cycle adds entries that read like the rest of `PATINA.md`, not like prose.

---

## Design decisions

<details>
<summary><b>Why are cycle reports committed but captures and reflections are not?</b></summary>

The distinction is input vs. output. Captures, reflections, and session logs
are raw material that feeds the synthesis — they're per-machine, per-person,
and ephemeral once the cycle runs. Cycle reports (`.patina/cycles/<date>.md`)
are the permanent team record: the synthesised insight, proposed instruction
changes, and metrics for each retro. They're what `patina layers` visualises
and what new team members read to understand how the team's AI practice has
evolved. They belong in git for the same reason commit history does.

Everything operational lives in `~/.patina/projects/<slug>/` (or a shared
`dataDir`) and is never committed. Nothing in `.patina/` needs to be gitignored.

</details>

<details>
<summary><b>Why <code>PATINA.md</code> instead of editing CLAUDE.md directly?</b></summary>

`PATINA.md` is a structured format Patina can reliably parse, section-match,
and append to. `patina init` wires it into your `CLAUDE.md` via
`@.patina/PATINA.md`, so every team member's agent sessions always get the
latest version. Keeping it separate means Patina never risks corrupting
your hand-written `CLAUDE.md` content.

</details>

<details>
<summary><b>Why hub+spoke instead of one file?</b></summary>

A monolithic `PATINA.md` grows unboundedly as cycles accumulate. After 10+
cycles, sections like incident log and cycle history add hundreds of tokens
that are rarely relevant. The hub+spoke model keeps always-loaded context at
~500 tokens while preserving all data in spoke files for when it's needed.
See [Context architecture](#context-architecture) for details.

</details>

<details>
<summary><b>Why the <code>claude</code> CLI instead of the API directly?</b></summary>

No separate API key needed — it respects each team member's existing Claude
Code authentication and model access. If you don't have the CLI, set
`ANTHROPIC_API_KEY` and Patina falls back to the SDK.

</details>

<details>
<summary><b>Solo vs. team vs. multi-project — how the same commands scale</b></summary>

**Solo, one project.** Run `patina reflect` then `patina run`. Everything
stays in `~/.patina/projects/<slug>/`. No config needed.

**Team, one project.** Add `dataDir` to `.patina/config.json` pointing at a
shared repo. Everyone's captures, reflections, and session data land in the
same place. Each person runs `patina reflect` on their own machine before the
retro; whoever runs `patina run` gets a synthesis with all voices included.

**Team, multiple repos sharing one constitution.** Add slugs to `include` in
`config.json` so `patina ingest` pulls session data from all related repos
into the same retro. Use `patina status` to verify what's being counted.

```json
{
  "include": ["api", "frontend"],
  "exclude": ["api-legacy"],
  "dataDir": "../our-patina-data"
}
```

The project repo (`PATINA.md`, `cycles/`, `config.json`) stays in git. The
data repo (`dataDir`) is a separate, never-built repo that just accumulates
JSON files.

</details>
