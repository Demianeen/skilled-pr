import { describe, expect, test, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    // user's prettier hook still there
    expect(
      out.hooks?.PostToolUse?.some((e) =>
        e.hooks.some((h) => h.command === "prettier --write"),
      ),
    ).toBe(true);
    // skilled-pr's hook also there
    expect(countSkilledPREntries(out, "PostToolUse")).toBe(1);
  });

  test("idempotent: re-running does not duplicate skilled-pr entries", () => {
    const once = mergeSkilledPRHooks(null);
    const twice = mergeSkilledPRHooks(once);
    expect(countSkilledPREntries(twice, "PostToolUse")).toBe(1);
    expect(countSkilledPREntries(twice, "UserPromptExpansion")).toBe(1);
  });

  test("idempotent across events: prior PostToolUse entry doesn't suppress UserPromptExpansion add", () => {
    // Edge case: settings already has the PostToolUse skilled-pr hook but
    // not the UserPromptExpansion one (e.g., partial install). The merge
    // should add the missing one without touching the existing.
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
    // Defense against a future refactor where we accidentally mutate
    // entries in-place: the output's array should be a fresh object.
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
//
// Critical migration helper: replaces Bun.write's auto-mkdir behaviour for
// `.claude/settings.json` (the .claude/ dir doesn't exist in a fresh repo).
// Also atomic via tmp + rename so a Ctrl-C mid-write doesn't corrupt the
// user's settings.json on subsequent runs.
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
    // Replicates the fresh-repo `.claude/settings.json` case.
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
    // Atomic write pattern: write to <path>.tmp, then rename. After a
    // successful call only the final path exists, no stray .tmp.
    const target = join(tmp, "settings.json");
    writeFileWithMkdir(target, "{}");
    const entries = readdirSync(tmp);
    expect(entries).toContain("settings.json");
    expect(entries.find((e) => e.endsWith(".tmp"))).toBeUndefined();
  });

  test("dirname === '.' (bare filename) does not call mkdir", () => {
    // dirname returns "." for paths with no directory component. The
    // helper must skip the mkdir for this case, otherwise it would
    // try to mkdir(".", recursive:true) which is a no-op but signals
    // brittle assumptions about the input shape.
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
    // Second write to a different file in the same dir should not blow away
    // the first one. Catches a bug where mkdirSync(..., {recursive:false})
    // would throw on existing dirs.
    const second = join(tmp, "subdir", "second.txt");
    writeFileWithMkdir(second, "another");
    expect(readFileSync(sibling, "utf8")).toBe("first");
    expect(readFileSync(second, "utf8")).toBe("another");
  });

  test("rejects a literal .tmp shadow file left by a prior crash (renameSync overwrites cleanly)", () => {
    // If a prior crashed run left behind <path>.tmp, the next successful
    // write should overwrite it during the atomic-rename step. renameSync
    // is replace-by-default on POSIX and Windows, so the shadow file
    // shouldn't survive.
    const target = join(tmp, "settings.json");
    writeFileSync(target + ".tmp", "stale partial write");
    writeFileWithMkdir(target, "fresh content");
    expect(readFileSync(target, "utf8")).toBe("fresh content");
    expect(existsSync(target + ".tmp")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ensureGitignoreEntry
//
// init calls this with `.review/` so per-review artifacts never end up in
// commits. The function operates on `.gitignore` in the current working
// directory; tests chdir into a tmpdir to isolate.
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
    // Catches a naive `current.includes(entry)` implementation. The
    // existing `vendored/.review/` line should NOT prevent the helper
    // from adding the bare `.review/` ignore for the repo root.
    writeFileSync(".gitignore", "vendored/.review/\n");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("vendored/.review/\n.review/\n");
  });

  test("handles a file that does not end with a newline", () => {
    // No trailing newline -> appending should insert one before the
    // new entry so it lands on its own line.
    writeFileSync(".gitignore", "node_modules/");
    ensureGitignoreEntry(".review/");
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\n.review/\n");
  });

  test("matches across CRLF line endings (Windows-friendly)", () => {
    // The file might be CRLF-line-ended (Windows). Idempotency must
    // not double-add the entry just because the line endings differ.
    writeFileSync(".gitignore", "node_modules/\r\n.review/\r\n");
    ensureGitignoreEntry(".review/");
    // Unchanged.
    expect(readFileSync(".gitignore", "utf8")).toBe("node_modules/\r\n.review/\r\n");
  });

  test("works with arbitrary entries (not just .review/)", () => {
    // Defensive: the helper is named generically and may be reused.
    ensureGitignoreEntry(".env.local");
    expect(readFileSync(".gitignore", "utf8")).toBe(".env.local\n");
  });
});

// ---------------------------------------------------------------------------
// init() end-to-end
//
// init touches three files in the project root: .skilledpr.jsonc,
// .claude/settings.json, and .gitignore. All three writes should be safe
// to repeat - users who re-run `skilled-pr init` after the first setup
// (e.g. to recover from a deleted .gitignore, or to verify their setup)
// expect no surprises.
//
// Strict idempotency: second run produces byte-identical files.
// Convergent behavior: partial states (existing .gitignore without
// .review/, settings.json without hooks) converge to the same end state
// as a fresh run.
//
// init() uses process.cwd() implicitly. We chdir into a tmpdir per test
// to isolate. console.log output from init is left visible - it would be
// noise to silence and it confirms init is running.
// ---------------------------------------------------------------------------

