'use strict';

// End to end through git itself: the kit's root overlay (the wallet worked
// example) in a fresh repo, the hooks installed the way `init --hooks` does
// (copy .githooks/, chmod +x pre-commit, `git config core.hooksPath <abs>`),
// and real `git commit`s — rejected, then accepted after the fix. The gate
// runs against a fake `bundle` here; test/e2e-rails.test.cjs runs the same
// story against a scaffolded Rails app when one is provided.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { makeRepo, writeBoardSlice } = require('./helpers.cjs');

test('git commit through the installed hooks: rejected by pre-commit, then by commit-msg, then accepted', async (t) => {
  const repo = makeRepo({ overlay: true });
  t.after(() => repo.cleanup());
  repo.write('Gemfile', 'source "https://rubygems.org"\n');
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\nend\n');
  // The wallet worked example as a board slice, so the commit-msg checks have something to check.
  writeBoardSlice(repo, {
    contextSlug: 'wallet',
    folder: 'deposit',
    slice: {
      id: 'wallet-1',
      title: 'Deposit',
      context: 'Wallet',
      sliceType: 'STATE_CHANGE',
      status: 'InProgress',
      commands: [{ id: 'c1', title: 'Deposit', type: 'COMMAND', fields: [{ name: 'walletId', type: 'UUID', idAttribute: true }, { name: 'amountCents', type: 'Int' }, { name: 'depositId', type: 'UUID', idAttribute: true, generated: true }] }],
      events: [{ id: 'e1', title: 'Deposited', type: 'EVENT', context: 'INTERNAL', fields: [{ name: 'walletId', type: 'UUID', idAttribute: true }, { name: 'amountCents', type: 'Int' }, { name: 'depositId', type: 'UUID', idAttribute: true }] }],
      readmodels: [],
      screens: [],
      processors: [],
      tables: [],
      specifications: [
        { id: 's1', title: 'a deposit is recorded', given: [], when: [], then: [{ id: 't1', title: 'Deposited', type: 'SPEC_EVENT' }] },
        { id: 's2', title: 'a deposit must be a positive amount', given: [], when: [], then: [{ id: 't2', title: 'amount_cents must be a positive integer', type: 'SPEC_ERROR' }] },
      ],
    },
  });
  repo.commitAll('init');
  repo.installHooks();
  repo.commitAll('chore: install the commit guard'); // .githooks/ is project content, committed like `init --hooks` output would be

  // 1. A slice commit that also touches lib/event_store.rb is rejected by pre-commit (00-blocked-paths).
  repo.write('app/slices/wallet/domain/deposit.rb', repo.read('app/slices/wallet/domain/deposit.rb') + '# touched\n');
  repo.write('lib/event_store.rb', repo.read('lib/event_store.rb') + '# touched\n');
  let r = repo.commit('feat: Deposit');
  assert.equal(r.code, 1);
  assert.match(r.output, /\[blocked-paths\] .*lib\/event_store\.rb|lib\/event_store\.rb — \[blocked-paths\]/);
  assert.deepEqual(repo.log(), ['chore: install the commit guard', 'init']);

  // 2. Same commit with the plumbing change reverted, but a board scenario's spec renamed: rejected by commit-msg (50-spec-coverage).
  repo.write('lib/event_store.rb', repo.read('lib/event_store.rb').replace('# touched\n', ''));
  repo.write('spec/slices/wallet/deposit_spec.rb', repo.read('spec/slices/wallet/deposit_spec.rb').replace('it "a deposit must be a positive amount"', 'it "a deposit must be positive"'));
  r = repo.commit('feat: Deposit');
  assert.equal(r.code, 1);
  assert.match(r.output, /\[spec-coverage\] missing spec for scenario 'a deposit must be a positive amount'/);
  assert.deepEqual(repo.log(), ['chore: install the commit guard', 'init']);

  // 3. Spec title restored: accepted, and the gate ran scoped to the wallet context.
  repo.write('spec/slices/wallet/deposit_spec.rb', repo.read('spec/slices/wallet/deposit_spec.rb').replace('it "a deposit must be positive"', 'it "a deposit must be a positive amount"'));
  r = repo.commit('feat: Deposit');
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(repo.log(), ['feat: Deposit', 'chore: install the commit guard', 'init']);
  assert.ok(repo.bundleCalls().includes('exec rspec spec/slices/wallet'));

  // 4. A chore commit touching only config/ passes untouched — not a slice commit.
  repo.write('config/application.rb', '# tuned\n');
  r = repo.commit('chore: config');
  assert.equal(r.code, 0, r.output);
  assert.equal(repo.log()[0], 'chore: config');

  // 5. A route added without module: is rejected (40-routes-module) — acceptance 4.
  repo.write('app/slices/wallet/web/wallets_controller.rb', repo.read('app/slices/wallet/web/wallets_controller.rb') + '# touched\n');
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\n  resources :things, only: :show\nend\n');
  r = repo.commit('feat: Deposit');
  assert.equal(r.code, 1);
  assert.match(r.output, /\[routes-module\]/);
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\n  resources :things, only: :show, module: :wallet\nend\n');
  r = repo.commit('feat: Deposit');
  assert.equal(r.code, 0, r.output);
});

test('the hook files carry the executable bit in git', () => {
  const { execFileSync } = require('child_process');
  const { KIT } = require('./helpers.cjs');
  const out = execFileSync('git', ['ls-files', '-s', '--', 'templates/root/.githooks'], { cwd: KIT, encoding: 'utf8' });
  const modes = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [mode, , , file] = line.split(/\s+/);
        return [file.split('/').pop(), mode];
      }),
  );
  assert.equal(modes['pre-commit'], '100755');
  assert.equal(modes['commit-msg'], '100755');
});
