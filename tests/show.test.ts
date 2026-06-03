import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { show } from "../src/show";
import { findBundledSchemaPath } from "../src/show";
import { CURRENT_SCHEMA_VERSION, DEFAULT_SUMMARY_PROMPT } from "../src/config";

// Minimal valid config (matches what `init` writes for a fresh repo).
function writeConfig(dir: string, body?: string) {
  mkdirSync(join(dir, ".skilledpr"), { recursive: true });
  writeFileSync(
    join(dir, ".skilledpr", "config.jsonc"),
    body ??
      `{
  "schemaVersion": ${CURRENT_SCHEMA_VERSION},
  "requiredSkills": ["review"],
  "statusName": "Skilled PR",
  "failOn": "error",
  "summaryPrompt": null,
  "briefingPrompt": null,
  "rules": []
}
`,
  );
}

interface CapturedOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runShow(argv: string[]): Promise<CapturedOutput> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  let exitCode: number | null = null;
  const logSpy = vi.spyOn(console, "log").mockImplementation((s: unknown) => {
    stdoutChunks.push(String(s));
  });
  const errSpy = vi.spyOn(console, "error").mockImplementation((s: unknown) => {
    stderrChunks.push(String(s));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    exitCode = code === undefined || code === null ? 0 : Number(code);
    throw new Error(`process.exit:${exitCode}`);
  }) as never);
  try {
    await show(argv);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("process.exit:")) throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return {
    stdout: stdoutChunks.join("\n"),
    stderr: stderrChunks.join("\n"),
    exitCode,
  };
}

describe("findBundledSchemaPath", () => {
  test("returns a real path when run from a checked-out repo", () => {
    // Sanity: the schema file should be discoverable from any
    // sensible build/dev layout. If this regresses, `show <field>`
    // loses its `description` line.
    const path = findBundledSchemaPath();
    expect(path).not.toBeNull();
    expect(path).toMatch(/schema\/v1\.json$/);
  });
});

describe("show — overview (no args)", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-show-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("prints config overview and resolved profile sections", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow([]);
    expect(stdout).toContain("skilled-pr config");
    expect(stdout).toContain("Resolved profile");
    expect(stdout).toContain("schemaVersion:");
    expect(stdout).toContain("requiredSkills:");
    expect(stdout).toContain('"review"');
  });

  test("overview reports prompt source + size and points at the full-text view (no truncated preview)", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow([]);
    // The resolved prompt line is honest about source + length instead of
    // showing a misleading half-truncated preview.
    expect(stdout).toMatch(/summaryPrompt:\s+built-in default \(\d+ chars\)/);
    // The footer signposts where to read the full value.
    expect(stdout).toContain("skilled-pr show <field>");
    // No truncation ellipsis anywhere in the overview.
    expect(stdout).not.toContain("…");
  });

  test("explicit context flags override git lookup", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow(["--branch", "release-1.0", "--labels", "security,p0"]);
    expect(stdout).toContain('"release-1.0"');
    expect(stdout).toContain("security");
    expect(stdout).toContain("p0");
  });

  test("matched rule is surfaced in the resolved-profile section", async () => {
    writeConfig(
      tmp,
      `{
  "schemaVersion": 1,
  "requiredSkills": ["review"],
  "rules": [
    { "name": "release branches", "match": [{ "branch": "release-*" }], "failOn": "warning" }
  ]
}
`,
    );
    const { stdout } = await runShow(["--branch", "release-2.0"]);
    expect(stdout).toContain("release branches");
    // The rule overrides failOn -> "warning"
    expect(stdout).toMatch(/failOn:\s*"warning"/);
  });

  test("--reminder appends the reminder body", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow(["--reminder", "--branch", "feat/x"]);
    expect(stdout).toContain("Reminder body");
    expect(stdout).toContain("skilled-pr attest");
    expect(stdout).toContain(".skilledpr/config.jsonc");
  });

  test("--reminder with no required skills prints a warning instead of the body", async () => {
    writeConfig(
      tmp,
      `{
  "schemaVersion": 1,
  "requiredSkills": [],
  "rules": []
}
`,
    );
    const { stdout } = await runShow(["--reminder"]);
    expect(stdout).toContain("Reminder body");
    expect(stdout).toContain("No required skills resolved");
  });
});

describe("show — field detail (positional arg)", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-show-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("show summaryPrompt - prints the FULL built-in default (no truncation)", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow(["summaryPrompt"]);
    expect(stdout).toContain("Field: summaryPrompt");
    expect(stdout).toContain("default:");
    expect(stdout).toContain("current:");
    expect(stdout).toContain("source:");
    expect(stdout).toContain("built-in default");
    // The drill-in view must show the WHOLE prompt, not a truncated
    // preview. Assert the full default text appears verbatim and that no
    // ellipsis truncation snuck in.
    expect(stdout).toContain("Active value (built-in default)");
    expect(stdout).toContain(DEFAULT_SUMMARY_PROMPT);
    expect(stdout).not.toContain("…");
  });

  test("show requiredSkills - prints the array and source", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow(["requiredSkills"]);
    expect(stdout).toContain("Field: requiredSkills");
    expect(stdout).toContain('["review"]');
    expect(stdout).toContain("built-in default");
  });

  test("show summaryPrompt with override - shows source as override", async () => {
    writeConfig(
      tmp,
      `{
  "schemaVersion": 1,
  "summaryPrompt": "custom prompt"
}
`,
    );
    const { stdout } = await runShow(["summaryPrompt"]);
    expect(stdout).toContain("override");
    expect(stdout).toContain("custom prompt");
  });

  test("show rules - prints rule count", async () => {
    writeConfig(
      tmp,
      `{
  "schemaVersion": 1,
  "rules": [
    { "name": "r1", "match": [{ "branch": "main" }] }
  ]
}
`,
    );
    const { stdout } = await runShow(["rules"]);
    expect(stdout).toContain("Field: rules");
    expect(stdout).toContain("r1");
  });

  test("unknown field name -> error exit code with hint", async () => {
    writeConfig(tmp);
    const { stderr, exitCode } = await runShow(["nonsense"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('unknown config field: "nonsense"');
    expect(stderr).toContain("Known fields:");
    expect(stderr).toContain("- summaryPrompt");
  });

  test("includes schema description when available", async () => {
    writeConfig(tmp);
    const { stdout } = await runShow(["summaryPrompt"]);
    // Descriptions live in schema/v1.json. The bundled schema file
    // contains a `description` field for summaryPrompt. Test that the
    // description section appears (without asserting exact wording —
    // future schema edits shouldn't break the test).
    expect(stdout).toContain("Description");
  });
});

describe("show — error handling", () => {
  let tmp: string;
  let prevCwd: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-show-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("missing config -> non-zero exit with init hint", async () => {
    const { stderr, exitCode } = await runShow([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain(".skilledpr/config.jsonc");
    expect(stderr).toContain("skilled-pr init");
  });

  test("legacy .skilledpr.jsonc at root -> migration error", async () => {
    writeFileSync(".skilledpr.jsonc", "{}");
    const { stderr, exitCode } = await runShow([]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Old config detected");
  });

  test("unknown flag -> error", async () => {
    writeConfig(tmp);
    const { stderr, exitCode } = await runShow(["--bogus", "x"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("unknown flag: --bogus");
  });
});
