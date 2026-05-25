---
name: skilled-pr-update
description: Orchestrate a skilled-pr upgrade in this repo. Detect the package manager, run the install upgrade, run `skilled-pr migrate --plan` and `--apply`, refresh bundled files, then verify with `skilled-pr doctor`. Use when the user asks to "upgrade skilled-pr", "update skilled-pr", or wants to pull in a newer version.
---

# Skilled PR upgrade workflow

You are upgrading skilled-pr in this repo. Follow these steps in order. If any step fails, stop and report the exact error — do not guess or skip ahead.

## 1. Confirm you are in the project root

Run `pwd` and verify the result contains `.skilledpr/config.jsonc`. If not, the user is in a subdirectory; `cd` to the repo root before continuing.

## 2. Detect the package manager and install mode

Detect the package manager from lockfile presence (check in this order):

| Lockfile | Package manager |
|---|---|
| `pnpm-lock.yaml` | pnpm |
| `yarn.lock` | yarn |
| `bun.lockb` | bun |
| `package-lock.json` | npm |
| (none) | npm (default) |

Detect install mode:

- If `node_modules/skilled-pr/package.json` exists → **local** install.
- Else if `which skilled-pr` resolves → **global** install.
- Else: ask the user which they want.

Report back: "Detected: pnpm + local install".

## 3. Show current and latest version

Read the current version: `cat node_modules/skilled-pr/package.json | grep version` (local) or `skilled-pr --help | head -1` (global).

Show the user:

> "skilled-pr is currently X.Y.Z. Latest on npm is the version this skill was bundled with. Upgrade?"

**Wait for explicit user confirmation before continuing.**

## 4. Run the upgrade command

Pick the right command from this table based on your detected pm + mode:

| pm | local | global |
|---|---|---|
| pnpm | `pnpm add -D skilled-pr@latest` | `pnpm add -g skilled-pr@latest` |
| npm | `npm install skilled-pr@latest --save-dev` | `npm install -g skilled-pr@latest` |
| yarn (v1) | `yarn add -D skilled-pr@latest` | `yarn global add skilled-pr@latest` |
| yarn (v2+) | `yarn add -D skilled-pr@latest` | (no global install — use npm/pnpm/bun) |
| bun | `bun add -d skilled-pr@latest` | `bun add -g skilled-pr@latest` |

To detect Yarn version: read the `packageManager` field from `package.json` if present (e.g. `"yarn@3.6.4"`), or run `yarn --version`. Yarn 2+ deliberately removed `yarn global` (see https://yarnpkg.com/getting-started/migration#use-yarn-dlx-instead-of-yarn-global). If the user is on Yarn 2+ and wants a global install, fall back to npm: `npm install -g skilled-pr@latest`.

Run the command and show the output to the user.

## 5. Plan the migration

For LOCAL installs, invoke skilled-pr via the project-local binary so you exercise the newly-installed version (not a potentially-stale global):

```
# Local install (pnpm / npm / yarn / bun all expose node_modules/.bin):
./node_modules/.bin/skilled-pr migrate --plan

# Or with the package manager's own runner:
pnpm exec skilled-pr migrate --plan
npx skilled-pr migrate --plan
yarn skilled-pr migrate --plan
bun skilled-pr migrate --plan
```

For GLOBAL installs, the bare command works:

```
skilled-pr migrate --plan
```

Read the planner's output. Three cases:

- **"Everything is up to date"** → skip to step 7. No mutations needed.
- **Plan has steps and they all look benign** (refresh stale schema.json, etc.) → show the plan to the user, ask "Apply these N steps?", wait for confirmation.
- **Plan has a step that refuses to apply** (e.g., "config newer than CLI", parse error) → stop. Report the issue to the user and ask how they want to handle it.

## 6. Apply the migration

Use the same invocation form as step 5 (local-bin path for local installs, bare command for global):

```
skilled-pr migrate --apply
```

If apply fails partway through, the steps are idempotent — re-running picks up where it left off. Report the failure and ask the user whether to retry or investigate.

## 7. Refresh this skill file too (optional)

The bundled skill template can change between skilled-pr versions. If the user wants the new orchestration steps, the simplest path is to manually overwrite `.claude/skills/skilled-pr-update/skill.md` (or `.codex/skills/skilled-pr-update/SKILL.md`) with the template that ships in the upgraded skilled-pr package, located at `node_modules/skilled-pr/templates/skilled-pr-update.skill.md` (or the global install equivalent).

Skip this step if the user didn't ask for a skill refresh.

## 8. Verify with doctor

Same invocation form as step 5:

```
skilled-pr doctor
```

If any check fails or warns, surface it. Common cases:

- `bundled schema` shows ✓ → refresh succeeded.
- `schemaVersion` shows ✓ → config is compatible with the new CLI.
- New warnings about referenced skills, branch protection, etc. → mention them but they're orthogonal to the upgrade; the user can address separately.

## 9. Report back

Print a one-line summary to the user:

```
✓ Upgraded skilled-pr X.Y.Z → A.B.C
  M migration step(s) applied
  N doctor warning(s) (orthogonal — see above)
```

## Constraints

- **Never run `git push`, `git commit`, or any destructive command** as part of this workflow. The upgrade modifies files (`package.json`, `pnpm-lock.yaml`, `.skilledpr/schema.json`); leave the user to review and commit them.
- **Stop at first failure.** Don't try to recover by improvising.
- **Always wait for user confirmation** before the install command and before `migrate --apply`.
- **Use the project's package manager**, not your default. If you detected pnpm, don't use npm.
