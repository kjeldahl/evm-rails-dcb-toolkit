'use strict';

// The tag rule — the single most important one in this kit (.build-kit/
// CLAUDE.md, "tags come from idAttribute: true"): every field with
// `idAttribute: true` becomes a `"<key>:<value>"` tag on the event, with
// `key` the field name minus its Id suffix, snake_cased (walletId → wallet).
// A missing tag fails nowhere at runtime — it silently changes which events a
// decision model or read model sees — so the constructor in events.rb is
// checked for a `"<key>:#{` literal per idAttribute field.
//
// Regex over Ruby, not a parser: the constructor is the `def` chunk of
// events.rb carrying the event's `type:` string. When that chunk cannot be
// found, 60-event-types already reports it and this check stays quiet.

const { ownedEvents, eventType, constructorFor, singleContext } = require('../util/slice-elements.cjs');
const { tagKey } = require('../util/naming.cjs');

module.exports = {
  name: 'id-tags',
  needsSlice: true,
  run(ctx) {
    const context = singleContext(ctx);
    if (!context) return [];
    const eventsRb = `app/slices/${context}/domain/events.rb`;
    const source = ctx.read(eventsRb);
    if (!source) return [];

    const violations = [];
    for (const event of ownedEvents(ctx.slice.json)) {
      const idFields = (Array.isArray(event.fields) ? event.fields : []).filter((f) => f && f.idAttribute === true && f.name);
      if (idFields.length === 0) continue;
      const type = eventType(event);
      const chunk = constructorFor(source, type);
      if (!chunk) continue; // 60-event-types reports the missing constructor

      for (const field of idFields) {
        const key = tagKey(field.name);
        if (chunk.text.includes(`"${key}:#{`)) continue;
        violations.push({
          path: eventsRb,
          reason: `constructor for ${type} carries no "${key}:#{…}" tag — '${field.name}' is idAttribute: true on the board, and every such field becomes a tag on the event (and in every query that must see it)`,
        });
      }
    }
    return violations;
  },
};
