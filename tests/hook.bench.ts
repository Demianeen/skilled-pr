// tests/hook.bench.ts
//
// Microbenchmark for the production hook path: parse config + resolve
// profile + format reminder. Runs against fixture configs/events so
// the measurement is reproducible.
//
// Why this exists: hook fires on EVERY PostToolUse:Skill and
// UserPromptExpansion event in a Claude Code session. p95 latency
// shows up as visible UI lag if it climbs into the hundreds of
// milliseconds. tests/perf-budget.test.ts enforces a budget; this
// file gives you raw numbers when investigating regressions.
//
// Run: pnpm bench

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { bench, describe } from "vitest";

import { parseConfig } from "../src/config";
import { buildHookOutput } from "../src/hook";
import type { PRContext } from "../src/resolve";

const here = dirname(fileURLToPath(import.meta.url));

function loadConfig(name: string) {
  const raw = readFileSync(join(here, "fixtures", "configs", name), "utf8");
  return parseConfig(raw);
}

function loadEvent(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(here, "fixtures", "events", name), "utf8"));
}

const CTX: PRContext = { branch: "feat/x" };
const RELEASE_CTX: PRContext = { branch: "release-1.0" };

describe("hook hot path", () => {
  // The cheapest realistic case: default config, no rules, PostToolUse
  // event for a required skill. This is what the hook does on every
  // fire in the dominant code path.
  bench("production (inline resolveProfile + formatReminder)", () => {
    const config = loadConfig("default.jsonc");
    const event = loadEvent("post-tool-use-skill.json");
    buildHookOutput(event, config, CTX);
  });

  // Same path but with the upper-bound rule shape (3 rules, mixed
  // matchers). Demonstrates how rule resolution scales with rule
  // count. Should still be sub-millisecond.
  bench("production with 3 rules (release-* matches first)", () => {
    const config = loadConfig("with-3-rules.jsonc");
    const event = loadEvent("post-tool-use-skill.json");
    buildHookOutput(event, config, RELEASE_CTX);
  });

  // Codex code path: UserPromptSubmit with a leading slash. Slightly
  // different bail-out shape than Claude Code's PostToolUse; useful
  // for catching codepath-specific regressions.
  bench("Codex UserPromptSubmit (with /review)", () => {
    const config = loadConfig("default.jsonc");
    const event = loadEvent("user-prompt-submit.json");
    buildHookOutput(event, config, CTX);
  });
});
