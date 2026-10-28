/**
 * What names a file an agent may load as instructions, and how a name is folded to compare it.
 * One list for two jobs: ingest never writes such a file from a design bundle, and
 * tests/sweep/tree.test.ts refuses one anywhere in the tracked tree that is not on its list.
 */

/**
 * A name folded as case-insensitive and normalising filesystems fold it, or more strictly: NFKC,
 * then lower-, upper- and lower-cased, so `ſ` is `s`, `ﬆ` is `st`, the Kelvin sign is `k`,
 * fullwidth letters are ASCII, and `ß` and `ẞ` are both `ss`. The first lower-casing takes `ẞ` to
 * `ß`, which the upper-casing then takes to `SS`, so a folded name folds to itself. Used for
 * agent-instruction and tool-configuration names, and duplicates.
 */
export const fold = (/** @type {string} */ name) => name.normalize('NFKC').toLowerCase().toUpperCase().toLowerCase();

/**
 * Agent-instruction file names, compared lower-cased; so is the `.mdc` suffix. With them, the two
 * agent configurations a tool loads under a name with no dot, `opencode.json` and `crush.json`,
 * since each can launch MCP servers. The `.md` context-file names other tools load (`QWEN.md` and
 * the like) are not listed: ingest renames every such file, and the tests pin that.
 */
export const INSTRUCTIONS = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'agent.md', 'skill.md', 'gemini.md', 'copilot-instructions.md', 'opencode.json', 'crush.json']);

/** True when one path segment names agent instructions: a name in INSTRUCTIONS, or a `.mdc` file, both folded. */
export const namesAgentInstructions = (/** @type {string} */ segment) => {
  const folded = fold(segment);
  return INSTRUCTIONS.has(folded) || folded.endsWith('.mdc');
};
