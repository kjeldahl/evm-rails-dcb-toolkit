'use strict';

// One board context per commit. This kit has one slice directory per board
// *context* (.build-kit/CLAUDE.md, "One slice directory per board Context"),
// and a slice commit is one board slice, which lives in exactly one context —
// files under two context directories mean two slices got mixed into one
// commit, or a slice reached across a boundary it must not.

module.exports = {
  name: 'one-context',
  run(ctx) {
    if (ctx.contexts.size <= 1) return [];
    const names = [...ctx.contexts].sort();
    return [
      {
        path: '(contexts)',
        reason: `touches ${names.length} contexts (${names.join(', ')}) — a slice commit is one board context; split it`,
      },
    ];
  },
};
