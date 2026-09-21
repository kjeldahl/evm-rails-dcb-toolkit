'use strict';

// Fixture repos for the commit-guard tests: a temp dir with `git init`, the
// kit's .build-kit/lib/ copied in, and helpers to write, stage and run the
// runner with --json. Each test gets its own repo; nothing here touches the
// kit repo itself.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.resolve(__dirname, '..');
const LIB_SRC = path.join(KIT, 'templates', 'build-kit', 'lib');
const HOOKS_SRC = path.join(KIT, 'templates', 'root', '.githooks');
const ROOT_SRC = path.join(KIT, 'templates', 'root');

const RUNNER = '.build-kit/lib/check-commit-scope.cjs';

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

// A `bundle` on PATH that records its arguments and exits as told, so the
// gate check can be exercised without Ruby: `FAKE_BUNDLE_FAIL=<substring>`
// makes the invocation whose arguments contain that substring fail.
function fakeBundleDir(repo) {
  const bin = `${repo}-bin`; // a sibling, not inside the repo — an untracked file there would be a (correct) scope violation
  fs.mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'bundle');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `echo "$*" >> "${path.join(bin, 'calls.log')}"`,
      'if [ -n "$FAKE_BUNDLE_FAIL" ] && echo "$*" | grep -q -- "$FAKE_BUNDLE_FAIL"; then',
      '  echo "1 example, 1 failure"; echo "rspec ./spec/slices/x_spec.rb:3 # boom"; exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  fs.chmodSync(script, 0o755);
  return bin;
}

