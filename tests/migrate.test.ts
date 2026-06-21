import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlan, formatPlan, planMigration, migrate } from "../src/migrate";
import { CURRENT_SCHEMA_VERSION } from "../src/config";

// Most tests need a fixture project on disk: an isolated tmp dir with
// .skilledpr/config.jsonc + .skilledpr/schema.json. The schema content
// needs to match the package's bundled schema/v1.json for the
// "everything up to date" path to fire — we read it once at test setup
// time so the assertion stays accurate even if schema/v1.json evolves.
const REPO_ROOT = join(__dirname, "..");
const BUNDLED_SCHEMA = readFileSync(join(REPO_ROOT, "schema", "v1.json"), "utf8");

function writeMinimalConfig(dir: string, schemaVersion = CURRENT_SCHEMA_VERSION) {
  mkdirSync(join(dir, ".skilledpr"), { recursive: true });
  writeFileSync(
    join(dir, ".skilledpr", "config.jsonc"),
    `{
  "schemaVersion": ${schemaVersion},
  "requiredSkills": ["review"],
  "summaryPrompt": null
}
`,
  );
}

function writeBundledSchema(dir: string, content: string = BUNDLED_SCHEMA) {
  mkdirSync(join(dir, ".skilledpr"), { recursive: true });
  writeFileSync(join(dir, ".skilledpr", "schema.json"), content);
}

describe("planMigration", () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-migrate-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
  });
  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns zero steps when config and bundled schema are up to date", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp);
    const plan = await planMigration();
    expect(plan.steps).toEqual([]);
    expect(plan.currentSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(plan.cliSchemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  test("emits a step when config is missing", async () => {
    // No config written.
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("config-missing");
    expect(plan.currentSchemaVersion).toBeNull();
  });

  test("points legacy root config users at the v1 config path", async () => {
    writeFileSync(join(tmp, ".skilledpr.jsonc"), `{"requiredSkills":["review"]}`);
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("config-legacy-root");
    expect(plan.steps[0].detail).toContain(".skilledpr/config.jsonc");
    expect(() => plan.steps[0].apply()).toThrow(/old config location/);
  });

  test("emits a step when config has parse errors", async () => {
    mkdirSync(join(tmp, ".skilledpr"), { recursive: true });
    writeFileSync(join(tmp, ".skilledpr", "config.jsonc"), `{ this is not valid json`);
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("config-parse-error");
  });

  test("refuses to apply when config newer than CLI", async () => {
    writeMinimalConfig(tmp, CURRENT_SCHEMA_VERSION + 1);
    writeBundledSchema(tmp);
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("config-newer-than-cli");
    expect(() => plan.steps[0].apply()).toThrow(/Cannot auto-apply/);
  });

  test("config parses but fails validation (schemaVersion 0) → refuse-to-apply step", async () => {
    // schemaVersion 0 is syntactically valid JSONC but rejected by loadConfig.
    // The planner falls through to the validating load and surfaces the error
    // as a config-parse-error step — this is the path a stale/older config hits
    // (and what a user sees if they hand-edit schemaVersion below the current).
    writeMinimalConfig(tmp, 0);
    writeBundledSchema(tmp);
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("config-parse-error");
    expect(plan.steps[0].detail).toMatch(/schemaVersion/);
    expect(() => plan.steps[0].apply()).toThrow(/Cannot auto-apply/);
  });

  test("emits a step when bundled schema.json is missing", async () => {
    writeMinimalConfig(tmp);
    // Don't write the schema file.
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("schema-json-missing");
  });

  test("emits a step when bundled schema differs from CLI bundle", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    const plan = await planMigration();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].id).toBe("schema-json-stale");
  });

  test("apply for schema-json-stale overwrites with bundled content", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    const plan = await planMigration();
    const result = plan.steps[0].apply();
    expect(result).toMatch(/Refreshed/);
    expect(readFileSync(join(tmp, ".skilledpr", "schema.json"), "utf8")).toBe(BUNDLED_SCHEMA);
  });

  test("apply for schema-json-missing creates the file", async () => {
    writeMinimalConfig(tmp);
    // Don't write schema.json yet.
    expect(existsSync(join(tmp, ".skilledpr", "schema.json"))).toBe(false);
    const plan = await planMigration();
    const result = plan.steps[0].apply();
    expect(result).toMatch(/Wrote/);
    expect(existsSync(join(tmp, ".skilledpr", "schema.json"))).toBe(true);
  });
});

