'use strict';

// "Strict path" (.build-kit/CLAUDE.md): a slice commit works inside
// app/slices/<context>/ and spec/slices/<context>/, plus the few files a slice
// legitimately registers into or reports through. Everything else belongs in
// a separate commit — a kit upgrade, a config change, a skill improvement.
// Paths 00-blocked-paths already flagged are not repeated (the runner dedupes
// by path).

const ALLOWED = [
  /^(app|spec)\/slices\/[^/]+\//, // the slice directories themselves
  /^config\/routes\.rb$/, // "plus a route line in config/routes.rb"
  /^docs\/screens\//, // screen briefs
  /^\.build-kit\/\.slices\//, // the board data load-slice writes (index.json status flips)
  /^\.build-kit\/AGENTS\.local\.md$/, // the project's own accumulated notes
  /^progress\.txt$/, // the agent loop's running log
];

module.exports = {
  name: 'slice-scope',
  run(ctx) {
    const violations = [];
    for (const { path: p } of ctx.changes) {
      if (ALLOWED.some((r) => r.test(p))) continue;
      violations.push({
        path: p,
        reason: 'outside a slice commit\'s allowed paths (app/slices/<ctx>/, spec/slices/<ctx>/, config/routes.rb, docs/screens/, .build-kit/.slices/, .build-kit/AGENTS.local.md, progress.txt) — commit it separately',
      });
    }
    return violations;
  },
};
