// No shebang here on purpose. tsup's `banner.js` (see tsup.config.ts) adds
// `#!/usr/bin/env node` to the built dist/cli.js. If we also put it in the
// source, esbuild bundles it INTO the output and the banner prepends a
// duplicate, which Node rejects with "Invalid or unexpected token" on the
// second `#`. Dev mode runs `tsx src/cli.ts` (see scripts.dev), which
// doesn't need a shebang.

// Pull version from package.json at build time so the help text never goes
// stale (tsup with resolveJsonModule inlines the JSON into the bundle, no
// runtime fs read). Previous hardcoded `v0.1.0` drifted from package.json's
// `0.2.0` and would have rotted further on every release.
import pkg from "../package.json" with { type: "json" };

const command = process.argv[2];

switch (command) {
  case "attest": {
    const { attest } = await import("./attest");
    await attest(process.argv.slice(3));
    break;
  }
  case "init": {
    const { init } = await import("./init");
    await init(process.argv.slice(3));
    break;
  }
  case "hook": {
    const { hook } = await import("./hook");
    await hook();
    break;
  }
  case "doctor": {
    const { doctor } = await import("./doctor");
    await doctor(process.argv.slice(3));
    break;
  }
  case "enable-gate": {
    const { enableGate } = await import("./branch-protection");
    await enableGate();
    break;
  }
  case "show": {
    const { show } = await import("./show");
    await show(process.argv.slice(3));
    break;
  }
  case "migrate": {
    const { migrate } = await import("./migrate");
    await migrate(process.argv.slice(3));
    break;
  }
  case "ci-resolve": {
    const { ciResolve } = await import("./ci-resolve");
    await ciResolve(process.argv.slice(3));
    break;
  }
  default:
    console.log(`skilled-pr v${pkg.version} - Open review transport for AI-native development

Usage:
  skilled-pr init [--for claude|codex|both]
                                     Set up Skilled PR in this repo. By
                                     default detects which harness is
                                     present (.claude/ vs .codex/) and
                                     wires hooks for each. Use --for to
                                     force.
  skilled-pr attest --skill <name>   Post attestation that a review skill ran
                       [--findings <path>]
  skilled-pr doctor [--why]          Diagnose your local setup. Run this when
                                     something seems off; checks node, gh,
                                     auth, repo state, config, hooks, and
                                     branch protection. Pass --why (or -v)
                                     to see why each check matters.
  skilled-pr enable-gate             Add the Skilled PR status checks to your
                                     default branch's protection rules.
                                     Additive; preserves any existing rules.
  skilled-pr show [<field>]          Inspect the active config and rule
                  [--branch <name>]  resolution. With no args, prints the
                  [--author <name>]  config overview + resolved profile for
                  [--labels <list>]  the current branch. With a field name,
                  [--reminder]       prints type/default/source for that field.
                                     With --reminder, also prints the literal
                                     reminder body the hook would inject.
  skilled-pr migrate [--plan]        Plan or execute a config + bundled file
                     [--apply]       refresh after upgrading the CLI. Without
                                     a flag (or with --plan) prints the plan
                                     without mutating; --apply executes it.
                                     Use the /skilled-pr-update skill to
                                     orchestrate this end-to-end (detect pm,
                                     upgrade, migrate, re-run doctor).
  skilled-pr ci-resolve --pr <num>   CI-side rule evaluation. Run inside a
                       [--json]      GitHub Actions workflow to resolve the
                       [--post]      active profile for a PR and (with --post)
                                     post a bypass success or pending+CTA
                                     status. enable-gate writes a workflow
                                     template that invokes this.
  skilled-pr hook                    Internal: harness hook entry point.
                                     Reads a hook event on stdin and emits
                                     additionalContext if a required review
                                     skill was just invoked.

Learn more: https://github.com/Demianeen/skilled-pr`);
    break;
}
