// skilled-pr init
// Sets up Skilled PR in the current repo.

import { generateDefaultConfig } from "./config";

export async function init() {
  console.log("Skilled PR — setting up...\n");

  // 1. Create .skilledpr.jsonc
  const configFile = Bun.file(".skilledpr.jsonc");
  if (await configFile.exists()) {
    console.log("✓ .skilledpr.jsonc already exists");
  } else {
    await Bun.write(".skilledpr.jsonc", generateDefaultConfig());
    console.log("✓ Created .skilledpr.jsonc");
  }

  // 2. Guide branch protection
  console.log(`
Next steps:

  1. Add "skilled-pr attest --skill review" to the end of your review skill
     (or any script that runs code review).

  2. Enable branch protection on GitHub:
     → Repo Settings → Branches → Branch protection rules
     → Add rule for your main branch
     → Check "Require status checks to pass"
     → Search for "Skilled PR" and add it

  3. Push a commit and run a review to see "Skilled PR ✓" on GitHub.

Done! Your PRs now require AI review before merge.
`);
}
