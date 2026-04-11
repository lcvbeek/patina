# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run via tsx (no build step)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled output

# Run a specific command during development
npx tsx src/index.ts init
npx tsx src/index.ts ingest --verbose
npx tsx src/index.ts status
npx tsx src/index.ts run
npx tsx src/index.ts diff
npx tsx src/index.ts buff
npx tsx src/index.ts capture "something happened"
npx tsx src/index.ts capture --tag near-miss "agent almost did X"
```

There are no tests yet. Markdown linting: `npx markdownlint-cli2 "**/*.md"`.

## Architecture

```bash
patina capture  →  .patina/captures/<id>.json
patina capture --synth → .patina/captures/<id>.json + .patina/pending-diff.json
patina reflect  →  <dataDir>/reflections/<id>.json
patina ingest   →  .patina/sessions/*.json
patina run      →  prompts user → calls Claude CLI → .patina/cycles/<date>.md + .patina/pending-diff.json
patina diff     →  displays pending-diff.json
patina buff     →  applies pending diff to .patina/PATINA.md or spoke file
```

**Key architectural decisions:**

- **Claude is called via async `spawn('claude', ['-p', ...])`**
  in `src/lib/claude.ts:callViaCli()` — not via the Anthropic SDK
  (which is installed but unused).
  The CLI subprocess receives the full prompt on stdin and returns raw JSON.

- **`.patina/` is partially tracked in git.**
  Committed: `PATINA.md`, `context/`, `cycles/`, `captures/`.
  Gitignored: `sessions/`, `metrics.json`, `pending-diff.json`,
  `pending-reflection.json`.

- **Hub+spoke context architecture.**
  `PATINA.md` is the slim core (~50 lines, ~500 tokens) with sections 1-3
  (Working Agreements, Behavior Contract, Hard Guardrails) always loaded via
  `@.patina/PATINA.md`. Sections 4-6 live in `.patina/context/` as spoke
  files loaded on demand: `autonomy-detail.md`, `incident-log.md`,
  `eval-framework.md`, `cycle-history.md`.
  `opportunity-backlog.md` lives at `.patina/opportunity-backlog.md` (not in context/).
  `patina buff` routes diffs to core or spoke files based on section number.

- **`patina capture`** writes one JSON file per capture to
  `.patina/captures/`. `patina run` loads all captures since
  `lastCycleDate` and includes them in the synthesis prompt.

- **Session deduplication** is by `session_id` —
  `ingestCommand` calls `sessionExists()` before writing.
  `runIngest()` is also called silently at the start of `patina run`.

- **Token estimation** is a character-count heuristic (`chars / 4`) in
  `parser.ts`. `discoverProjects()` handles both the old
  `conversations.jsonl` layout and the newer per-session UUID files.

- **Rework detection** is heuristic phrase-matching on assistant message
  text (see `REWORK_PHRASES` in `parser.ts`).

- **Pending reflection recovery**: if the Claude CLI call fails,
  reflection answers are saved to `.patina/pending-reflection.json`
  and reloaded on the next `patina run`.

## Naming history

The project was renamed from `retro-ai` → `patina`. The directory was `.retro/` → `.patina/`, the living doc was `living-doc.md` → `PATINA.md`.

@.patina/PATINA.md
