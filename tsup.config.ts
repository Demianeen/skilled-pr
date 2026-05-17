import { defineConfig } from "tsup";

// Build config for the published CLI.
// Single-file bundle, ESM, Node target, with shebang for direct execution
// when npm symlinks it into ~/.local/bin or equivalent.
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node22",
  // Add the shebang so the file is invokable directly by the OS once
  // npm sets the +x bit on install.
  banner: { js: "#!/usr/bin/env node" },
  // Bundle jsonc-parser + zod into the output so the published package is
  // a single file with no runtime node_modules lookup. Smaller install,
  // faster startup, no version-skew risk between users.
  //
  // Both deps live in devDependencies (NOT dependencies) because they're
  // inlined here at build time and would otherwise be installed twice for
  // every npm i -g user. `noExternal` is explicit insurance: tsup's default
  // is to externalise everything in `dependencies` + `peerDependencies`, so
  // moving deps to devDependencies should also flip them to inlined — but
  // listing them here means we don't silently break if a tsup upgrade
  // changes the default heuristics.
  splitting: false,
  bundle: true,
  noExternal: ["jsonc-parser", "zod"],
  // Keep the output readable — minification trades ~50KB for unreadable
  // stack traces in user bug reports. Not worth it.
  minify: false,
  // Don't emit .d.ts; this is a CLI, nobody imports it programmatically.
  dts: false,
  // Clean dist/ before each build so stale artifacts don't ship.
  clean: true,
  // Make sure the output is executable. tsup doesn't chmod by default.
  onSuccess: "chmod +x dist/cli.js",
});
