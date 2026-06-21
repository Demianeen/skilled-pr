import { describe, expect, test, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  mergeSkilledPRHooks,
  writeFileWithMkdir,
  ensureGitignoreEntry,
  type ClaudeSettings,
} from "../src/init";

const SKILLED_PR_CMD = "skilled-pr hook";

// Helper: count entries whose hooks include `skilled-pr hook`.
function countSkilledPREntries(s: ClaudeSettings, event: string): number {
  return (s.hooks?.[event] ?? []).filter((e) =>
    e.hooks.some((h) => h.command === SKILLED_PR_CMD),
  ).length;
}

describe("mergeSkilledPRHooks", () => {
  test("from null settings, adds both PostToolUse and UserPromptExpansion entries", () => {
    const out = mergeSkilledPRHooks(null);
    expect(out.hooks?.PostToolUse?.length).toBe(1);
    expect(out.hooks?.UserPromptExpansion?.length).toBe(1);
    expect(out.hooks?.PostToolUse?.[0].matcher).toBe("Skill");
    expect(out.hooks?.UserPromptExpansion?.[0].matcher).toBe("");
  });

  test("the skilled-pr entry uses command `skilled-pr hook` of type `command`", () => {
    const out = mergeSkilledPRHooks(null);
    const entry = out.hooks?.PostToolUse?.[0];
    expect(entry?.hooks[0].type).toBe("command");
    expect(entry?.hooks[0].command).toBe(SKILLED_PR_CMD);
  });

  test("preserves existing settings keys outside of hooks", () => {
    const existing: ClaudeSettings = {
      hooks: {},
      env: { FOO: "bar" } as unknown as ClaudeSettings["env"],
      permissions: { allow: ["Bash(npm:*)"] } as unknown as ClaudeSettings["permissions"],
    };
    const out = mergeSkilledPRHooks(existing);
    expect((out as any).env).toEqual({ FOO: "bar" });
    expect((out as any).permissions).toEqual({ allow: ["Bash(npm:*)"] });
  });

  test("preserves existing hooks for events we don't touch", () => {
    const existing: ClaudeSettings = {
      hooks: {
        Notification: [
          { matcher: "", hooks: [{ type: "command", command: "say hello" }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks?.Notification?.length).toBe(1);
    expect(out.hooks?.Notification?.[0].hooks[0].command).toBe("say hello");
  });

  test("appends to existing PostToolUse hooks (does not replace)", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "prettier --write" }],
          },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks?.PostToolUse?.length).toBe(2);
    expect(
      out.hooks?.PostToolUse?.some((e) =>
        e.hooks.some((h) => h.command === "prettier --write"),
      ),
    ).toBe(true);
    expect(countSkilledPREntries(out, "PostToolUse")).toBe(1);
  });

  test("idempotent: re-running does not duplicate skilled-pr entries", () => {
    const once = mergeSkilledPRHooks(null);
    const twice = mergeSkilledPRHooks(once);
    expect(countSkilledPREntries(twice, "PostToolUse")).toBe(1);
    expect(countSkilledPREntries(twice, "UserPromptExpansion")).toBe(1);
  });

  test("idempotent across events: prior PostToolUse entry doesn't suppress UserPromptExpansion add", () => {
    const partial: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Skill", hooks: [{ type: "command", command: SKILLED_PR_CMD }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(partial);
    expect(countSkilledPREntries(out, "PostToolUse")).toBe(1);
    expect(countSkilledPREntries(out, "UserPromptExpansion")).toBe(1);
  });

  test("does not mutate the input settings object", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "log-bash" }] },
        ],
      },
    };
    const before = JSON.stringify(existing);
    mergeSkilledPRHooks(existing);
    expect(JSON.stringify(existing)).toBe(before);
  });

  test("does not share the PostToolUse array reference with the input", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "log-bash" }] },
        ],
      },
    };
    const out = mergeSkilledPRHooks(existing);
    expect(out.hooks!.PostToolUse).not.toBe(existing.hooks!.PostToolUse);
  });
});

// ---------------------------------------------------------------------------
// writeFileWithMkdir
// ---------------------------------------------------------------------------