describe("formatPlan", () => {
  test("renders zero-step plan as 'up to date'", () => {
    const text = formatPlan({
      currentSchemaVersion: 1,
      cliSchemaVersion: 1,
      steps: [],
    });
    expect(text).toContain("matches CLI");
    expect(text).toContain("Everything is up to date");
  });

  test("renders missing-config plan with N/A version", () => {
    const text = formatPlan({
      currentSchemaVersion: null,
      cliSchemaVersion: 1,
      steps: [
        {
          id: "config-missing",
          title: "Config missing",
          detail: "Run init first.",
          apply: () => "",
        },
      ],
    });
    expect(text).toContain("(not found)");
    expect(text).toContain("1. Config missing");
    expect(text).toContain("Run init first.");
  });

  test("renders multi-step plan with numbered list", () => {
    const text = formatPlan({
      currentSchemaVersion: 1,
      cliSchemaVersion: 1,
      steps: [
        { id: "a", title: "Step A", apply: () => "" },
        { id: "b", title: "Step B", apply: () => "" },
      ],
    });
    expect(text).toContain("2 steps:");
    expect(text).toMatch(/1\. Step A[\s\S]+2\. Step B/);
    expect(text).toContain("--apply");
  });

  test("singular 'step' when exactly one step", () => {
    const text = formatPlan({
      currentSchemaVersion: 1,
      cliSchemaVersion: 1,
      steps: [{ id: "x", title: "x", apply: () => "" }],
    });
    expect(text).toContain("1 step:");
  });

  test("omits the --apply hint when showApplyHint is false", () => {
    const text = formatPlan(
      { currentSchemaVersion: 1, cliSchemaVersion: 1, steps: [{ id: "x", title: "x", apply: () => "" }] },
      { showApplyHint: false },
    );
    expect(text).toContain("1 step:");
    expect(text).not.toContain("--apply");
  });
});

describe("applyPlan", () => {
  test("runs each step in order and prints confirmations", () => {
    const calls: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      applyPlan({
        currentSchemaVersion: 1,
        cliSchemaVersion: 1,
        steps: [
          {
            id: "a",
            title: "step A",
            apply: () => {
              calls.push("A");
              return "did A";
            },
          },
          {
            id: "b",
            title: "step B",
            apply: () => {
              calls.push("B");
              return "did B";
            },
          },
        ],
      });
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
    expect(calls).toEqual(["A", "B"]);
  });

  test("re-throws failed step with the step title", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(() =>
        applyPlan({
          currentSchemaVersion: 1,
          cliSchemaVersion: 1,
          steps: [
            {
              id: "fail",
              title: "bad step",
              apply: () => {
                throw new Error("boom");
              },
            },
          ],
        }),
      ).toThrow(/bad step: boom/);
    } finally {
      logSpy.mockRestore();
      writeSpy.mockRestore();
    }
  });

  test("zero-step plan prints 'Nothing to apply.' and returns", () => {
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logged.push(String(msg));
      return undefined as unknown as void;
    });
    try {
      applyPlan({ currentSchemaVersion: 1, cliSchemaVersion: 1, steps: [] });
    } finally {
      logSpy.mockRestore();
    }
    expect(logged).toEqual(["Nothing to apply."]);
  });
});

describe("migrate CLI entry", () => {
  let tmp: string;
  let prevCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skilled-pr-migrate-cli-"));
    prevCwd = process.cwd();
    process.chdir(tmp);
    logged = [];
    errored = [];
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__exit__");
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logged.push(String(msg));
      return undefined as unknown as void;
    });
    errSpy = vi.spyOn(console, "error").mockImplementation((msg) => {
      errored.push(String(msg));
      return undefined as unknown as void;
    });
  });
  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(prevCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("--plan prints the plan but does not mutate", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    await migrate(["--plan"]);
    expect(logged.join("\n")).toContain("schema.json differs");
    // Should NOT have refreshed.
    expect(readFileSync(join(tmp, ".skilledpr", "schema.json"), "utf8")).toBe(`{"$schema": "stale"}`);
  });

  test("--apply executes the plan", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    await migrate(["--apply"]);
    // Schema is now refreshed.
    expect(readFileSync(join(tmp, ".skilledpr", "schema.json"), "utf8")).toBe(BUNDLED_SCHEMA);
  });

  test("--apply output does not tell the user to run --apply (no circular CTA)", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    await migrate(["--apply"]);
    expect(logged.join("\n")).not.toContain("migrate --apply` to execute");
  });

  test("--apply on up-to-date project prints 'up to date' and skips apply", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp);
    await migrate(["--apply"]);
    expect(logged.join("\n")).toContain("Everything is up to date");
  });

  test("--plan and --apply together exits 1 with error", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp);
    await expect(migrate(["--plan", "--apply"])).rejects.toThrow(/__exit__/);
    expect(errored.join("\n")).toContain("pass either --plan or --apply");
  });

  test("unknown flag exits 1 with a clear error", async () => {
    await expect(migrate(["--force"])).rejects.toThrow(/__exit__/);
    expect(errored.join("\n")).toContain("unknown flag: --force");
  });

  test("flag values exit 1 because migrate flags are booleans", async () => {
    await expect(migrate(["--plan=true"])).rejects.toThrow(/__exit__/);
    expect(errored.join("\n")).toContain("--plan does not take a value");
  });

  test("no flag defaults to --plan (read-only)", async () => {
    writeMinimalConfig(tmp);
    writeBundledSchema(tmp, `{"$schema": "stale"}`);
    await migrate([]);
    // Did not mutate.
    expect(readFileSync(join(tmp, ".skilledpr", "schema.json"), "utf8")).toBe(`{"$schema": "stale"}`);
  });
});
