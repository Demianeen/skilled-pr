// src/harness/index.ts
//
// Re-exports for the harness module. Consumers (init.ts, doctor.ts, tests)
// import from "./harness" not the individual files, so we can reorganise
// internals without churning import sites.

export type { Harness, HarnessName } from "./types";
export { claudeHarness, mergeSkilledPRHooks } from "./claude";
export type { ClaudeSettings } from "./claude";
export { codexHarness, mergeCodexHooks } from "./codex";
export type { CodexSettings } from "./codex";
export {
  detectHarnesses,
  resolveHarnessOverride,
  listAllHarnesses,
  getHarnessByName,
} from "./detect";
