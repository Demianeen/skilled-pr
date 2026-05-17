// Tests for the shared sync subprocess helper extracted from attest.ts,
// branch-protection.ts, and doctor.ts. Most callers shell out to `gh` and
// `git`, which aren't safe to assume in CI environments - so the tests use
// `node` (definitely on PATH since this is the runtime) as a stand-in.
//
// The ENOENT branch is the most important to cover: Node's spawnSync doesn't
// throw on a missing binary the way Bun's did - it returns proc.status=null
// and sets proc.error instead. Before the migration, callers checking only
// exitCode would silently mis-report "command failed" as "command exited
// non-zero", which is the exact class of bug the proc.error surfacing fixes.

import { describe, expect, test } from "vitest";
import { run } from "../src/proc";

describe("run", () => {
  test("captures stdout from a successful command", () => {
    const r = run(["node", "-e", "process.stdout.write('hello')"]);
    expect(r.stdout).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.error).toBeUndefined();
  });

  test("captures stderr from a successful command", () => {
    const r = run(["node", "-e", "process.stderr.write('warn'); process.exit(0)"]);
    expect(r.stderr).toBe("warn");
    expect(r.exitCode).toBe(0);
  });

  test("captures non-zero exit code", () => {
    const r = run(["node", "-e", "process.exit(3)"]);
    expect(r.exitCode).toBe(3);
    expect(r.error).toBeUndefined(); // exit codes are not spawn failures
  });

  test("captures stderr alongside non-zero exit", () => {
    const r = run(["node", "-e", "process.stderr.write('oops'); process.exit(2)"]);
    expect(r.stderr).toBe("oops");
    expect(r.exitCode).toBe(2);
  });

  test("pipes stdin to the child via the input option", () => {
    // This is the migration-critical case: Bun took
    // `{ stdin: Buffer.from(s) }`, Node takes `{ input: s }`. Easy to typo.
    // The child reads stdin to completion and writes it back.
    const r = run(
      [
        "node",
        "-e",
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write(d))",
      ],
      "piped-input-payload",
    );
    expect(r.stdout).toBe("piped-input-payload");
    expect(r.exitCode).toBe(0);
  });

  test("missing binary -> exitCode -1, error set to ENOENT", () => {
    // This is the post-migration ENOENT branch that didn't exist in the
    // initial migration commits. Pre-fix, callers in attest.ts and
    // branch-protection.ts would silently see exitCode -1 and report
    // "command failed" without distinguishing "not installed" from "ran but
    // errored". Doctor's wrapper relies on this branch existing to surface
    // the "install node 22+" hint.
    const r = run([`definitely-not-a-real-binary-${Date.now()}`]);
    expect(r.exitCode).toBe(-1);
    expect(r.error).toBeDefined();
    expect((r.error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("captures large stdout above Node's default 1 MiB cap", () => {
    // Pre-fix, Node's default maxBuffer of 1 MiB silently truncated stdout
    // and killed the process with SIGTERM (status=null -> exitCode=-1).
    // This broke gh api --paginate --slurp for PRs with many comments,
    // re-introducing a dedupe bug a previous review had already fixed.
    // Verify we can capture > 1 MiB without truncation.
    //
    // 2 MiB output: 'x' * 2 * 1024 * 1024 = 2,097,152 bytes
    const r = run([
      "node",
      "-e",
      "process.stdout.write('x'.repeat(2 * 1024 * 1024))",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBe(2 * 1024 * 1024);
    expect(r.error).toBeUndefined();
  });

  test("signal-killed process maps to exitCode -1 (not status null)", () => {
    // Node's spawnSync returns status=null when killed by signal. The
    // helper normalises that to -1 so callers can use a single check
    // (`exitCode !== 0`) for all failure modes.
    const r = run([
      "node",
      "-e",
      "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 1000)",
    ]);
    expect(r.exitCode).toBe(-1);
  });

  test("argv with no args still runs (command-only)", () => {
    // run(["node"]) with no args should start node's REPL and exit. We
    // can't easily assert on that without timing out, but ensuring the
    // call returns a sane shape is enough.
    const r = run(["node", "--version"]);
    expect(r.stdout).toMatch(/^v?\d+\.\d+\.\d+/);
    expect(r.exitCode).toBe(0);
  });
});
