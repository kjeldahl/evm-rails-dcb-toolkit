'use strict';

// A domain file needs its spec. Every command class and projection module
// under app/slices/<ctx>/domain/<name>.rb is specified in
// spec/slices/<ctx>/<name>_spec.rb ("one example per specifications[]
// entry"). events.rb is the one exception: the Events module is exercised
// through the commands and projections that use it, never on its own.

const DOMAIN_FILE = /^app\/slices\/([^/]+)\/domain\/([^/]+)\.rb$/;

module.exports = {
  name: 'spec-present',
  run(ctx) {
    const violations = [];
    for (const { status, path: p } of ctx.changes) {
      if (status !== 'A' && status !== 'M') continue;
      const m = DOMAIN_FILE.exec(p);
      if (!m) continue;
      const [, context, name] = m;
      if (name === 'events') continue;
      const spec = `spec/slices/${context}/${name}_spec.rb`;
      if (ctx.exists(spec)) continue;
      violations.push({
        path: p,
        reason: `no ${spec} — every command/projection ships its spec (one example per board scenario, named after its literal title)`,
      });
    }
    return violations;
  },
};
