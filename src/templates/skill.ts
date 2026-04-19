/**
 * Template for the /patina Claude Code skill.
 * Written to ~/.claude/skills/patina/SKILL.md by `patina init --skill`.
 */
export const PATINA_SKILL_TEMPLATE = `---
name: patina
description: Interact with Patina from within a Claude Code session — answer one reflection question, capture a moment, or check cycle status without leaving chat.
allowed-tools: Bash, Read
---

## /patina [subcommand] [args]

Thin wrapper around the \`patina\` CLI. Use when the user wants to record a micro-reflection, capture a moment, or check retro status from inside a Claude Code session.

The user typed: $ARGUMENTS

### Routing

Parse \`$ARGUMENTS\` and run the matching Patina CLI command via Bash. If \`patina\` is not on PATH, fall back to \`npx tsx src/index.ts\` from the project root.

| User input | Action |
|---|---|
| \`reflect <answer>\` | Record the answer to the next unanswered question: \`patina ask --answer "<text>"\` |
| \`reflect <key> <answer>\` | Record the answer to a specific question: \`patina ask --key <key> --answer "<text>"\` |
| \`next\` | Show the next unanswered question: \`patina ask --show\` |
| \`status\` | Show cycle status: \`patina status\` |
| \`capture <text>\` | Capture a notable moment: \`patina capture "<text>"\` |
| (empty) | Print this help — list the subcommands above |

### Behaviour rules

- **Always use \`--json\` when you need to read back state.** For example, before recording an answer, run \`patina ask --json --show\` to confirm which question will be targeted, then \`patina ask --json --answer "<text>"\` to save it. Parse the JSON, surface the result to the user in plain language.
- **Quote answers safely.** Wrap user-supplied text in double quotes and escape existing double quotes so shell parsing is unambiguous.
- **Never assume which question is being answered.** If the user says \`/patina reflect "Claude nailed it"\` without a key, let the CLI pick the next unanswered one and tell the user which question was recorded against.
- **Be terse.** One or two lines of confirmation. No preamble.

### Capture triggers (when to suggest \`/patina capture\`)

If the user expresses any of the below in-chat, offer to capture it. Always ask for confirmation before recording.

Map to tags:

- **near-miss**: "almost", "accidentally", "caught it just in time", "glad we didn't"
- **frustration**: "stuck", "this is annoying", "ugh", "why is this so hard"
- **went-well**: "that was smooth", "worked first try", "nice"
- **pattern**: "again", "every time", "we always", "this keeps happening"

When capturing, prefer a short, human-written summary. Do not paste long transcript excerpts from the session; Patina already ingests session logs separately.

### Conversational intent

Beyond explicit \`/patina\` invocations, if the user spontaneously answers a reflection question in chat (e.g., "honestly, this cycle felt rushed"), offer to record it: "Want me to save that as your answer to \`overall_feel\`?" — only record after confirmation.

Similarly, if the user shares a notable moment (near-miss / frustration / pattern / went-well), offer to capture it with \`/patina capture\`.

### Examples

**User:** \`/patina reflect Claude handled the refactor cleanly, minimal rework\`
**You:** Run \`patina ask --json --answer "Claude handled the refactor cleanly, minimal rework"\`, parse the response, report: "✓ Recorded against \`went_well\`. 4 of 6 remaining."

**User:** \`/patina next\`
**You:** Run \`patina ask --json --show\`, report the question text and key.

**User:** \`/patina capture near-miss: Claude almost force-pushed main\`
**You:** Run \`patina capture --tag near-miss "Claude almost force-pushed main"\`, report success.

**User:** \`/patina\` (no args)
**You:** Print the routing table above as help.
`;
