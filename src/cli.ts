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
  default: {
    const help = `skilled-pr v${pkg.version} - Open review transport for AI-native development

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
  skilled-pr hook                    Internal: harness hook entry point.
                                     Reads a hook event on stdin and emits
                                     additionalContext if a required review
                                     skill was just invoked.

Learn more: https://github.com/Demianeen/skilled-pr`;

    // No command (or an explicit help ask) → help on stdout, exit 0.
    // UNKNOWN command → error + help on stderr, exit 1. The distinction
    // matters in CI: a version-pinned workflow invoking a subcommand this
    // version doesn't have must fail the step loudly, not print help and
    // report green. (`npx skilled-pr@0.4.0 ci-resolve` was exactly that
    // silent-success trap.)
    if (command === undefined || command === "--help" || command === "-h" || command === "help") {
      console.log(help);
      break;
    }
    console.error(`skilled-pr: unknown command "${command}"\n`);
    console.error(help);
    process.exit(1);
  }
}
