// tests/perf-budget.test.ts
//
// Asserts the hook hot path stays under a p95 latency budget on the
// development machine. Budget is 10ms p95 — comfortably above what
// production inline path measures (sub-millisecond) but tight enough
// to catch regressions like accidentally introducing a fs.readSync per
// event, or pulling zod's locale bundle onto the hot path.
//
// Distinct from tests/hook.bench.ts: bench tells you "how fast is it";
// this file says "fail the build if it gets too slow".
//
// We sample 200 iterations and compute p95 via sort. 200 is enough to
// damp out noise (cold caches, GC pauses) but small enough that the
// test suite stays under a second.

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

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

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe("hook hot path stays within budget", () => {
  const BUDGET_MS_P95 = 10;
  const ITERATIONS = 200;

  test(`buildHookOutput p95 < ${BUDGET_MS_P95}ms over ${ITERATIONS} iterations`, () => {
    const config = loadConfig("default.jsonc");
    const event = loadEvent("post-tool-use-skill.json");
    const ctx: PRContext = { branch: "feat/x" };

    // Warm-up runs to prime caches; not counted toward the budget.
    for (let i = 0; i < 20; i++) buildHookOutput(event, config, ctx);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      buildHookOutput(event, config, ctx);
      samples.push(performance.now() - start);
    }

    const p95 = percentile(samples, 95);
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    // Surface the actual numbers in the test failure message when this
    // regresses — easier to triage than "expected less than 10".
    expect(p95, `mean=${mean.toFixed(3)}ms p95=${p95.toFixed(3)}ms`).toBeLessThan(BUDGET_MS_P95);
  });

  test(`with 3 rules: p95 < ${BUDGET_MS_P95}ms`, () => {
    const config = loadConfig("with-3-rules.jsonc");
    const event = loadEvent("post-tool-use-skill.json");
    const ctx: PRContext = { branch: "release-1.0" };

    for (let i = 0; i < 20; i++) buildHookOutput(event, config, ctx);

    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const start = performance.now();
      buildHookOutput(event, config, ctx);
      samples.push(performance.now() - start);
    }
    const p95 = percentile(samples, 95);
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    expect(p95, `mean=${mean.toFixed(3)}ms p95=${p95.toFixed(3)}ms`).toBeLessThan(BUDGET_MS_P95);
  });
});
