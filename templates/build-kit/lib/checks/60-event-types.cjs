'use strict';

// "Event type strings are the board's titles verbatim" (.build-kit/CLAUDE.md:
// PascalCase past tense, no spaces — "Customer registered" is
// "CustomerRegistered"). Every INTERNAL event this slice's command produces
// must be constructed in app/slices/<ctx>/domain/events.rb with exactly that
// `type:` string; a drifted type is a silent failure — no projection filtering
// on the board's name ever sees the event.
//
// Events a state-view or automation slice merely consumes are produced by
// another slice and are not this commit's to construct (see
// ../util/slice-elements.cjs, ownedEvents).

const { ownedEvents, eventType, constructorFor, singleContext } = require('../util/slice-elements.cjs');

module.exports = {
  name: 'event-types',
  needsSlice: true,
  run(ctx) {
    const context = singleContext(ctx);
    if (!context) return [];
    const events = ownedEvents(ctx.slice.json).filter((e) => e.title);
    if (events.length === 0) return [];

    const eventsRb = `app/slices/${context}/domain/events.rb`;
    const source = ctx.read(eventsRb);
    const violations = [];
    for (const event of events) {
      const type = eventType(event);
      if (source && constructorFor(source, type)) continue;
      violations.push({
        path: eventsRb,
        reason: source
          ? `no constructor with type: "${type}" — the board event '${event.title}' must be built here with exactly that type string`
          : `missing — the board event '${event.title}' needs a constructor with type: "${type}" in this context's Events module`,
      });
      if (!source) break; // one report for a missing file
    }
    return violations;
  },
};
