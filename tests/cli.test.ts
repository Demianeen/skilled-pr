import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Spawn the real CLI entry. Slow-ish (~1s per spawn) but this locks in the
// exit-code contract that CI workflows depend on: a version-pinned workflow
// invoking a subcommand this version doesn't have MUST fail the step, not
// print help and report green.
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const tsx = join(__dirname, "..", "node_modules", ".bin", "tsx");
  const cli = join(__dirname, "..", "src", "cli.ts");
  const result = spawnSync(tsx, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("cli entry exit codes", () => {
  test("no command → help on stdout, exit 0", () => {
    const r = runCli([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stderr).toBe("");
  });

  test("unknown command → error + help on stderr, exit 1", () => {
    const r = runCli(["frobnitz"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unknown command "frobnitz"');
    expect(r.stderr).toContain("Usage:");
  });

  test("--help → help on stdout, exit 0", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});
