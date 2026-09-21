'use strict';

// The `uninitialized constant` trap: slice controllers are namespaced
// (<Context>::<Resource>Controller), so every route line a slice adds to
// config/routes.rb must carry `module: :<context>` — without it Rails looks
// up a top-level <Resource>Controller and raises only at request time
// (.build-kit/AGENTS.md, "Route lines need module:").
//
// Only lines *added* by this change are judged, and only the ones that name
// a controller: `resources`/`resource`, and an HTTP verb with a string path.
// A verb with a symbol (`get :history`) sits inside a `member do`/`collection
// do` block and inherits the enclosing resource's module — never flagged.
// `to: "wallet/wallets#show"` and a `namespace`/`scope module:` block in the
// same change are accepted as the equivalent spelling.

const ROUTES = 'config/routes.rb';
const RESOURCE_LINE = /^\s*resources?\s+:/;
const VERB_WITH_PATH = /^\s*(get|post|put|patch|delete|match)\s+(["'])/;
const NAMESPACED_TARGET = /\b(to|controller):\s*["'][^"']*\//; // to: "wallet/wallets#show"
const BLOCK_SCOPE = /^\s*(namespace\s+:|scope\b[^\n]*\bmodule:)/;

module.exports = {
  name: 'routes-module',
  run(ctx) {
    if (!ctx.changes.some((c) => c.path === ROUTES && c.status !== 'D')) return [];

    const added = ctx.addedLines(ROUTES);
    if (added.some((line) => BLOCK_SCOPE.test(line))) return []; // module set by the block — can't judge lines individually

    const context = ctx.contexts.size === 1 ? [...ctx.contexts][0] : null;
    const moduleOption = context
      ? new RegExp(`\\bmodule:\\s*(:${context}\\b|["']${context}["'])`)
      : /\bmodule:\s*\S/;

    const violations = [];
    for (const line of added) {
      if (!RESOURCE_LINE.test(line) && !VERB_WITH_PATH.test(line)) continue;
      if (moduleOption.test(line) || NAMESPACED_TARGET.test(line)) continue;
      violations.push({
        path: ROUTES,
        reason: context
          ? `route line \`${line.trim()}\` needs \`module: :${context}\` — the controller is namespaced; without it Rails raises "uninitialized constant" at request time`
          : `route line \`${line.trim()}\` needs \`module: :<context>\` — the controller is namespaced; without it Rails raises "uninitialized constant" at request time`,
      });
      break; // one report per file — the runner dedupes by path anyway
    }
    return violations;
  },
};
