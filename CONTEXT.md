# Patina

Patina is a CLI that runs a continuous reflection loop over a developer's Claude Code sessions. It turns conversation history into proposed edits against a single governance document (`PATINA.md`) that subsequent sessions read.

## Language

**PATINA.md**:
The governance document that codifies how Claude should behave in this project. Patina's reason for existing — every cycle produces a proposed edit to it.
_Avoid_: instructions file, rules file, config

**Cycle**:
A synthesis pass over a window of Sessions, Captures, and Reflections. Produces a cycle markdown report, a pending diff against PATINA.md, and a metrics entry.
_Avoid_: run, sync, batch

**Session**:
One Claude Code conversation, deduped by `session_id`. Ingested from Claude's local JSONL transcript files.
_Avoid_: conversation, chat, transcript

**Capture**:
A user-noted moment recorded mid-session — tagged `near-miss`, `went-well`, `frustration`, `pattern`, or `other`.
_Avoid_: note, observation, event

**Reflection**:
A user's answer to a configured question, asked during a cycle.
_Avoid_: response, journal entry

**Spoke files**:
On-demand context files under `.patina/context/` (sections 4–7 of PATINA.md). The hub (`PATINA.md`) stays small; spokes are loaded only when synthesis needs them.
_Avoid_: extensions, addons

**Pending diff**:
A proposed but not-yet-applied edit to PATINA.md emitted by a cycle. Written to `.patina/pending-diff.json`; consumed by `patina apply` (or `buff`).
_Avoid_: patch, proposal, draft

## Relationships

- A **Cycle** consumes **Sessions**, **Captures**, and **Reflections** from a time window and emits a cycle markdown report, a **Pending diff**, and a metrics entry.
- A **Pending diff** targets **PATINA.md** or one of its **Spoke files**.
- **Sessions** are ingested from Claude transcripts; **Captures** and **Reflections** are user-authored.

## Example dialogue

> **Dev:** "If I run `patina run` twice in a day, do I get two **Cycles**?"
> **Domain expert:** "No — a **Cycle** is dated, so a second run on the same day updates the existing **Cycle** entry rather than creating a new one. The **Pending diff** is overwritten."

## Flagged ambiguities

- "run" was used to mean both the `patina run` command and the resulting **Cycle**. Resolved: the command is `patina run`; the artifact it produces is a **Cycle**.
</content>
</invoke>