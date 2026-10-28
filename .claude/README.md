# What this repository ships under `.claude/`

- `skills/new-site/SKILL.md`: stamps out a site from a Claude Design handoff and `SITE_BRIEF.md`.
- `skills/security-sweep/SKILL.md`: how the owner runs the security sweep, and audits it after.
- `workflows/security-sweep.js`: the sweep itself: recon, lanes, refuters, triage, report.
- `agents/sweep-*.md`: one tool profile per sweep stage, used by the workflow and nothing else.

There is deliberately **no `settings.json`, hook or `.mcp.json`** here: a committed settings file
binds every session in every copy of this template, its owner's included. `tests/sweep/` fails if one
appears, and `tests/sweep/tree.test.ts` fails on any tracked agent-instruction file or dot path
anywhere in the tree that is not on its exact lists.

## The stage tool profiles

| Profile | Stage | Holds |
| --- | --- | --- |
| `sweep-recon` | recon | read, write, shell; no web |
| `sweep-lane` | a lane, and its refuters | read, write, edit, shell; no web |
| `sweep-lane-web` | a lane whose brief needs vendor documentation or advisories | the above, plus WebFetch and WebSearch |
| `sweep-triage` | triage, and the completeness critic | read and write; no shell, no web |
| `sweep-report` | dedupe and the report | read and write; no shell, no web |

A profile narrows a stage; it grants no session anything the launching session doesn't already
hold. Each description says it is not for general delegation, because every definition under
`agents/` is listed to every session in the checkout. A lane's shell can still reach the network
whatever its web tools say, which is why the post-run audit in the sweep's skill is not optional.

The lanes that read the GitHub side (`npm-supply-chain`, `disclosure`, `outsiders`) each carry a
named list of read-only calls in the workflow, and record what they read in `coverage`. The audit
reads those records against the transcripts.
