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
| `build` | Changes to the build system or dependencies (`bun.lock`, `package.json`) |
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

Every PR to `main` must pass the `Skilled PR / review` commit status. To attest
a review locally:

```
bun run src/cli.ts attest --skill review
```

The status is posted against the current `HEAD` of the PR branch. If you push
a new commit to the branch, the previous attestation does **not** carry over —
you must re-run `attest` on the new SHA.

## Pre-commit self-review

Before every commit, re-read the user's original request and diff the staged
changes against it. Flag anything that was missed, partially followed, or
contradicted, and fix it before committing.
