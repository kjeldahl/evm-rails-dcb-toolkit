'use strict';

// One fixture test per check: a fake repo, a passing change and a violating
// one, and the violation list asserted by check name. The runner is driven
// exactly as the hooks drive it (--staged; --message for the slice-aware
// ones), so these also cover the runner's index-vs-working-tree file access.

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

// A committed baseline so "modified" and "added" statuses both exist.
function baseline(repo) {
  writeGoodContext(repo);
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\nend\n');
  repo.write('lib/event_store.rb', 'module EventStore\nend\n');
  repo.write('config/application.rb', 'module App\nend\n');
  repo.commitAll('init');
  return repo;
}

test('00-blocked-paths: shared plumbing, config/ and .build-kit/ are rejected; routes.rb, .slices/ and AGENTS.local.md are not', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/domain/place_order.rb', repo.read('app/slices/orders/domain/place_order.rb') + '# touched\n');
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  resources :orders, only: :create, module: :orders\nend\n');
  repo.write('.build-kit/.slices/orders/index.json', '{"slices":[]}');
  repo.write('.build-kit/AGENTS.local.md', '# notes\n');
  repo.stage();
  assert.deepEqual(repo.run(['--staged']).violations, []);

  repo.write('lib/event_store.rb', '# changed\n');
  repo.write('Gemfile', 'gem "x"\n');
  repo.write('config/application.rb', '# changed\n');
  repo.write('.build-kit/CLAUDE.md', '# changed\n');
  repo.write('app/controllers/application_controller.rb', 'class ApplicationController; end\n');
  repo.stage();
  const r = repo.run(['--staged']);
  assert.equal(r.code, 1);
  assert.deepEqual(
    r.violations.filter((v) => v.check === 'blocked-paths').map((v) => v.path).sort(),
    ['.build-kit/CLAUDE.md', 'Gemfile', 'app/controllers/application_controller.rb', 'config/application.rb', 'lib/event_store.rb'],
  );
}));

test('10-slice-scope: a file outside the allowed set is rejected, the documented exceptions pass', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/domain/place_order.rb', '# v2\n');
  repo.write('docs/screens/place-order.md', '# brief\n');
  repo.write('progress.txt', 'done\n');
  repo.stage();
  assert.deepEqual(repo.run(['--staged']).violations, []);

  repo.write('README.md', '# app\n');
  repo.write('.claude/skills/build-state-change/SKILL.md', '# improved\n');
  repo.stage();
  const r = repo.run(['--staged']);
  assert.deepEqual(r.violations.filter((v) => v.check === 'slice-scope').map((v) => v.path).sort(), ['.claude/skills/build-state-change/SKILL.md', 'README.md']);
}));

test('15-one-context: two context directories in one commit are rejected', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/domain/place_order.rb', '# v2\n').stage();
  assert.ok(!repo.run(['--staged']).checks.includes('one-context'));

  repo.write('app/slices/billing/package.yml', 'enforce_dependencies: true\n').stage();
  const r = repo.run(['--staged']);
  assert.ok(r.checks.includes('one-context'), r.stderr);
  assert.match(r.violations.find((v) => v.check === 'one-context').reason, /billing, orders/);
}));

test('20-package-yml: a context directory without package.yml is rejected, one staged with it passes', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/billing/domain/events.rb', 'module Billing; module Events; end; end\n').stage();
  let r = repo.run(['--staged']);
  assert.deepEqual(r.violations.filter((v) => v.check === 'package-yml').map((v) => v.path), ['app/slices/billing/package.yml']);

  // On disk but not staged is still missing from the commit.
  repo.write('app/slices/billing/package.yml', 'enforce_dependencies: true\n');
  r = repo.run(['--staged']);
  assert.ok(r.checks.includes('package-yml'));

  repo.stage();
  r = repo.run(['--staged']);
  assert.ok(!r.checks.includes('package-yml'), r.stderr);
}));

test('30-spec-present: a domain file without its spec is rejected; events.rb needs none', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/domain/events.rb', repo.read('app/slices/orders/domain/events.rb') + '# more\n').stage();
  assert.ok(!repo.run(['--staged']).checks.includes('spec-present'));

  repo.write('app/slices/orders/domain/cancel_order.rb', 'module Orders; class CancelOrder; end; end\n').stage();
  let r = repo.run(['--staged']);
  assert.deepEqual(r.violations.filter((v) => v.check === 'spec-present').map((v) => v.path), ['app/slices/orders/domain/cancel_order.rb']);
  assert.match(r.violations[0].reason, /spec\/slices\/orders\/cancel_order_spec\.rb/);

  repo.write('spec/slices/orders/cancel_order_spec.rb', 'RSpec.describe Orders::CancelOrder do\nend\n').stage();
  r = repo.run(['--staged']);
  assert.ok(!r.checks.includes('spec-present'), r.stderr);
}));

