# Patina CLI

## Development

```bash
npm run dev          # tsx (no build)
npm run build        # TypeScript → dist/
npm start            # Run compiled output
npx markdownlint-cli2 "**/*.md"  # Lint
```

## Architecture

**Command flow:**
- `capture` → `.patina/captures/<id>.json`
- `ingest` → `.patina/sessions/*.json`
- `run` → Claude CLI (via spawn) → `.patina/cycles/<date>.md`
- `diff` → show pending changes
- `buff` → apply diffs to PATINA.md or spoke files

**Key design:**
- Claude invoked via CLI subprocess in `src/lib/claude.ts`, not SDK
- `.patina/` partially git-tracked: core + cycles + captures committed; sessions/metrics/pending ignored
- Hub+spoke: `PATINA.md` core (sections 1-3), spoke files in `.patina/context/` (on-demand sections 4-6)
- Session dedup by `session_id`; token estimation via `chars / 4` heuristic
- Pending reflection recovery to `.patina/pending-reflection.json`

@.patina/PATINA.md
