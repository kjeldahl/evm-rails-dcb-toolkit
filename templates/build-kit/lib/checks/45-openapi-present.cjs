'use strict';

// "Every web-facing slice ships web/openapi.rb" (.build-kit/CLAUDE.md, "JSON
// API and OpenAPI"): a controller under app/slices/<ctx>/web/ implies that
// context registers its endpoints in app/slices/<ctx>/web/openapi.rb, which
// lib/open_api.rb discovers by path to assemble GET /openapi.json. A missing
// file is a working endpoint that never appears in the document — nothing
// else fails.

const CONTROLLER = /^app\/slices\/([^/]+)\/web\/[^/]+_controller\.rb$/;

module.exports = {
  name: 'openapi-present',
  run(ctx) {
    const seen = new Set();
    const violations = [];
    for (const { status, path: p } of ctx.changes) {
      if (status !== 'A' && status !== 'M') continue;
      const m = CONTROLLER.exec(p);
      if (!m) continue;
      const context = m[1];
      if (seen.has(context)) continue;
      seen.add(context);
      const openapi = `app/slices/${context}/web/openapi.rb`;
      if (ctx.exists(openapi)) continue;
      violations.push({
        path: openapi,
        reason: `missing — ${p} serves HTTP, so this context must register its endpoints in web/openapi.rb (worked example: app/slices/wallet/web/openapi.rb)`,
      });
    }
    return violations;
  },
};