describe("init() idempotency", () => {
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

  test("first run creates all three files (fresh repo)", async () => {
    await init();
    expect(existsSync(".skilledpr.jsonc")).toBe(true);
    expect(existsSync(".claude/settings.json")).toBe(true);
    expect(existsSync(".gitignore")).toBe(true);
    expect(readFileSync(".gitignore", "utf8")).toContain(".review/");
  });

  test("strict idempotency: second run produces byte-identical files", async () => {
    await init();
    const skilledprFirst = readFileSync(".skilledpr.jsonc", "utf8");
    const settingsFirst = readFileSync(".claude/settings.json", "utf8");
    const gitignoreFirst = readFileSync(".gitignore", "utf8");

    // Second run, same cwd, same files. Should NOT modify anything.
    await init();
    expect(readFileSync(".skilledpr.jsonc", "utf8")).toBe(skilledprFirst);
    expect(readFileSync(".claude/settings.json", "utf8")).toBe(settingsFirst);
    expect(readFileSync(".gitignore", "utf8")).toBe(gitignoreFirst);
  });

  test("triple-run is still byte-identical (idempotency holds across runs)", async () => {
    await init();
    const first = readFileSync(".skilledpr.jsonc", "utf8");
    await init();
    await init();
    expect(readFileSync(".skilledpr.jsonc", "utf8")).toBe(first);
  });

  test("converges: pre-existing .gitignore without .review/ gets .review/ appended exactly once", async () => {
    // User had a .gitignore for other reasons before adopting skilled-pr.
    // init should add `.review/` without clobbering the rest.
    writeFileSync(".gitignore", "node_modules/\ndist/\n.env.local\n");
    await init();
    const after = readFileSync(".gitignore", "utf8");
    expect(after).toContain("node_modules/");
    expect(after).toContain("dist/");
    expect(after).toContain(".env.local");
    expect(after).toContain(".review/");
    // Second init: still exactly one .review/ entry.
    await init();
    const occurrences = readFileSync(".gitignore", "utf8")
      .split(/\r?\n/)
      .filter((line) => line === ".review/").length;
    expect(occurrences).toBe(1);
  });

  test("converges: pre-existing .claude/settings.json without skilled-pr hooks gets them merged once", async () => {
    // User already had Claude Code settings (e.g. for prettier on edit).
    // init merges skilled-pr's hooks alongside without touching theirs.
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
    await init();
    const parsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    // User's prettier hook is still there:
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(
      parsed.hooks.PostToolUse.some((e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "prettier --write"),
      ),
    ).toBe(true);
    // skilled-pr's hook was added:
    expect(
      parsed.hooks.PostToolUse.some((e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "skilled-pr hook"),
      ),
    ).toBe(true);
    // User's env var preserved:
    expect(parsed.env).toEqual({ FOO: "bar" });

    // Second init: count of skilled-pr hook entries stays at 1.
    await init();
    const reparsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    const count = reparsed.hooks.PostToolUse.filter(
      (e: { hooks: Array<{ command?: string }> }) =>
        e.hooks.some((h) => h.command === "skilled-pr hook"),
    ).length;
    expect(count).toBe(1);
  });

  test("does NOT regenerate an existing .skilledpr.jsonc (preserves user edits)", async () => {
    // The user has customized their summaryPrompt and other fields. init
    // must NOT overwrite these on a re-run - they'd lose the customization
    // and the system's "we wrote the default once" promise would break.
    const customized = `{
  "requiredSkills": ["security:review", "coderabbit:review"],
  "statusName": "PR Quality Gate",
  "failOn": "warning",
  "summaryPrompt": "Custom: one line per finding."
}
`;
    writeFileSync(".skilledpr.jsonc", customized);
    await init();
    expect(readFileSync(".skilledpr.jsonc", "utf8")).toBe(customized);
  });

  test("recovers a deleted .gitignore on re-run (convergent restoration)", async () => {
    await init();
    // Simulate the user deleting .gitignore for any reason.
    rmSync(".gitignore");
    await init();
    expect(existsSync(".gitignore")).toBe(true);
    expect(readFileSync(".gitignore", "utf8")).toContain(".review/");
  });

  test("recovers deleted skilled-pr hook entries on re-run", async () => {
    await init();
    // Simulate the user manually removing the UserPromptExpansion hook
    // (a real scenario: someone editing .claude/settings.json by hand).
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    delete settings.hooks.UserPromptExpansion;
    writeFileSync(".claude/settings.json", JSON.stringify(settings, null, 2) + "\n");

    await init();
    const reparsed = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
    expect(reparsed.hooks.UserPromptExpansion).toBeDefined();
    expect(
      reparsed.hooks.UserPromptExpansion.some(
        (e: { hooks: Array<{ command?: string }> }) =>
          e.hooks.some((h) => h.command === "skilled-pr hook"),
      ),
    ).toBe(true);
  });
});