test('40-routes-module: an added resources line without module: is rejected; module:, to: "ctx/…" and member verbs pass', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/domain/place_order.rb', '# v2\n');
  repo.write(
    'config/routes.rb',
    [
      'Rails.application.routes.draw do',
      '  get "openapi.json" => "openapi#show"',
      '  resources :orders, only: :create, module: :orders do',
      '    member do',
      '      post :cancel',
      '    end',
      '  end',
      '  post "orders/:id/refund", to: "orders/refunds#create"',
      'end',
      '',
    ].join('\n'),
  );
  repo.stage();
  assert.ok(!repo.run(['--staged']).checks.includes('routes-module'));

  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\n  resources :orders, only: :create\nend\n').stage();
  let r = repo.run(['--staged']);
  assert.equal(r.violations.filter((v) => v.check === 'routes-module').length, 1);
  assert.match(r.violations.find((v) => v.check === 'routes-module').reason, /module: :orders/);

  // The wrong context's module is the same runtime failure.
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\n  resources :orders, only: :create, module: :billing\nend\n').stage();
  r = repo.run(['--staged']);
  assert.ok(r.checks.includes('routes-module'));

  // Only lines *added* by this change are judged: the pre-existing openapi route never is.
  repo.write('config/routes.rb', 'Rails.application.routes.draw do\n  get "openapi.json" => "openapi#show"\n  # comment only\nend\n').stage();
  r = repo.run(['--staged']);
  assert.ok(!r.checks.includes('routes-module'));
}));

test('45-openapi-present: a staged controller without web/openapi.rb is rejected', withRepo(async (repo) => {
  baseline(repo);
  repo.write('app/slices/orders/web/orders_controller.rb', 'module Orders; class OrdersController < ApplicationController; end; end\n').stage();
  let r = repo.run(['--staged']);
  assert.deepEqual(r.violations.filter((v) => v.check === 'openapi-present').map((v) => v.path), ['app/slices/orders/web/openapi.rb']);

  repo.write('app/slices/orders/web/openapi.rb', 'module Orders; module Openapi; def self.paths = {}; end; end\n').stage();
  r = repo.run(['--staged']);
  assert.ok(!r.checks.includes('openapi-present'), r.stderr);
}));

test('90-gate: runs this context\'s specs, rubocop on the staged Ruby files and packwerk; reports the first failure; skipped once another check failed', withRepo(async (repo) => {
  baseline(repo);
  repo.write('Gemfile', 'source "https://rubygems.org"\n').commitAll('chore: gemfile');
  repo.write('app/slices/orders/domain/place_order.rb', '# v2\n').stage();

  let r = repo.run(['--staged']);
  assert.deepEqual(r.violations, []);
  assert.deepEqual(repo.bundleCalls(), ['exec rspec spec/slices/orders', 'exec rubocop app/slices/orders/domain/place_order.rb', 'exec packwerk check']);

  r = repo.run(['--staged'], { FAKE_BUNDLE_FAIL: 'rspec' });
  assert.deepEqual(r.checks, ['gate']);
  assert.equal(r.violations[0].path, '(bundle exec rspec spec/slices/orders)');
  assert.match(r.violations[0].reason, /1 example, 1 failure/);

  // Already rejected by a fast check → the slow gate is not run at all.
  repo.write('lib/event_store.rb', '# changed\n').stage();
  const before = repo.bundleCalls().length;
  r = repo.run(['--staged'], { FAKE_BUNDLE_FAIL: 'rspec' });
  assert.ok(r.checks.includes('blocked-paths'));
  assert.ok(!r.checks.includes('gate'));
  assert.equal(repo.bundleCalls().length, before);
}));

// --- slice-aware checks (commit-msg) ---------------------------------------

function sliceBaseline(repo) {
  baseline(repo);
  writeBoardSlice(repo);
  repo.commitAll('chore: board');
  repo.write('app/slices/orders/domain/place_order.rb', repo.read('app/slices/orders/domain/place_order.rb') + '# v2\n');
  return repo;
}

function runMsg(repo, message = 'feat: Place Order') {
  repo.stage();
  return repo.run(['--staged', '--message', repo.messageFile(message)]);
}

test('50-spec-coverage: every scenario title appears literally as an example or group; missing ones are named', withRepo(async (repo) => {
  sliceBaseline(repo);
  let r = runMsg(repo);
  assert.deepEqual(r.violations, []);
  assert.equal(r.slice, 'Place Order');

  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\n  it "an order is placed" do\n  end\nend\n');
  r = runMsg(repo);
  assert.deepEqual(r.checks, ['spec-coverage']);
  assert.match(r.violations[0].reason, /missing spec for scenario 'an order cannot be placed twice'/);

  // A describe group carrying the title satisfies it (the kit's rule for duplicate titles).
  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\n  it "an order is placed" do\n  end\n  describe "an order cannot be placed twice" do\n    it "with the same id" do\n    end\n  end\nend\n');
  r = runMsg(repo);
  assert.deepEqual(r.violations, []);
}));