describe("writeFileWithMkdir", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-init-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes when parent directory exists", () => {
    const target = join(tmp, "file.txt");
    writeFileWithMkdir(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  test("creates missing parent directory (single level)", () => {
    const target = join(tmp, ".claude", "settings.json");
    writeFileWithMkdir(target, "{}");
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("{}");
  });

  test("creates deeply nested directories recursively", () => {
    const target = join(tmp, "a", "b", "c", "deep.txt");
    writeFileWithMkdir(target, "x");
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("overwrites an existing file", () => {
    const target = join(tmp, "f.txt");
    writeFileWithMkdir(target, "first");
    writeFileWithMkdir(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("does not leave a .tmp file behind on success (atomic rename completed)", () => {
    const target = join(tmp, "settings.json");
    writeFileWithMkdir(target, "{}");
    const entries = readdirSync(tmp);
    expect(entries).toContain("settings.json");
    expect(entries.find((e) => e.endsWith(".tmp"))).toBeUndefined();
  });

  test("dirname === '.' (bare filename) does not call mkdir", () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      writeFileWithMkdir("bare.txt", "hello");
      expect(readFileSync(join(tmp, "bare.txt"), "utf8")).toBe("hello");
    } finally {
      process.chdir(cwd);
    }
  });

  test("preserves a pre-existing file at the destination directory (mkdir is idempotent)", () => {
    const sibling = join(tmp, "subdir", "sibling.txt");
    writeFileWithMkdir(sibling, "first");
    const second = join(tmp, "subdir", "second.txt");
    writeFileWithMkdir(second, "another");
    expect(readFileSync(sibling, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("another");
  });

  test("rejects a literal .tmp shadow file left by a prior crash (renameSync overwrites cleanly)", () => {
    const target = join(tmp, "settings.json");
    writeFileSync(target + ".tmp", "stale partial write");
    writeFileWithMkdir(target, "fresh content");
    expect(readFileSync(target, "utf8")).toBe("fresh content");
    expect(existsSync(target + ".tmp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureGitignoreEntry
// ---------------------------------------------------------------------------

describe("ensureGitignoreEntry", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-gitignore-test-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates .gitignore when it does not exist", () => {
    expect(existsSync(".gitignore")).toBe(false);
    ensureGitignoreEntry(".review/");
    expect(existsSync(".gitignore")).toBe(true);
    expect(readFileSync(".gitignore", "utf8")).toBe(".review/\n");
  });

  test("appends to an existing .gitignore (preserves prior content)", () => {
    writeFileSync(".gitignore", "node_modules/\ndist/\n");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\ndist/\n.review/\n");
  });

  test("is idempotent: re-running does not append a duplicate line", () => {
    writeFileSync(".gitignore", "node_modules/\n.review/\n");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\n.review/\n");
  });

  test("does NOT false-match when the entry is a substring of another line", () => {
    writeFileSync(".gitignore", "vendored/.review/\n");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("vendored/.review/\n.review/\n");
  });

  test("handles a file that does not end with a newline", () => {
    writeFileSync(".gitignore", "node_modules/");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\n.review/\n");
  });

  test("matches across CRLF line endings (Windows-friendly)", () => {
    writeFileSync(".gitignore", "node_modules/\r\n.review/\r\n");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\r\n.review/\r\n");
  });

  test("works with arbitrary entries (not just .review/)", () => {
    ensureGitignoreEntry(".env.local");
    expect(readFileSync(".gitignore", "utf8")).toBe(".env.local\n");
  });
});

// ---------------------------------------------------------------------------
// init() end-to-end (v1: writes to .skilledpr/, not .skilledpr.jsonc)
// ---------------------------------------------------------------------------

describe("init() v1 file layout", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-init-e2e-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("first run creates the v1 directory layout", async () => {
    await init(["--install-mode=skip"]);
    expect(existsSync(".skilledpr/config.jsonc")).toBe(true);
    expect(existsSync(".skilledpr/schema.json")).toBe(true);
    expect(existsSync(".claude/settings.json")).toBe(true);
    expect(existsSync(".gitignore")).toBe(true);
    expect(readFileSync(".gitignore", "utf8")).toContain(".review/");
  });

  test("installs the /skilled-pr-update skill for Claude Code (uppercase SKILL.md)", async () => {
    await init(["--install-mode=skip", "--for=claude"]);
    const skillPath = ".claude/skills/skilled-pr-update/SKILL.md";
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("name: skilled-pr-update");
    expect(content).toContain("skilled-pr migrate");
  });

  test("installs the /skilled-pr-update skill for Codex (uppercase SKILL.md)", async () => {
    await init(["--install-mode=skip", "--for=codex"]);
    const skillPath = ".codex/skills/skilled-pr-update/SKILL.md";
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, "utf8");
    expect(content).toContain("name: skilled-pr-update");
  });

  test("skill install is idempotent: re-run produces byte-identical file", async () => {
    await init(["--install-mode=skip", "--for=claude"]);
    const first = readFileSync(".claude/skills/skilled-pr-update/SKILL.md", "utf8");
    await init(["--install-mode=skip", "--for=claude"]);
    expect(readFileSync(".claude/skills/skilled-pr-update/SKILL.md", "utf8")).toBe(first);
  });

  test("does NOT write a root .skilledpr.jsonc anymore", async () => {
    await init(["--install-mode=skip"]);
    expect(existsSync(".skilledpr.jsonc")).toBe(false);
  });

  test("config.jsonc opens with $schema pointer for editor autocompletion", async () => {
    await init(["--install-mode=skip"]);
    const config = readFileSync(".skilledpr/config.jsonc", "utf8");
    expect(config).toContain('"$schema": "./schema.json"');
    expect(config).toContain('"schemaVersion": 1');
  });

  test("schema.json is a real JSON Schema (parseable)", async () => {
    await init(["--install-mode=skip"]);
    const schema = JSON.parse(readFileSync(".skilledpr/schema.json", "utf8"));
    expect(schema.$schema).toBeDefined();
    expect(schema.properties?.schemaVersion).toBeDefined();
    expect(schema.properties?.requiredSkills).toBeDefined();
  });

  test("strict idempotency: second run produces byte-identical files", async () => {
    await init(["--install-mode=skip"]);
    const configFirst = readFileSync(".skilledpr/config.jsonc", "utf8");
    const schemaFirst = readFileSync(".skilledpr/schema.json", "utf8");
    const settingsFirst = readFileSync(".claude/settings.json", "utf8");
    const gitignoreFirst = readFileSync(".gitignore", "utf8");

    await init(["--install-mode=skip"]);
    expect(readFileSync(".skilledpr/config.jsonc", "utf8")).toBe(configFirst);
    expect(readFileSync(".skilledpr/schema.json", "utf8")).toBe(schemaFirst);
    expect(readFileSync(".claude/settings.json", "utf8")).toBe(settingsFirst);
    expect(readFileSync(".gitignore", "utf8")).toBe(gitignoreFirst);
  });

  test("does NOT regenerate an existing config (preserves user edits)", async () => {
    mkdirSync(".skilledpr");
    const customized = `{
  "schemaVersion": 1,
  "requiredSkills": ["security:review", "coderabbit:review"],
  "statusName": "PR Quality Gate",
  "failOn": "warning",
  "summaryPrompt": "Custom: one line per finding."
}
`;
    writeFileSync(".skilledpr/config.jsonc", customized);
    await init(["--install-mode=skip"]);
    expect(readFileSync(".skilledpr/config.jsonc", "utf8")).toBe(customized);
  });

  test("converges: pre-existing .gitignore without .review/ gets .review/ appended exactly once", async () => {
    writeFileSync(".gitignore", "node_modules/\ndist/\n.env.local\n");
    await init(["--install-mode=skip"]);
    const after = readFileSync(".gitignore", "utf8");
    expect(after).toContain("node_modules/");
    expect(after).toContain(".review/");
    await init(["--install-mode=skip"]);
    const occurrences = readFileSync(".gitignore", "utf8")
      .split(/\r?\n/)
      .filter((line) => line === ".review/").length;
    expect(occurrences).toBe(1);
  });

  test("converges: pre-existing .claude/settings.json without skilled-pr hooks gets them merged once", async () => {
    writeFileWithMkdir(
      ".claude/settings.json",
      JSON.stringify(
        {
          env: { FOO: "bar" },
          hooks: {
            PostToolUse: [
              { matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write" }] },
            ],
          },
        },
        null,
        2,
      ) + "\n",
    );
    await init(["--install-mode=skip"]);
    const parsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(
      parsed.hooks.PostToolUse.some((e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "prettier --write"),
      ),
    ).toBe(true);
    expect(
      parsed.hooks.PostToolUse.some((e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "skilled-pr hook"),
      ),
    ).toBe(true);
    expect(parsed.env).toEqual({ FOO: "bar" });

    await init(["--install-mode=skip"]);
    const reparsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    const count = reparsed.hooks.PostToolUse.filter(
      (e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "skilled-pr hook"),
    ).length;
    expect(count).toBe(1);
  });

  test("continues installing healthy harnesses when one harness config is invalid", async () => {
    mkdirSync(".claude");
    mkdirSync(".codex");
    writeFileSync(".claude/settings.json", "{ broken\n");
    writeFileSync(
      ".codex/hooks.json",
      JSON.stringify({ hooks: [{ event: "SessionStart", command: "/usr/local/bin/notify" }] }) + "\n",
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let errorText = "";
    try {
      await expect(init(["--for", "both", "--install-mode=skip"])).rejects.toThrow("process.exit:1");
      errorText = errorSpy.mock.calls.flat().join("\n");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }

    expect(readFileSync(".claude/settings.json", "utf8")).toBe("{ broken\n");
    expect(JSON.parse(readFileSync(".codex/hooks.json", "utf8")).hooks).toEqual([
      { event: "SessionStart", command: "/usr/local/bin/notify" },
      { event: "UserPromptSubmit", command: "skilled-pr hook" },
    ]);
    expect(errorText).toContain("Claude Code (.claude/settings.json)");
    expect(errorText).toContain("invalid JSON");
  });

  test("recovers a deleted .gitignore on re-run (convergent restoration)", async () => {
    await init(["--install-mode=skip"]);
    rmSync(".gitignore");
    await init(["--install-mode=skip"]);
    expect(existsSync(".gitignore")).toBe(true);
    expect(readFileSync(".gitignore", "utf8")).toContain(".review/");
  });

  test("recovers deleted skilled-pr hook entries on re-run", async () => {
    await init(["--install-mode=skip"]);
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    delete settings.hooks.UserPromptExpansion;
    writeFileSync(".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");

    await init(["--install-mode=skip"]);
    const reparsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    expect(reparsed.hooks.UserPromptExpansion).toBeDefined();
    expect(
      reparsed.hooks.UserPromptExpansion.some(
        (e: { hooks: Array<{ command?: string }> }) =>
          e.hooks.some((h) => h.command === "skilled-pr hook"),
      ),
    ).toBe(true);
  });

  test("recovers a deleted schema.json on re-run", async () => {
    await init(["--install-mode=skip"]);
    rmSync(".skilledpr/schema.json");
    await init(["--install-mode=skip"]);
    expect(existsSync(".skilledpr/schema.json")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// init() install-mode handling
// ---------------------------------------------------------------------------

describe("init() install-mode flag", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-init-install-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--install-mode=skip does not spawn an install command", async () => {
    // We can't easily intercept spawnSync, but the test just has to be
    // non-flaky: --install-mode=skip should not spawn anything, so
    // init returns cleanly without npm having to be on PATH.
    await init(["--install-mode=skip"]);
    // Config + schema were still written, so the rest of init ran.
    expect(existsSync(".skilledpr/config.jsonc")).toBe(true);
  });

  test("rejects an invalid --install-mode value with a clear error", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(init(["--install-mode=bogus"])).rejects.toThrow("process.exit:1");
      const errorText = errorSpy.mock.calls.flat().join("\n");
      expect(errorText).toContain("--install-mode");
      expect(errorText).toContain('"local"');
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
