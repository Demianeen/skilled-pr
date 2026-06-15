// Package-manager detection used by `skilled-pr init` to decide which
// CLI to shell out to when installing skilled-pr itself (local
// devDependency vs global). Detection is best-effort: we read the
// lockfile shape in the current repo to choose pnpm / yarn / bun / npm,
// and fall back to npm when nothing's detectable.
//
// Why a separate module: the package-manager guess is used both by the
// interactive flow ("which install mode?") AND by the verification
// path in doctor (PR #6 doctor checks). Keeping detection pure and
// here lets both consumers depend on the same heuristic.

import { existsSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";
export type InstallMode = "local" | "global" | "neither";

/**
 * Detect the active package manager via lockfile presence. Order
 * matters: `pnpm-lock.yaml` and `bun.lockb` are unambiguous; `yarn.lock`
 * gets checked before `package-lock.json` because some yarn-managed
 * repos still keep a stale npm lockfile around. When nothing is found,
 * defaults to npm — the safest choice (it's installed alongside node
 * itself).
 *
 * `cwd` is parameterised so tests can swap in tmpdirs without chdir-ing
 * the whole process.
 */
export function detectPackageManager(cwd: string = process.cwd()): PackageManager {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "bun.lockb"))) return "bun";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "package-lock.json"))) return "npm";
  return "npm";
}

/**
 * Detect how (or whether) skilled-pr is currently installed in this
 * environment. Three states:
 *   - "local"   = node_modules/skilled-pr exists in the current repo
 *   - "global"  = node_modules/skilled-pr absent locally but on the
 *                 user's PATH (we can't reliably tell which global
 *                 package manager installed it — that's npm's problem
 *                 to figure out)
 *   - "neither" = no local install, not on PATH
 *
 * Used by init to suggest the right default install mode when the user
 * hasn't passed --install-mode and we're not in a TTY (so we can't ask
 * interactively).
 *
 * `which` is shelled-out at the caller's discretion — the detection
 * here doesn't run subprocesses to keep it cheap to call.
 */
export function detectInstallMode(
  cwd: string = process.cwd(),
  hasGlobalBinary: boolean = false,
): InstallMode {
  if (existsSync(join(cwd, "node_modules", "skilled-pr"))) return "local";
  if (hasGlobalBinary) return "global";
  return "neither";
}

/**
 * Build the install argv for a given package manager + mode. Pure: the
 * caller spawnSyncs the result. Pinning is to an exact version (no
 * `^`, no `~`) so users on `latest` see a deterministic install.
 *
 * `mode` of "skip" returns null — the caller treats that as "don't
 * install, the user said so" (used in CI / scripted setups where the
 * binary is provisioned out-of-band).
 */
export function buildInstallArgv(
  pm: PackageManager,
  mode: "local" | "global" | "skip",
  version: string,
): string[] | null {
  if (mode === "skip") return null;
  const spec = `skilled-pr@${version}`;
  switch (pm) {
    case "pnpm":
      return mode === "global" ? ["pnpm", "add", "-g", spec] : ["pnpm", "add", "-D", spec];
    case "yarn":
      return mode === "global" ? ["yarn", "global", "add", spec] : ["yarn", "add", "-D", spec];
    case "bun":
      return mode === "global" ? ["bun", "add", "-g", spec] : ["bun", "add", "-D", spec];
    case "npm":
    default:
      return mode === "global" ? ["npm", "i", "-g", spec] : ["npm", "i", "-D", spec];
  }
}
