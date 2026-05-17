// Shared sync subprocess helper for skilled-pr.
//
// Before extraction this lived as three near-identical copies in attest.ts,
// branch-protection.ts, and doctor.ts. Every Node-specific tweak we needed
// during the Bun migration (encoding, maxBuffer cap, proc.error surfacing)
// had to be applied three times and risked silent divergence on the next
// edit. Single source of truth lives here; the three callers import it.
//
// The doctor module wraps this with a `stdout: null on failure` adapter
// because its classify* functions take a nullable stdout string. Other
// callers consume the structured shape directly.

import { spawnSync } from "node:child_process";

export interface RunResult {
  /** Captured stdout as a string (encoding: "utf8"). Empty string when the process produced none. */
  stdout: string;
  /** Captured stderr as a string. On spawn failure (e.g. ENOENT) this carries the OS error message. */
  stderr: string;
  /**
   * Process exit code. Normalised to -1 when:
   *   - the process was killed by a signal (Node returns status === null)
   *   - the spawn itself failed (ENOENT, EACCES, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, etc.)
   * Callers should treat any non-zero value as failure; `error` distinguishes
   * spawn failures from genuine non-zero exits when it matters.
   */
  exitCode: number;
  /** Set only when the spawn itself failed. Use to detect ENOENT (binary not on PATH). */
  error?: NodeJS.ErrnoException;
}

/**
 * Run `args` (argv form: command + args) synchronously, optionally piping
 * `stdin` into the child. Returns a normalised RunResult.
 *
 * `maxBuffer` is set to 64 MiB to override Node's 1 MiB default. The default
 * silently truncates output and kills the process with SIGTERM, which broke
 * `gh api --paginate --slurp` for PRs with many comments (status becomes
 * null, exitCode -1, dedupe Set returned empty, every finding re-posts as
 * a duplicate). 64 MiB is comfortably above any realistic GitHub API
 * response. Bump if a future caller needs more.
 */
export function run(args: string[], stdin?: string): RunResult {
  const proc = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    input: stdin,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.error || proc.status === null) {
    return {
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? (proc.error?.message ?? ""),
      exitCode: -1,
      error: proc.error,
    };
  }
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    exitCode: proc.status,
  };
}
