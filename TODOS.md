# TODOS

## MUST DO BEFORE MERGING THIS PR
(currently empty)

## Backlog (post-v1 schema)

- Files-changed matcher in rules (deferred: two valid semantics, and
  pagination edge cases for 500+ file PRs make implementation
  non-trivial; revisit when a real user asks for it).
- Windows-native hook support (currently requires WSL or Git Bash).
- Pre-push git hook trigger (requires husky or core.hooksPath; defer
  until requested).
- `skilled-pr scan ~/projects/` for multi-project upgrade discovery on
  global installs.
- `--draft` / `--amend` flag for non-bouncing PR check history (defer
  until users complain about Model A noise on amended commits).
- Historical prompt defaults bundled under `defaults/briefing/` and
  `defaults/summary/` so the migrator can detect "your prompt matches
  v0.5.0's default; upgrade to v0.7.0's?". v1 ships no historical
  defaults (there's no history yet); add per-release when defaults
  change.
- `/skilled-pr-update` skill auto-refresh of its own file (currently
  step 7 is manual; could detect drift via hash-compare and update in
  place).
