// src/harness/detect.ts
//
// Decide which harness(es) `skilled-pr init` should wire hooks for.
//
// Default policy: detect what's already installed in the repo. If `.claude/`
// exists, the user has Claude Code; if `.codex/` exists, the user has Codex.
// Multiple are allowed (someone might use both).
//
// If we detect neither, fall back to Claude Code only. That preserves the
// pre-Codex behaviour (`skilled-pr init` always set up `.claude/`) and avoids
// surprising users who haven't run any harness yet.

import { existsSync } from "node:fs";

import { claudeHarness } from "./claude";
import { codexHarness } from "./codex";
import type { Harness, HarnessName } from "./types";

const ALL_HARNESSES: ReadonlyArray<Harness> = [claudeHarness, codexHarness];

/** Filter `ALL_HARNESSES` to the ones whose root directory exists. */
export function detectHarnesses(cwd: string = process.cwd()): Harness[] {
  const detected = ALL_HARNESSES.filter((h) => {
    const rootDir = h.settingsPath.split("/")[0];
    return existsSync(`${cwd}/${rootDir}`);
  });
  // If nothing detected, default to Claude Code so first-time users get the
  // historical behaviour. Empty repo + `skilled-pr init` should still produce
  // a working Claude setup.
  return detected.length > 0 ? detected : [claudeHarness];
}

/**
 * Resolve a user-supplied `--for` value to one or more harness adapters.
 * Accepts "claude", "codex", "both", or "all". Returns `null` if the value
 * is unrecognised so the caller can surface a clear error.
 */
export function resolveHarnessOverride(value: string): Harness[] | null {
  switch (value) {
    case "claude":
      return [claudeHarness];
    case "codex":
      return [codexHarness];
    case "both":
    case "all":
      return [...ALL_HARNESSES];
    default:
      return null;
  }
}

/** All known harnesses, in stable order. Exposed for tests. */
export function listAllHarnesses(): ReadonlyArray<Harness> {
  return ALL_HARNESSES;
}

/** Lookup a harness by its name. Returns `undefined` if unknown. */
export function getHarnessByName(name: HarnessName): Harness | undefined {
  return ALL_HARNESSES.find((h) => h.name === name);
}
