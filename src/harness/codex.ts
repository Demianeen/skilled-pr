// src/harness/codex.ts
//
// Codex hook writer. Targets `.codex/hooks.json`.
//
// Codex's hook system has the same general shape as Claude Code's (read JSON
// on stdin, emit a JSON payload on stdout that injects additional context),
// with two important differences for skilled-pr's purposes:
//
//   1. Codex skills don't surface as a discrete `Skill` tool call. They're
//      markdown files the agent reads via the same file-read tool it uses
//      for any other file ("progressive disclosure"). So there is no
//      PostToolUse:Skill event to match on.
//
//   2. Instead we hook `UserPromptSubmit` and let `skilled-pr hook` decide
//      whether the submitted prompt names a required skill (via slash-command
//      syntax like `/review`). This catches the user-typed invocation path,
//      which is the right anchor: gate enforcement should follow user intent,
//      not agent inference.
//
// The merge preserves any other hooks Codex already has configured.

import type { Harness } from "./types";

const SKILLED_PR_HOOK_COMMAND = "skilled-pr hook";

/** A single hook entry in `.codex/hooks.json`. */
interface CodexHookEntry {
  event: string;
  command: string;
  [k: string]: unknown;
}

/** Shape of `.codex/hooks.json`. We touch only `hooks`; everything else is preserved. */
export interface CodexSettings {
  hooks?: CodexHookEntry[];
  [other: string]: unknown;
}

/**
 * Add skilled-pr's UserPromptSubmit hook to a Codex hooks config, preserving
 * all other entries. Idempotent: if an entry already invokes `skilled-pr
 * hook` on UserPromptSubmit, it's left alone.
 */
export function mergeCodexHooks(existing: CodexSettings | null): CodexSettings {
  const entries = existing?.hooks ?? [];
  const alreadyPresent = entries.some(
    (e) => e.event === "UserPromptSubmit" && e.command === SKILLED_PR_HOOK_COMMAND,
  );
  if (alreadyPresent) {
    return { ...(existing ?? {}), hooks: entries };
  }
  return {
    ...(existing ?? {}),
    hooks: [
      ...entries,
      { event: "UserPromptSubmit", command: SKILLED_PR_HOOK_COMMAND },
    ],
  };
}

export const codexHarness: Harness = {
  name: "codex",
  label: "Codex",
  settingsPath: ".codex/hooks.json",
  skillsDir: ".codex/skills",
  skillFileName: "SKILL.md",
  mergeHooks(existing: unknown): unknown {
    return mergeCodexHooks((existing as CodexSettings | null) ?? null);
  },
};
