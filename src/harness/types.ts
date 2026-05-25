// src/harness/types.ts
//
// Shared types for the per-harness hook writers (Claude Code, Codex, future
// LLM tooling harnesses). Each supported harness gets a small adapter that
// knows where its config file lives and how to merge skilled-pr's hook entry
// into the user's existing config without clobbering anything else.
//
// The dispatcher in src/init.ts iterates over the harnesses detected in the
// current repo (or specified via --for) and calls each one's merge function.
// Nothing here knows about a specific harness; specifics live in claude.ts
// and codex.ts.

/** A short, stable identifier for a supported harness. */
export type HarnessName = "claude" | "codex";

/**
 * A harness adapter. Each adapter pairs a config-file location with a pure
 * function that knows how to merge skilled-pr's hook entry into that file's
 * contents.
 *
 * The merge MUST be idempotent: calling it twice on the same input produces
 * the same output, and a no-op when skilled-pr is already wired up. `init`
 * relies on this to safely re-run.
 */
export interface Harness {
  /** Identifier ("claude", "codex"). */
  readonly name: HarnessName;
  /** Human-readable label for log lines (e.g. "Claude Code"). */
  readonly label: string;
  /** Path (relative to repo root) of the settings/hooks file we write. */
  readonly settingsPath: string;
  /**
   * Directory (relative to repo root) where this harness loads bundled
   * skills from. Init copies the `/skilled-pr-update` skill template into
   * `<skillsDir>/skilled-pr-update/<skillFileName>`. Claude Code uses
   * `.claude/skills`; Codex uses `.codex/skills`.
   */
  readonly skillsDir: string;
  /**
   * Filename this harness expects for a skill's instructions inside
   * `<skillsDir>/<skill-name>/`. Claude Code reads `skill.md` (lowercase);
   * Codex's progressive-disclosure model expects `SKILL.md` (uppercase,
   * mirroring the agentskills.io spec).
   */
  readonly skillFileName: string;
  /**
   * Given the existing config (parsed JSON/JSONC, or `null` if no file
   * exists yet), return the merged config that includes skilled-pr's hook.
   * MUST be pure: no I/O, no side effects. The caller does the actual write.
   */
  mergeHooks(existing: unknown): unknown;
}
