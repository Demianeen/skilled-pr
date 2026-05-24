import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  claudeHarness,
  codexHarness,
  detectHarnesses,
  mergeCodexHooks,
  mergeSkilledPRHooks,
  listAllHarnesses,
  getHarnessByName,
  resolveHarnessOverride,
} from "../src/harness";

// ---------------------------------------------------------------------------
// mergeCodexHooks
// ---------------------------------------------------------------------------

describe("mergeCodexHooks", () => {
  test("creates the hooks array when nothing exists", () => {
    const merged = mergeCodexHooks(null);
    expect(merged.hooks).toEqual([
      { event: "UserPromptSubmit", command: "skilled-pr hook" },
    ]);
  });

  test("appends to existing hooks without clobbering them", () => {
    const existing = {
      hooks: [
        { event: "SessionStart", command: "/usr/local/bin/notify" },
      ],
    };
    const merged = mergeCodexHooks(existing);
    expect(merged.hooks).toHaveLength(2);
    expect(merged.hooks?.[0]).toEqual({
      event: "SessionStart",
      command: "/usr/local/bin/notify",
    });
    expect(merged.hooks?.[1]).toEqual({
      event: "UserPromptSubmit",
      command: "skilled-pr hook",
    });
  });

  test("is idempotent when our hook already exists", () => {
    const existing = {
      hooks: [{ event: "UserPromptSubmit", command: "skilled-pr hook" }],
    };
    const merged = mergeCodexHooks(existing);
    expect(merged.hooks).toHaveLength(1);
    expect(merged.hooks).toEqual(existing.hooks);
  });

  test("preserves unrelated top-level fields", () => {
    const existing = {
      hooks: [],
      models: { default: "gpt-5" },
      version: "1.2.3",
    };
    const merged = mergeCodexHooks(existing as any) as any;
    expect(merged.models).toEqual({ default: "gpt-5" });
    expect(merged.version).toBe("1.2.3");
  });

  test("matches our hook by exact command string (not by event alone)", () => {
    // If someone has a different UserPromptSubmit hook installed, we still
    // add ours alongside instead of stomping it.
    const existing = {
      hooks: [{ event: "UserPromptSubmit", command: "/other/tool" }],
    };
    const merged = mergeCodexHooks(existing);
    expect(merged.hooks).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Harness registry / lookup
// ---------------------------------------------------------------------------

describe("listAllHarnesses", () => {
  test("includes claude and codex", () => {
    const names = listAllHarnesses().map((h) => h.name);
    expect(names).toContain("claude");
    expect(names).toContain("codex");
  });
});

describe("getHarnessByName", () => {
  test("returns the matching harness", () => {
    expect(getHarnessByName("claude")?.settingsPath).toBe(".claude/settings.json");
    expect(getHarnessByName("codex")?.settingsPath).toBe(".codex/hooks.json");
  });
});

describe("resolveHarnessOverride", () => {
  test('"claude" → just claude', () => {
    const r = resolveHarnessOverride("claude");
    expect(r).not.toBeNull();
    expect(r?.map((h) => h.name)).toEqual(["claude"]);
  });

  test('"codex" → just codex', () => {
    const r = resolveHarnessOverride("codex");
    expect(r).not.toBeNull();
    expect(r?.map((h) => h.name)).toEqual(["codex"]);
  });

  test('"both" → claude and codex', () => {
    const r = resolveHarnessOverride("both");
    expect(r?.map((h) => h.name).sort()).toEqual(["claude", "codex"]);
  });

  test('"all" is an alias for "both"', () => {
    const r = resolveHarnessOverride("all");
    expect(r?.map((h) => h.name).sort()).toEqual(["claude", "codex"]);
  });

  test("unknown values return null", () => {
    expect(resolveHarnessOverride("cursor")).toBeNull();
    expect(resolveHarnessOverride("")).toBeNull();
  });
});

describe("detectHarnesses", () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempRepo() {
    const dir = mkdtempSync(join(tmpdir(), "skilled-pr-detect-"));
    temps.push(dir);
    return dir;
  }

  test("returns Claude when only .claude is present", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, ".claude"));
    expect(detectHarnesses(dir).map((h) => h.name)).toEqual(["claude"]);
  });

  test("returns Codex when only .codex is present", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, ".codex"));
    expect(detectHarnesses(dir).map((h) => h.name)).toEqual(["codex"]);
  });

  test("returns both harnesses in stable order when both dirs are present", () => {
    const dir = tempRepo();
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, ".codex"));
    expect(detectHarnesses(dir).map((h) => h.name)).toEqual(["claude", "codex"]);
  });

  test("falls back to Claude when neither harness dir is present", () => {
    expect(detectHarnesses(tempRepo()).map((h) => h.name)).toEqual(["claude"]);
  });
});

// ---------------------------------------------------------------------------
// Adapter shape (claudeHarness, codexHarness)
// ---------------------------------------------------------------------------

describe("Harness adapter shapes", () => {
  test("claudeHarness wires PostToolUse + UserPromptExpansion", () => {
    const merged = claudeHarness.mergeHooks(null) as any;
    expect(Object.keys(merged.hooks)).toEqual(
      expect.arrayContaining(["PostToolUse", "UserPromptExpansion"]),
    );
  });

  test("codexHarness wires UserPromptSubmit", () => {
    const merged = codexHarness.mergeHooks(null) as any;
    expect(merged.hooks).toEqual([
      { event: "UserPromptSubmit", command: "skilled-pr hook" },
    ]);
  });

  test("claudeHarness delegates to mergeSkilledPRHooks (sanity check)", () => {
    // The adapter is a thin wrapper. If mergeSkilledPRHooks output matches
    // the adapter output, the wrapper isn't dropping any fields.
    const direct = mergeSkilledPRHooks(null);
    const viaAdapter = claudeHarness.mergeHooks(null);
    expect(viaAdapter).toEqual(direct);
  });
});
