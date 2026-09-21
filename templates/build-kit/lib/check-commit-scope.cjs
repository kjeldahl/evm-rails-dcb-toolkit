#!/usr/bin/env node
'use strict';

// Runner for the slice commit guard. Loads every check module from
// ./checks/*.cjs and runs it against the changed files — every uncommitted
// change (staged + unstaged + untracked) by default, or just the staged
// changeset with --staged.
//
// A *slice commit* is one that touches app/slices/<context>/ or
// spec/slices/<context>/ (SLICE_PATTERN). Anything else — a kit upgrade, a
// template.rb run, a `chore:` commit — passes untouched: no check is even
// loaded.
//
// Two kinds of check (see ./checks/README.md for the full contract):
//   - path-level checks run from the pre-commit hook (`--staged`) and from a
//     manual run; they only need the list of changed files.
//   - slice-aware checks (`needsSlice: true`) also need the board's
//     slice.json. pre-commit cannot know which slice is being committed, but
//     the commit message can (`feat: <Slice Name>`), so the commit-msg hook
//     re-runs the runner with `--message <file>`, and only those checks run.
//     A manual run resolves the slice from `--slice "<title>"`, or from the
//     one index entry marked InProgress (the ralph loop sets that before it
//     builds) — no slice found → those checks are skipped, never failed.
//
// Check interface:
//   module.exports = {
//     name: 'my-check',              // short id, shown in violation output
//     skipIfAlreadyFailing: false,   // optional — skip once an earlier check failed
//     needsSlice: false,             // optional — only run when ctx.slice is set
//     run(ctx) {
//       return [{ path: 'app/slices/x/domain/y.rb', reason: 'why this is a problem' }];
//     },
//   };
//
// Zero dependencies — plain Node, so it works from git's hooks
// (see ../../.githooks/), by hand, or from CI. Invoked as:
//   node .build-kit/lib/check-commit-scope.cjs [--staged] [--message <file>] [--slice "<title>"] [--json]

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { findSliceByTitle, findInProgressSlice, sliceTitleFromMessage } = require('./util/find-slice.cjs');

// Group 2 is the context directory name — this kit has one directory per
// board *context*, not per slice (.build-kit/CLAUDE.md).
const SLICE_PATTERN = /^(app|spec)\/slices\/([^/]+)\//;

function parseArgs(argv) {
  const opts = { staged: false, message: null, slice: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged') opts.staged = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--message') opts.message = argv[++i];
    else if (a === '--slice') opts.slice = argv[++i];
    else if (a.startsWith('--message=')) opts.message = a.slice('--message='.length);
    else if (a.startsWith('--slice=')) opts.slice = a.slice('--slice='.length);
  }
  return opts;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function parseNameStatus(out) {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status[0], path: rest.join('\t') };
    });
}

// --relative scopes and rewrites paths relative to cwd instead of the git
// top-level — required when this runs from a subdirectory of a larger repo
// (a monorepo with the Rails app in `backend/`): without it every path comes
// back prefixed, SLICE_PATTERN never matches, and the guard silently no-ops.
function stagedChanges() {
  return parseNameStatus(git(['diff', '--cached', '--name-status', '--no-renames', '--relative']));
}

// The empty tree: what `git diff HEAD` has to compare against before the
// first commit exists.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function headOrEmptyTree() {
  try {
    git(['rev-parse', '--verify', '-q', 'HEAD']);
    return 'HEAD';
  } catch {
    return EMPTY_TREE;
  }
}

function allChanges() {
  // Working tree vs HEAD already covers both staged and unstaged edits to
  // tracked files; untracked (never-`git add`ed) files need a separate call.
  const tracked = parseNameStatus(git(['diff', headOrEmptyTree(), '--name-status', '--no-renames', '--relative']));
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
    .map((p) => ({ status: 'A', path: p }));
  return [...tracked, ...untracked];
}

// What the commit will contain — the index in --staged mode, the working
// tree otherwise. `:./path` is git's cwd-relative index address, which keeps
// the monorepo-subfolder case correct (a bare `:path` is top-level-relative).
function makeFileAccess(staged, repoRoot) {
  const exists = (p) => {
    if (!staged) return fs.existsSync(path.join(repoRoot, p));
    try {
      git(['cat-file', '-e', `:./${p}`], { cwd: repoRoot });
      return true;
    } catch {
      return false;
    }
  };
  const read = (p) => {
    try {
      if (!staged) return fs.readFileSync(path.join(repoRoot, p), 'utf8');
      return git(['show', `:./${p}`], { cwd: repoRoot });
    } catch {
      return null;
    }
  };
  // Files under a directory prefix that will exist after the commit.
  const files = (prefix) => {
    try {
      const tracked = git(['ls-files', '--', prefix], { cwd: repoRoot }).split('\n').filter(Boolean);
      if (staged) return tracked;
      const untracked = git(['ls-files', '--others', '--exclude-standard', '--', prefix], { cwd: repoRoot })
        .split('\n')
        .filter(Boolean);
      return [...new Set([...tracked, ...untracked])];
    } catch {
      return [];
    }
  };
  // The lines this change *adds* to a file (no leading "+"), so a check can
  // judge new code without re-litigating what was already committed.
  const addedLines = (p) => {
    let diff;
    try {
      diff = staged
        ? git(['diff', '--cached', '-U0', '--no-color', '--relative', '--', p], { cwd: repoRoot })
        : git(['diff', headOrEmptyTree(), '-U0', '--no-color', '--relative', '--', p], { cwd: repoRoot });
    } catch {
      return [];
    }
    const lines = diff
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .map((l) => l.slice(1));
    if (lines.length === 0 && !staged) {
      // Untracked file: every line is new.
      const isUntracked = git(['ls-files', '--others', '--exclude-standard', '--', p], { cwd: repoRoot }).trim() !== '';
      if (isUntracked) return (read(p) || '').split('\n');
    }
    return lines;
  };
  return { exists, read, files, addedLines };
}

