# CLAUDE.md — skilled-pr

Project-level instructions for Claude Code and agents working on this repo.

## Commit convention

This project follows the [Angular commit convention](https://www.conventionalcommits.org/en/v1.0.0/) (aka Conventional Commits), **without scopes**.

### Format

```
<type>: <subject>

<body>

<footer>
```

- `<type>` is required and lowercase.
- `<subject>` is a short imperative summary; no trailing period.
- `<body>` explains the *why*, not the *what* (the diff shows the *what*).
- `<footer>` is reserved for breaking-change notes and co-authors.

### Allowed types

| Type | Use for |
|---|---|
| `feat` | A new user-facing feature or CLI command |
| `fix` | A bug fix |
| `refactor` | Code change that neither adds a feature nor fixes a bug |
| `perf` | A change that improves performance |
| `test` | Adding or updating tests only |
| `docs` | Documentation-only changes (README, CLAUDE.md, code comments) |
| `build` | Changes to the build system or dependencies (`pnpm-lock.yaml`, `package.json`, `tsup.config.ts`) |
| `ci` | Changes to CI configuration (`.github/workflows/*`) |
| `chore` | Everything else that doesn't modify src/ or tests/ |
| `style` | Formatting only (no logic change) |
| `revert` | Reverts a previous commit |

### Examples

✅ Good:
- `feat: add skilled-pr attest and init commands`
- `fix: dedupe silently broken — gh api --jq does not accept --arg`
- `refactor: switch JSONC parser from regex to microsoft/jsonc-parser`
- `test: cover strings containing comment syntax in parseConfig`
- `docs: add CLAUDE.md with angular commit convention`

❌ Avoid:
- `update config parser` — missing `<type>:` prefix
- `feat(config): add parser` — has a scope; this project does not use scopes
- `Fixed bug` — past tense, capitalized, no type
- `fix: stuff` — uninformative subject

## Working with the PR gate

Every PR to `main` must pass the `Skilled PR / review` commit status. The flow
is plug-and-play — you don't run `attest` by hand:

1. In Claude Code, invoke a required review skill (e.g. `/review`). The
   skills listed under `requiredSkills` in `.skilledpr.jsonc` are the gate.
2. The `skilled-pr hook` (installed into `.claude/settings.json` by
   `skilled-pr init`) fires on `PostToolUse:Skill` / `UserPromptExpansion`
   and injects a system reminder telling the model to:
     - write findings to `.review/findings-<skill-slug>.json` as a JSON array
       (schema in `src/findings.ts`), and
     - run `skilled-pr attest --skill <name> --findings <path>`.
3. `attest` posts each new finding as an inline PR comment (deduped by
   fingerprint across re-runs) and posts the commit-status check against
   `HEAD`. Severity gates the status state via `failOn` in the config.

The status is posted per-SHA. If you push a new commit, the previous
attestation does **not** carry over — re-invoke the skill (or run `attest`
manually) on the new HEAD.

### Manual attestation

If you need to bypass the hook (debugging, scripted CI, dogfooding this
repo's own CLI without `npm link`-ing it globally):

```
pnpm dev attest --skill review [--findings <path>]
```

(`pnpm dev` is `tsx src/cli.ts` per `package.json` — runs TypeScript
directly without a build.)

### Unpushed HEAD recovery

`attest` pre-flight-checks that `HEAD` is on the remote. If not, it exits
with code **2** and prints push instructions. The system reminder tells the
model to ask the user before running `git push` — pushing modifies the
remote, so don't bypass the confirmation step.

## Pre-commit self-review

Before every commit, re-read the user's original request and diff the staged
changes against it. Flag anything that was missed, partially followed, or
contradicted, and fix it before committing.
