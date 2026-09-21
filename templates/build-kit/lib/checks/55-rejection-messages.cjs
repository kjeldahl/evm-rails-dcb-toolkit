'use strict';

// "Rejection messages are the board's, verbatim" (.build-kit/CLAUDE.md): a
// SPEC_ERROR scenario's message is what Result.failure(...) carries, so the
// text must appear, character for character, somewhere in the context's
// app/slices/<ctx>/ code. The message is the SPEC_ERROR step's `title` (the
// text on the card); an export that carries a `description` too is accepted
// with either — the kit says use `description` only when `title` is empty,
// and a check that guessed which one the modeller meant would block the
// right answer.

const { contextFiles, singleContext, rubyStringForms } = require('../util/slice-elements.cjs');

function messagesOf(slice) {
  const out = new Set();
  for (const spec of Array.isArray(slice.specifications) ? slice.specifications : []) {
    for (const step of Array.isArray(spec && spec.then) ? spec.then : []) {
      if (!step || step.type !== 'SPEC_ERROR') continue;
      const candidates = [step.title, step.description].map((s) => String(s || '').trim()).filter(Boolean);
      if (candidates.length > 0) out.add(JSON.stringify(candidates));
    }
  }
  return [...out].map((s) => JSON.parse(s));
}

module.exports = {
  name: 'rejection-messages',
  needsSlice: true,
  run(ctx) {
    const context = singleContext(ctx);
    if (!context) return [];
    const messages = messagesOf(ctx.slice.json);
    if (messages.length === 0) return [];

    const code = contextFiles(ctx, context, 'app')
      .map((f) => f.content)
      .join('\n');
    const violations = [];
    for (const candidates of messages) {
      const found = candidates.some((message) => rubyStringForms(message).some((form) => code.includes(form)) || code.includes(message));
      if (found) continue;
      violations.push({
        path: `app/slices/${context}/`,
        reason: `rejection message '${candidates[0]}' (a SPEC_ERROR on the board) does not appear verbatim in this context's code — Result.failure must carry the board's text, never a reworded one`,
      });
    }
    return violations;
  },
};
