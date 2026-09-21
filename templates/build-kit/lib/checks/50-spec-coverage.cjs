'use strict';

// Every board scenario has its spec, named after the scenario's literal title
// (.build-kit/CLAUDE.md: "One example per specifications[] entry, described
// by the scenario's literal title"). The title must appear, character for
// character, as an `it "…"` / `specify "…"` example or a `describe "…"` /
// `context "…"` group somewhere under spec/slices/<ctx>/.
//
// Two board scenarios may share a title; the kit's rule is then one
// `describe "<title>"` group holding one `it` per scenario — so a group with
// the title satisfies any number of duplicates, while bare `it`s need one per
// scenario. A slice.json with no specifications[] has nothing to check.

const { contextFiles, singleContext, rubyStringForms, escapeRegExp } = require('../util/slice-elements.cjs');

function countMatches(content, keywords, title) {
  const strings = rubyStringForms(title).map(escapeRegExp).join('|');
  const re = new RegExp(`\\b(?:${keywords.join('|')})\\s*\\(?\\s*(?:${strings})`, 'g');
  return (content.match(re) || []).length;
}

module.exports = {
  name: 'spec-coverage',
  needsSlice: true,
  run(ctx) {
    const context = singleContext(ctx);
    if (!context) return [];
    const specs = Array.isArray(ctx.slice.json.specifications) ? ctx.slice.json.specifications : [];
    if (specs.length === 0) return [];

    const needed = new Map();
    for (const spec of specs) {
      const title = String((spec && spec.title) || '').trim();
      if (!title) continue;
      needed.set(title, (needed.get(title) || 0) + 1);
    }
    if (needed.size === 0) return [];

    const files = contextFiles(ctx, context, 'spec');
    const violations = [];
    for (const [title, count] of needed) {
      let examples = 0;
      let groups = 0;
      for (const { content } of files) {
        examples += countMatches(content, ['it', 'specify'], title);
        groups += countMatches(content, ['describe', 'context'], title);
      }
      if (groups > 0 || examples >= count) continue;
      violations.push({
        path: `spec/slices/${context}/`,
        reason:
          count > 1
            ? `missing spec for scenario '${title}' — the board has ${count} scenarios with this title, found ${examples} example(s); group them under describe "${title}" with one it per scenario`
            : `missing spec for scenario '${title}' — add it "${title}" (the literal board title) to this context's specs`,
      });
    }
    return violations;
  },
};
