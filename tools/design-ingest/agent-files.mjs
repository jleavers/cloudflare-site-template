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

/** Agent-instruction file names, compared lower-cased; so is the `.mdc` suffix. */
export const INSTRUCTIONS = new Set(['claude.md', 'claude.local.md', 'agents.md', 'agents.override.md', 'agent.md', 'skill.md', 'gemini.md', 'copilot-instructions.md']);

/** True when one path segment names agent instructions: a name in INSTRUCTIONS, or a `.mdc` file, both folded. */
export const namesAgentInstructions = (/** @type {string} */ segment) => {
  const folded = fold(segment);
  return INSTRUCTIONS.has(folded) || folded.endsWith('.mdc');
};
