'use strict';

// Every context directory carries a package.yml (.build-kit/CLAUDE.md: "A new
// context directory gets a package.yml — packwerk silently stops guarding a
// slice that lacks one"). Checked against what the commit will contain, so a
// package.yml that exists on disk but was never `git add`ed still fails.

module.exports = {
  name: 'package-yml',
  run(ctx) {
    const violations = [];
    for (const context of ctx.contexts) {
      const dir = `app/slices/${context}/`;
      // A spec-only commit for a context whose app directory does not exist
      // (yet) has nothing to package.
      if (ctx.files(dir).length === 0) continue;
      const manifest = `${dir}package.yml`;
      if (ctx.exists(manifest)) continue;
      violations.push({
        path: manifest,
        reason: `missing — copy app/slices/wallet/package.yml (or .build-kit/examples/wallet/slice/package.yml) verbatim; without it packwerk does not guard this context`,
      });
    }
    return violations;
  },
};
