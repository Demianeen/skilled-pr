// src/harness/claude.ts
//
// Claude Code hook writer. Targets `.claude/settings.json`.
//
// Wires two hook events:
//   - PostToolUse matcher "Skill"     (model-invoked path: agent runs Skill tool)
//   - UserPromptExpansion matcher ""   (user-typed path: user types /skill-name)
//
// Both invoke `skilled-pr hook` on stdin/stdout. The merge preserves any
// other hooks/settings the user already has.

import type { Harness } from "./types";

const SKILLED_PR_HOOK_COMMAND = "skilled-pr hook";

/** A single hook entry in `.claude/settings.json` (one matcher + one or more commands). */
interface ClaudeHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; [k: string]: unknown }>;
}

/** Shape of `.claude/settings.json`. We touch only `hooks`; everything else is preserved. */
export interface ClaudeSettings {
  hooks?: {
    [eventName: string]: ClaudeHookEntry[];
  };
  [other: string]: unknown;
}

/**
 * Add skilled-pr's PostToolUse + UserPromptExpansion hooks to a Claude
 * settings object, preserving all other settings. Idempotent: if an entry
 * already invokes `skilled-pr hook` for an event, it's left alone.
 *
 * Exported pure for tests; the harness adapter below uses it.
 */
export function mergeSkilledPRHooks(existing: ClaudeSettings | null): ClaudeSettings {
  const hooks: NonNullable<ClaudeSettings["hooks"]> = { ...(existing?.hooks ?? {}) };

  ensureSkilledPRHook(hooks, "PostToolUse", "Skill");
  ensureSkilledPRHook(hooks, "UserPromptExpansion", "");

  return { ...(existing ?? {}), hooks };
}

/**
 * Merge the `PostToolUse:Bash` hook entry that backs
 * `autoReview.trigger=on-push`. Idempotent. Called by init when
 * `autoReview.trigger` is `on-push` AND the Claude harness is in
 * scope — Codex has no PostToolUse:Bash equivalent so the on-push
 * trigger is Claude-only for now.
 *
 * Splitting this from `mergeSkilledPRHooks` keeps the default install
 * (which doesn't know about autoReview yet) minimal; users on
 * trigger=manual don't get a PostToolUse:Bash hook firing on every
 * bash invocation when they don't need it.
 */
export function mergeOnPushBashHook(existing: ClaudeSettings | null): ClaudeSettings {
  const hooks: NonNullable<ClaudeSettings["hooks"]> = { ...(existing?.hooks ?? {}) };
  ensureSkilledPRHook(hooks, "PostToolUse", "Bash");
  return { ...(existing ?? {}), hooks };
}

function ensureSkilledPRHook(
  hooks: NonNullable<ClaudeSettings["hooks"]>,
  event: string,
  matcher: string,
) {
  const entries = hooks[event] ?? [];
  const alreadyPresent = entries.some((e) =>
    e.hooks?.some((h) => h.command === SKILLED_PR_HOOK_COMMAND),
  );
  if (alreadyPresent) {
    hooks[event] = entries;
    return;
  }
  hooks[event] = [
    ...entries,
    {
      matcher,
      hooks: [{ type: "command", command: SKILLED_PR_HOOK_COMMAND }],
    },
  ];
}

export const claudeHarness: Harness = {
  name: "claude",
  label: "Claude Code",
  settingsPath: ".claude/settings.json",
  skillsDir: ".claude/skills",
  skillFileName: "SKILL.md",
  mergeHooks(existing: unknown): unknown {
    return mergeSkilledPRHooks((existing as ClaudeSettings | null) ?? null);
  },
};
