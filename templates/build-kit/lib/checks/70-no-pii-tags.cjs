'use strict';

// "pii never becomes a tag" (.build-kit/CLAUDE.md): tags are indexed,
// plain-text query keys, so a field the board marks `pii: true` may live in
// event data but never inside a `tags: [ … ]` array — on the event
// constructor or in a projection/decision-model query. Every `tags:` array in
// this context's domain code is scanned for the snake_case name of a pii
// field.
//
// Regex over Ruby, not a parser: only the literal array form is understood
// (`tags: [ "wallet:#{wallet_id}" ]`); a tag built elsewhere is not seen.
// Prefer not blocking over a false positive.

const { allFields, contextFiles, singleContext, snakeCase } = require('../util/slice-elements.cjs');

const TAGS_ARRAY = /\btags:\s*\[([^\]]*)\]/g;

module.exports = {
  name: 'no-pii-tags',
  needsSlice: true,
  run(ctx) {
    const context = singleContext(ctx);
    if (!context) return [];
    const piiNames = new Set(
      allFields(ctx.slice.json)
        .filter(({ field }) => field.pii === true)
        .map(({ field }) => snakeCase(field.name)),
    );
    if (piiNames.size === 0) return [];

    const violations = [];
    for (const { path: p, content } of contextFiles(ctx, context, 'app')) {
      TAGS_ARRAY.lastIndex = 0;
      let m;
      while ((m = TAGS_ARRAY.exec(content))) {
        for (const name of piiNames) {
          if (!new RegExp(`\\b${name}\\b`).test(m[1])) continue;
          violations.push({
            path: p,
            reason: `'${name}' is pii: true on the board and appears inside a tags: array — tags are indexed plain text; tag the subject's id and keep the pii value in data`,
          });
        }
      }
    }
    return violations;
  },
};
