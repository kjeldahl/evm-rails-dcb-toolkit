'use strict';

// The real thing: a scaffolded Rails app (rails new + the overlay +
// template.rb — see test/scaffold-app.sh), the hooks installed, and `git
// commit` rejected then accepted with the actual `bundle exec rspec`,
// rubocop and packwerk gate running. Needs Ruby and a bundled app, so it
// only runs when KIT_E2E_APP points at one (CI's e2e-rails job; locally:
// `test/scaffold-app.sh /tmp/app && KIT_E2E_APP=/tmp/app npm test`).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { git, LIB_SRC, HOOKS_SRC } = require('./helpers.cjs');

const APP = process.env.KIT_E2E_APP;

test('scaffolded Rails app: a bad slice commit is rejected, the fixed one is accepted by the real gate', { skip: !APP && 'KIT_E2E_APP not set' }, () => {
  const app = path.resolve(APP);
  assert.ok(fs.existsSync(path.join(app, 'Gemfile')), `${app} is not a bundled Rails app`);

  // A fresh repo over the app, with the kit lib and hooks as `init --hooks` leaves them.
  fs.rmSync(path.join(app, '.git'), { recursive: true, force: true });
  fs.rmSync(path.join(app, '.build-kit', 'lib'), { recursive: true, force: true });
  fs.cpSync(LIB_SRC, path.join(app, '.build-kit', 'lib'), { recursive: true });
  fs.cpSync(HOOKS_SRC, path.join(app, '.githooks'), { recursive: true });
  fs.chmodSync(path.join(app, '.githooks', 'pre-commit'), 0o755);
  git(app, ['init', '-q', '-b', 'main']);
  git(app, ['config', 'user.email', 'guard@test']);
  git(app, ['config', 'user.name', 'guard test']);
  git(app, ['config', 'commit.gpgsign', 'false']);
  git(app, ['add', '-A']);
  git(app, ['commit', '-q', '-m', 'init']);
  git(app, ['config', 'core.hooksPath', path.join(app, '.githooks')]);

  const commit = (message) => {
    git(app, ['add', '-A']);
    const r = spawnSync('git', ['commit', '-q', '-m', message], { cwd: app, encoding: 'utf8' });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  };
  const edit = (rel, fn) => fs.writeFileSync(path.join(app, rel), fn(fs.readFileSync(path.join(app, rel), 'utf8')));

  // Acceptance 3: a slice commit touching lib/event_store.rb is rejected by 00.
  edit('app/slices/wallet/domain/deposit.rb', (s) => s + '# touched\n');
  edit('lib/event_store.rb', (s) => s + '# touched\n');
  let r = commit('feat: Deposit');
  assert.equal(r.code, 1);
  assert.match(r.output, /\[blocked-paths\]/);

  // A slice commit that breaks its own spec is rejected by the real gate (90).
  edit('lib/event_store.rb', (s) => s.replace('# touched\n', ''));
  edit('app/slices/wallet/domain/deposit.rb', (s) => s.replace('"amount_cents must be a positive integer"', '"amount must be positive"'));
  r = commit('feat: Deposit');
  assert.equal(r.code, 1, r.output);
  assert.match(r.output, /\[gate\] failed/);
  assert.match(r.output, /bundle exec rspec spec\/slices\/wallet/);

  // Acceptance 6: a commit that passes the guard also passes the full gate.
  edit('app/slices/wallet/domain/deposit.rb', (s) => s.replace('"amount must be positive"', '"amount_cents must be a positive integer"'));
  r = commit('feat: Deposit');
  assert.equal(r.code, 0, r.output);
  for (const args of [['rspec'], ['rubocop'], ['packwerk', 'check']]) {
    const full = spawnSync('bundle', ['exec', ...args], { cwd: app, encoding: 'utf8' });
    assert.equal(full.status, 0, `${args.join(' ')}:\n${full.stdout}${full.stderr}`);
  }

  // Acceptance 2: a chore commit touching only config/ passes.
  edit('config/application.rb', (s) => s + '# tuned\n');
  r = commit('chore: config');
  assert.equal(r.code, 0, r.output);

  // Acceptance 7: a manual run without --staged reports on uncommitted work.
  edit('lib/result.rb', (s) => s + '# touched\n');
  edit('app/slices/wallet/domain/withdraw.rb', (s) => s + '# touched\n');
  const manual = spawnSync(process.execPath, ['.build-kit/lib/check-commit-scope.cjs'], { cwd: app, encoding: 'utf8' });
  assert.equal(manual.status, 1);
  assert.match(manual.stderr, /lib\/result\.rb — \[blocked-paths\]/);
});
