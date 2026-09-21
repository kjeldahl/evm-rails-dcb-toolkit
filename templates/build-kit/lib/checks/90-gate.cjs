'use strict';

// The quality gate, scoped to what the commit touches so a commit stays well
// under ~30s: this context's specs, rubocop on the staged Ruby files, and
// packwerk (the slices-never-reference-each-other rule). The full suite
// remains the agent's job before committing (.build-kit/CLAUDE.md, step 5).
//
// Runs against the working tree, like every pre-commit test run does — an
// unstaged edit can therefore make it pass or fail; `git stash` first when
// that matters. Skipped once an earlier check has already rejected the
// commit (no point running the suite on a commit that is going back anyway),
// and when there is no Gemfile here (not a bundled Rails app — nothing to run).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAIL = 20;

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) return { ok: false, output: r.error.message };
  const output = `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n').slice(-TAIL).join('\n');
  return { ok: r.status === 0, output };
}

module.exports = {
  name: 'gate',
  skipIfAlreadyFailing: true, // slow — don't bother once the commit is rejected already
  run(ctx) {
    if (!fs.existsSync(path.join(ctx.repoRoot, 'Gemfile'))) return [];

    const commands = [];
    for (const context of [...ctx.contexts].sort()) {
      const specDir = `spec/slices/${context}`;
      if (fs.existsSync(path.join(ctx.repoRoot, specDir))) commands.push(['rspec', specDir]);
    }
    const rubyFiles = ctx.changes
      .filter((c) => c.status !== 'D' && c.path.endsWith('.rb') && fs.existsSync(path.join(ctx.repoRoot, c.path)))
      .map((c) => c.path);
    if (rubyFiles.length > 0) commands.push(['rubocop', ...rubyFiles]);
    commands.push(['packwerk', 'check']);

    for (const args of commands) {
      const result = run('bundle', ['exec', ...args], ctx.repoRoot);
      if (result.ok) continue;
      return [
        {
          path: `(bundle exec ${args.join(' ')})`,
          reason: `failed:\n${result.output}`,
        },
      ];
    }
    return [];
  },
};