test('50-spec-coverage: two board scenarios with one title need two examples or one group', withRepo(async (repo) => {
  baseline(repo);
  const slice = writeBoardSlice(repo);
  slice.specifications.push({ ...slice.specifications[1], id: 'sp-3' });
  writeBoardSlice(repo, { slice });
  repo.commitAll('chore: board');
  repo.write('app/slices/orders/domain/place_order.rb', repo.read('app/slices/orders/domain/place_order.rb') + '# v2\n');

  let r = runMsg(repo);
  assert.deepEqual(r.checks, ['spec-coverage']);
  assert.match(r.violations[0].reason, /2 scenarios with this title, found 1/);

  repo.write('spec/slices/orders/place_order_spec.rb', 'RSpec.describe Orders::PlaceOrder do\n  it "an order is placed" do\n  end\n  it "an order cannot be placed twice" do\n  end\n  it "an order cannot be placed twice" do\n  end\nend\n');
  r = runMsg(repo);
  assert.deepEqual(r.violations, []);
}));

test('55-rejection-messages: a SPEC_ERROR message must appear verbatim in the context\'s code', withRepo(async (repo) => {
  sliceBaseline(repo);
  assert.deepEqual(runMsg(repo).violations, []);

  repo.write('app/slices/orders/domain/place_order.rb', repo.read('app/slices/orders/domain/place_order.rb').replace('Order already placed', 'This order was already placed'));
  const r = runMsg(repo);
  assert.deepEqual(r.checks, ['rejection-messages']);
  assert.match(r.violations[0].reason, /'Order already placed'/);
}));

test('60-event-types: the owned event must be constructed with the board title as PascalCase type', withRepo(async (repo) => {
  sliceBaseline(repo);
  assert.deepEqual(runMsg(repo).violations, []);

  repo.write('app/slices/orders/domain/events.rb', repo.read('app/slices/orders/domain/events.rb').replace('"OrderPlaced"', '"OrderWasPlaced"'));
  let r = runMsg(repo);
  assert.deepEqual(r.checks, ['event-types']);
  assert.match(r.violations[0].reason, /type: "OrderPlaced"/);

  repo.remove('app/slices/orders/domain/events.rb');
  r = runMsg(repo);
  assert.ok(r.checks.includes('event-types'));
  assert.match(r.violations.find((v) => v.check === 'event-types').reason, /missing/);
}));

test('60-event-types: events a state-view slice merely consumes are not its to construct', withRepo(async (repo) => {
  baseline(repo);
  const slice = writeBoardSlice(repo);
  slice.sliceType = 'STATE_VIEW';
  slice.commands = [];
  slice.readmodels = [{ id: 'rm-1', title: 'orders', type: 'READMODEL', fields: [{ name: 'orderId', type: 'UUID', idAttribute: true }] }];
  slice.events[0].dependencies = [{ id: 'rm-1', type: 'OUTBOUND', title: 'orders', elementType: 'READMODEL' }];
  slice.specifications = [];
  writeBoardSlice(repo, { slice });
  repo.commitAll('chore: board');
  repo.write('app/slices/orders/domain/orders.rb', 'module Orders; module OrdersView; end; end\n');
  repo.write('spec/slices/orders/orders_spec.rb', 'RSpec.describe Orders::OrdersView do\nend\n');
  repo.write('app/slices/orders/domain/events.rb', 'module Orders\n  module Events\n  end\nend\n');
  assert.deepEqual(runMsg(repo).violations, []);
}));

test('65-id-tags: every idAttribute field needs its "<key>:#{…}" tag in the event constructor', withRepo(async (repo) => {
  sliceBaseline(repo);
  assert.deepEqual(runMsg(repo).violations, []);

  repo.write('app/slices/orders/domain/events.rb', repo.read('app/slices/orders/domain/events.rb').replace(', "customer:#{customer_id}"', ''));
  const r = runMsg(repo);
  assert.deepEqual(r.checks, ['id-tags']);
  assert.match(r.violations[0].reason, /"customer:#\{…\}" tag/);
  assert.match(r.violations[0].reason, /'customerId'/);
}));

test('70-no-pii-tags: a pii field inside a tags: array is rejected', withRepo(async (repo) => {
  sliceBaseline(repo);
  assert.deepEqual(runMsg(repo).violations, []);

  repo.write('app/slices/orders/domain/events.rb', repo.read('app/slices/orders/domain/events.rb').replace('"customer:#{customer_id}" ]', '"customer:#{customer_id}", "email:#{email}" ]'));
  const r = runMsg(repo);
  assert.deepEqual(r.checks, ['no-pii-tags']);
  assert.match(r.violations[0].reason, /'email' is pii: true/);
}));

test('slice-aware checks report every distinct problem, even on the same file', withRepo(async (repo) => {
  sliceBaseline(repo);
  repo.write(
    'app/slices/orders/domain/events.rb',
    repo.read('app/slices/orders/domain/events.rb').replace('"customer:#{customer_id}" ]', '"email:#{email}" ]'),
  );
  const r = runMsg(repo);
  assert.deepEqual(r.checks, ['id-tags', 'no-pii-tags']);
}));