function makeRepo({ overlay = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evm-guard-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'guard@test']);
  git(dir, ['config', 'user.name', 'guard test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (overlay) {
    // The kit's root overlay minus the hooks (installed explicitly, like the CLI does).
    fs.cpSync(ROOT_SRC, dir, { recursive: true, filter: (s) => !s.includes(`${path.sep}.githooks`) });
  }
  fs.mkdirSync(path.join(dir, '.build-kit'), { recursive: true });
  fs.cpSync(LIB_SRC, path.join(dir, '.build-kit', 'lib'), { recursive: true });
  const binDir = fakeBundleDir(dir);

  const repo = {
    dir,
    binDir,
    write(rel, content) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return repo;
    },
    remove(rel) {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
      return repo;
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    },
    stage(...paths) {
      git(dir, ['add', '-A', ...(paths.length ? ['--', ...paths] : [])]);
      return repo;
    },
    unstage() {
      git(dir, ['reset', '-q']);
      return repo;
    },
    commitAll(message) {
      git(dir, ['add', '-A']);
      git(dir, ['commit', '-q', '-m', message]);
      return repo;
    },
    // The runner, --json, from the repo root. Returns { code, violations, checks, slice, contexts, stderr }.
    run(args = [], env = {}) {
      const r = spawnSync(process.execPath, [RUNNER, '--json', ...args], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
      });
      let parsed = {};
      try {
        parsed = JSON.parse(r.stdout.trim().split('\n').pop());
      } catch {
        // no JSON — a crash; the caller sees stderr
      }
      const violations = parsed.violations || [];
      return {
        code: r.status,
        violations,
        checks: [...new Set(violations.map((v) => v.check))].sort(), // which checks fired, once each

        slice: parsed.slice ?? null,
        contexts: parsed.contexts || [],
        skipped: parsed.skipped,
        stderr: r.stderr,
      };
    },
    // A real `git commit` through the installed hooks. Returns { code, output }.
    installHooks() {
      fs.cpSync(HOOKS_SRC, path.join(dir, '.githooks'), { recursive: true });
      for (const hook of ['pre-commit', 'commit-msg']) fs.chmodSync(path.join(dir, '.githooks', hook), 0o755);
      git(dir, ['config', 'core.hooksPath', path.join(dir, '.githooks')]);
      return repo;
    },
    commit(message, env = {}) {
      git(dir, ['add', '-A']);
      const r = spawnSync('git', ['commit', '-q', '-m', message], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...env },
      });
      return { code: r.status, output: `${r.stdout}${r.stderr}` };
    },
    log() {
      return git(dir, ['log', '--format=%s']).trim().split('\n').filter(Boolean);
    },
    bundleCalls() {
      try {
        return fs.readFileSync(path.join(binDir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
    messageFile(text) {
      const file = path.join(dir, '.git', 'TEST_COMMIT_MSG');
      fs.writeFileSync(file, text);
      return file;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    },
  };
  return repo;
}

// A minimal but complete context: the shapes the checks look for, all
// present, so a test breaks exactly one thing at a time.
function writeGoodContext(repo, ctx = 'orders') {
  repo
    .write(`app/slices/${ctx}/package.yml`, 'enforce_dependencies: true\ndependencies:\n  - "."\n')
    .write(
      `app/slices/${ctx}/domain/events.rb`,
      [
        'module Orders',
        '  module Events',
        '    extend self',
        '',
        '    def order_placed(order_id:, customer_id:, email:)',
        '      DcbEventStore::Event.new(',
        '        type: "OrderPlaced",',
        '        data: { order_id:, customer_id:, email: },',
        '        tags: [ "order:#{order_id}", "customer:#{customer_id}" ]',
        '      )',
        '    end',
        '  end',
        'end',
        '',
      ].join('\n'),
    )
    .write(
      `app/slices/${ctx}/domain/place_order.rb`,
      [
        'module Orders',
        '  class PlaceOrder',
        '    def self.call(order_id:, customer_id:, email:)',
        '      return Result.failure("order_id is required") if order_id.to_s.empty?',
        '      return Result.failure("Order already placed") if placed?',
        '      EventStore.append(Events.order_placed(order_id:, customer_id:, email:))',
        '      Result.success(order_id)',
        '    end',
        '  end',
        'end',
        '',
      ].join('\n'),
    )
    .write(
      `spec/slices/${ctx}/place_order_spec.rb`,
      [
        'require "rails_helper"',
        '',
        'RSpec.describe Orders::PlaceOrder do',
        '  it "an order is placed" do',
        '  end',
        '',
        '  it "an order cannot be placed twice" do',
        '  end',
        'end',
        '',
      ].join('\n'),
    );
  return repo;
}

// The board's side of the same context: slice.json + index.json under
// .build-kit/.slices/, for the slice-aware checks.
function writeBoardSlice(repo, { title = 'Place Order', status = 'InProgress', contextSlug = 'orders', folder = 'placeorder', slice = null } = {}) {
  const json = slice || {
    id: 'slice-1',
    title,
    context: 'Orders',
    sliceType: 'STATE_CHANGE',
    status,
    commands: [
      {
        id: 'cmd-1',
        title: 'Place Order',
        type: 'COMMAND',
        fields: [
          { name: 'orderId', type: 'UUID', idAttribute: true },
          { name: 'customerId', type: 'UUID', idAttribute: true },
          { name: 'email', type: 'String', pii: true },
        ],
        dependencies: [{ id: 'evt-1', type: 'OUTBOUND', title: 'Order placed', elementType: 'EVENT' }],
      },
    ],
    events: [
      {
        id: 'evt-1',
        title: 'Order placed',
        type: 'EVENT',
        context: 'INTERNAL',
        fields: [
          { name: 'orderId', type: 'UUID', idAttribute: true },
          { name: 'customerId', type: 'UUID', idAttribute: true },
          { name: 'email', type: 'String', pii: true },
        ],
        dependencies: [{ id: 'cmd-1', type: 'INBOUND', title: 'Place Order', elementType: 'COMMAND' }],
      },
    ],
    readmodels: [],
    screens: [],
    processors: [],
    tables: [],
    specifications: [
      { id: 'sp-1', title: 'an order is placed', given: [], when: [], then: [{ id: 't-1', title: 'Order placed', type: 'SPEC_EVENT' }] },
      { id: 'sp-2', title: 'an order cannot be placed twice', given: [], when: [], then: [{ id: 't-2', title: 'Order already placed', type: 'SPEC_ERROR' }] },
    ],
  };
  repo.write(`.build-kit/.slices/${contextSlug}/${folder}/slice.json`, JSON.stringify(json, null, 2));
  const indexFile = `.build-kit/.slices/${contextSlug}/index.json`;
  let index = { slices: [] };
  try {
    index = JSON.parse(repo.read(indexFile));
  } catch {
    // first slice in this context
  }
  index.slices = index.slices.filter((e) => e.folder !== folder);
  index.slices.push({ id: json.id, slice: json.title, contextName: json.context, contextSlug, folder, status });
  repo.write(indexFile, JSON.stringify(index, null, 2));
  return json;
}

module.exports = { makeRepo, writeGoodContext, writeBoardSlice, git, KIT, ROOT_SRC, LIB_SRC, HOOKS_SRC };
