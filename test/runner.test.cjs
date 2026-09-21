'use strict';

// The runner itself: what counts as a slice commit, the two hook phases, the
// manual (no --staged) mode, and how the slice is resolved from a message.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, writeGoodContext, writeBoardSlice } = require('./helpers.cjs');

function withRepo(fn) {
  return async (t) => {
    const repo = makeRepo();
    t.after(() => repo.cleanup());
    await fn(repo);
  };
}

test('a commit that touches no app/slices or spec/slices path is not a slice commit — nothing runs', withRepo(async (repo) => {
  writeGoodContext(repo).commitAll('init');
  repo.write('lib/event_store.rb', '# changed\n').write('config/application.rb', '# changed\n').write('Gemfile', 'gem "x"\n').stage();
  const r = repo.run(['--staged']);
  assert.equal(r.code, 0);
  assert.equal(r.skipped, 'not a slice commit');
}));

test('without --staged, uncommitted work is checked: unstaged edits and untracked files included', withRepo(async (repo) => {
  writeGoodContext(repo).commitAll('init');
  repo.write('app/slices/orders/domain/place_order.rb', '# v2\n'); // unstaged edit
  repo.write('lib/event_store.rb', '# untracked\n'); // untracked
  const r = repo.run([]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.contexts, ['orders']);
  assert.deepEqual(r.violations.map((v) => v.path), ['lib/event_store.rb']);
}));

test('the pre-commit phase runs path checks only; the commit-msg phase runs slice-aware checks only', withRepo(async (repo) => {
  writeGoodContext(repo);
  writeBoardSlice(repo);
  repo.commitAll('init');
  // One path violation and one slice violation at once.
  repo.write('lib/event_store.rb', '# changed\n');
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\nend\n');
  repo.stage();

  const pre = repo.run(['--staged']);
  assert.deepEqual(pre.checks, ['blocked-paths']);
  assert.equal(pre.slice, null);

  const msg = repo.run(['--staged', '--message', repo.messageFile('feat: Place Order\n\nbody\n')]);
  assert.deepEqual(msg.checks, ['spec-coverage']);
  assert.equal(msg.slice, 'Place Order');
}));

test('the slice title is matched case-insensitively, with the ralph prompt\'s [brackets] and a "slice:" prefix tolerated', withRepo(async (repo) => {
  writeGoodContext(repo);
  writeBoardSlice(repo, { title: 'slice: Place Order' });
  repo.commitAll('init');
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\nend\n').stage();
  for (const message of ['feat: place order', 'feat: [Place Order]', 'feat(orders): slice: Place Order', 'feat!: PLACE ORDER']) {
    const r = repo.run(['--staged', '--message', repo.messageFile(message)]);
    assert.equal(r.slice, 'slice: Place Order', message);
    assert.deepEqual(r.checks, ['spec-coverage'], message);
  }
}));

test('a message that is not feat:, or names a slice the board does not have, skips the slice-aware checks', withRepo(async (repo) => {
  writeGoodContext(repo);
  writeBoardSlice(repo);
  repo.commitAll('init');
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\nend\n').stage();
  for (const message of ['chore: tidy specs', 'fix: Place Order', 'feat: Cancel Order', '']) {
    const r = repo.run(['--staged', '--message', repo.messageFile(message)]);
    assert.equal(r.code, 0, message);
    assert.equal(r.slice, null, message);
  }
}));

test('duplicate slice titles: the InProgress one wins; still ambiguous → skipped', withRepo(async (repo) => {
  writeGoodContext(repo);
  writeBoardSlice(repo, { status: 'Done', folder: 'placeorder' });
  const second = writeBoardSlice(repo, { status: 'InProgress', folder: 'placeorder-2' });
  repo.commitAll('init');
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\nend\n').stage();

  let r = repo.run(['--staged', '--message', repo.messageFile('feat: Place Order')]);
  assert.equal(r.slice, 'Place Order');
  assert.deepEqual(r.checks, ['spec-coverage']);

  writeBoardSlice(repo, { status: 'InProgress', folder: 'placeorder', slice: second });
  repo.stage();
  r = repo.run(['--staged', '--message', repo.messageFile('feat: Place Order')]);
  assert.equal(r.slice, null);
  assert.equal(r.code, 0);
}));

test('a manual run resolves the slice from --slice, or from the one InProgress index entry', withRepo(async (repo) => {
  writeGoodContext(repo);
  writeBoardSlice(repo, { status: 'InProgress' });
  repo.commitAll('init');
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\nend\n');

  let r = repo.run([]);
  assert.equal(r.slice, 'Place Order');
  assert.deepEqual(r.checks, ['spec-coverage']);

  r = repo.run(['--slice', 'Place Order']);
  assert.deepEqual(r.checks, ['spec-coverage']);

  // --staged without a message is the pre-commit phase: no InProgress guessing there.
  repo.stage();
  r = repo.run(['--staged']);
  assert.equal(r.slice, null);
  assert.deepEqual(r.violations, []);
}));

test('works before the first commit exists', withRepo(async (repo) => {
  writeGoodContext(repo);
  repo.write('lib/event_store.rb', '# new\n');
  // Everything is new here, the kit's own .build-kit/lib/ included — which a slice commit may not carry, correctly.
  let r = repo.run([]);
  assert.equal(r.code, 1);
  assert.ok(r.violations.some((v) => v.path === 'lib/event_store.rb' && v.check === 'blocked-paths'), r.stderr);
  assert.ok(r.violations.some((v) => v.path.startsWith('.build-kit/lib/') && v.check === 'blocked-paths'));
  repo.stage('app', 'spec', 'lib');
  r = repo.run(['--staged']);
  assert.deepEqual(r.violations.map((v) => v.path), ['lib/event_store.rb']);
}));

test('works from a subdirectory of a larger repo (paths are project-relative)', async (t) => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const { git, LIB_SRC } = require('./helpers.cjs');
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-guard-outer-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const inner = path.join(outer, 'backend');
  const shim = {
    write(rel, content) {
      fs.mkdirSync(path.dirname(path.join(inner, rel)), { recursive: true });
      fs.writeFileSync(path.join(inner, rel), content);
      return shim;
    },
  };
  const write = shim.write;
  fs.cpSync(LIB_SRC, path.join(inner, '.build-kit', 'lib'), { recursive: true });
  writeGoodContext(shim);
  write('lib/event_store.rb', 'module EventStore\nend\n');
  git(outer, ['init', '-q', '-b', 'main']);
  git(outer, ['config', 'user.email', 'guard@test']);
  git(outer, ['config', 'user.name', 'guard test']);
  git(outer, ['add', '-A']);
  git(outer, ['commit', '-q', '-m', 'init']);

  write('app/slices/orders/domain/place_order.rb', '# v2\n');
  write('lib/event_store.rb', '# changed\n');
  git(outer, ['add', '-A']);

  const r = spawnSync(process.execPath, ['.build-kit/lib/check-commit-scope.cjs', '--staged', '--json'], { cwd: inner, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim());
  assert.deepEqual(out.contexts, ['orders']);
  assert.deepEqual(out.violations.map((v) => v.path), ['lib/event_store.rb']);
  // Index reads are cwd-relative too: the spec the check looks for is found under backend/, not at the outer root.
  assert.ok(!out.violations.some((v) => v.check === 'spec-present'));
});