function loadChecks() {
  const checksDir = path.join(__dirname, 'checks');
  if (!fs.existsSync(checksDir)) return [];
  return fs
    .readdirSync(checksDir)
    .filter((f) => f.endsWith('.cjs'))
    .sort() // numeric filename prefixes (00-, 10-, ...) control run order
    .map((f) => {
      let mod;
      try {
        mod = require(path.join(checksDir, f));
      } catch (err) {
        console.error(`check-commit-scope: failed to load checks/${f} — ${err.message}`);
        return null;
      }
      if (typeof mod?.run !== 'function') {
        console.error(`check-commit-scope: skipping checks/${f} — does not export { name, run(ctx) }`);
        return null;
      }
      return {
        file: f,
        name: mod.name || f,
        run: mod.run,
        skipIfAlreadyFailing: !!mod.skipIfAlreadyFailing,
        needsSlice: !!mod.needsSlice,
      };
    })
    .filter(Boolean);
}

function resolveSlice(opts, repoRoot) {
  if (opts.message) {
    let text;
    try {
      text = fs.readFileSync(opts.message, 'utf8');
    } catch (err) {
      console.error(`check-commit-scope: could not read commit message ${opts.message} — ${err.message}`);
      return null;
    }
    const title = sliceTitleFromMessage(text);
    return title ? findSliceByTitle(repoRoot, title) : null;
  }
  if (opts.slice) return findSliceByTitle(repoRoot, opts.slice);
  // Manual run: the slice being built is the one the loop marked InProgress.
  if (!opts.staged) return findInProgressSlice(repoRoot);
  return null;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();

  let changes;
  try {
    changes = opts.staged ? stagedChanges() : allChanges();
  } catch (err) {
    console.error(`check-commit-scope: could not read ${opts.staged ? 'staged' : 'uncommitted'} changes —`, err.message);
    process.exit(1);
  }

  const contexts = new Set();
  for (const c of changes) {
    const m = SLICE_PATTERN.exec(c.path);
    if (m) contexts.add(m[2]);
  }
  const touchesSlice = contexts.size > 0;
  if (!touchesSlice) {
    if (opts.json) console.log(JSON.stringify({ violations: [], skipped: 'not a slice commit' }));
    process.exit(0); // not a slice commit — nothing to enforce
  }

  const slice = resolveSlice(opts, repoRoot);

  const ctx = {
    changes,
    contexts,
    touchesSlice,
    staged: opts.staged,
    // Deliberately process.cwd(), not `git rev-parse --show-toplevel` — this
    // project can be a subdirectory of a larger repo (see the --relative note
    // on allChanges/stagedChanges above), and every path here (and every path
    // checks join onto repoRoot, e.g. `.build-kit/.slices/`) is relative to
    // this project's own root, not the outer git repo's.
    repoRoot,
    SLICE_PATTERN,
    slice,
    ...makeFileAccess(opts.staged, repoRoot),
  };

  // From commit-msg, pre-commit has already run the path checks on the same
  // index; only the slice-aware ones are new information.
  const phase = opts.message ? 'commit-msg' : 'pre-commit';
  const checks = loadChecks().filter((c) => {
    if (c.needsSlice) return !!slice;
    return phase !== 'commit-msg';
  });

  const violations = [];
  // Path-level checks all say "this path is wrong" — the first to flag a path
  // wins, avoiding repeat noise. Slice-aware checks each say something
  // different about the same file (a missing tag and a pii tag can both sit
  // in events.rb), so those dedupe per check.
  const claimed = new Set();

  for (const check of checks) {
    if (check.skipIfAlreadyFailing && violations.length > 0) continue;

    let result;
    try {
      result = check.run(ctx) || [];
    } catch (err) {
      violations.push({ path: '(check error)', check: check.name, reason: `threw: ${err.message}` });
      continue;
    }

    for (const v of result) {
      const key = check.needsSlice ? `${check.name}\0${v.path}\0${v.reason}` : v.path;
      if (claimed.has(key)) continue;
      claimed.add(key);
      violations.push({ path: v.path, check: check.name, reason: v.reason });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ violations, slice: slice ? slice.title : null, contexts: [...contexts] }));
  } else if (violations.length > 0) {
    console.error('\n❌ commit blocked — slice commit guard found issues:\n');
    for (const v of violations) console.error(`  - ${v.path} — [${v.check}] ${v.reason}`);
    console.error('\nFix the violation and commit again — never pass --no-verify.');
    console.error('See .build-kit/lib/checks/ for what each check enforces.\n');
  }

  process.exit(violations.length > 0 ? 1 : 0);
}

main();
