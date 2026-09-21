'use strict';

// Rejects a slice commit that touches shared plumbing slice work must never
// change (.build-kit/CLAUDE.md, "File constraints": "Don't touch Gemfile,
// lib/event_store.rb, lib/result.rb or config/ except the routes line").
// The kit's own files under .build-kit/ are off-limits too — a slice commit
// may only update its board data (.slices/) and the project's own notes.

const BLOCKED = [
  {
    pattern: /^Gemfile(\.lock)?$/,
    reason: 'dependency changes are not slice work — the Gemfile is owned by the install (template.rb)',
  },
  {
    pattern: /^lib\/(event_store|result)\.rb$/,
    reason: 'shared plumbing every slice uses — never changed from a slice commit',
  },
  {
    pattern: /^config\//,
    except: /^config\/routes\.rb$/,
    reason: 'config/ is off-limits to slice work (only the route line in config/routes.rb is)',
  },
  {
    pattern: /^app\/controllers\/application_controller\.rb$/,
    reason: 'ApplicationController is shared infra (view lookup + forgery policy) — never touched by slice work',
  },
  {
    pattern: /^\.build-kit\//,
    except: /^\.build-kit\/(\.slices\/|AGENTS\.local\.md$)/,
    reason: 'the kit owns .build-kit/ — only .build-kit/.slices/ (board data) and AGENTS.local.md (project notes) change with a slice',
  },
];

module.exports = {
  name: 'blocked-paths',
  run(ctx) {
    const violations = [];
    for (const { path: p } of ctx.changes) {
      const hit = BLOCKED.find((b) => b.pattern.test(p) && !(b.except && b.except.test(p)));
      if (hit) violations.push({ path: p, reason: hit.reason });
    }
    return violations;
  },
};
