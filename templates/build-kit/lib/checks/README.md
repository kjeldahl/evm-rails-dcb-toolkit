# Commit guard checks

Every `*.cjs` file in this folder is loaded and run by
`../check-commit-scope.cjs` against a **slice commit** — one that touches
`app/slices/<context>/` or `spec/slices/<context>/`. A commit that touches
neither (a kit upgrade, a `template.rb` run, a `chore:` commit) loads no
check at all. Files run in filename sort order — that's why they're
numbered.

Same contract as the Node stack's guard, with one Rails-specific difference:
this kit has **one directory per board context**, not per slice, so the
runner's `SLICE_PATTERN` is `/^(app|spec)\/slices\/([^/]+)\//` (group 2 is
the context) and `ctx.contexts` is the set of context directories the
commit touches.

## Two kinds of check, two hooks

| kind | when it runs | needs | examples |
|---|---|---|---|
| path-level | `pre-commit` (`--staged`), and manual runs | the changed file list | `00`–`45`, `90` |
| slice-aware (`needsSlice: true`) | `commit-msg` (`--staged --message <file>`), and manual runs that resolve a slice | the board's `slice.json` too | `50`–`70` |

`pre-commit` cannot know *which* board slice is being committed, but the
kit's commit convention can: `feat: <Slice Name>`. The `commit-msg` hook
hands the message to the runner, which finds the slice in
`.build-kit/.slices/*/index.json` (matching the entry's `slice` title,
case-insensitively; on duplicate titles, the one in status `InProgress`
wins) and reads its `slice.json`. A message that isn't `feat: …`, or names
a slice the board doesn't have, **skips** the slice-aware checks — it never
blocks. A manual run (`node .build-kit/lib/check-commit-scope.cjs`, no
`--staged`) resolves the slice from `--slice "<title>"`, or else from the
one index entry marked `InProgress`.

## The checks

| file | rule | source in `.build-kit/CLAUDE.md` |
|---|---|---|
| `00-blocked-paths` | never `Gemfile`, `Gemfile.lock`, `lib/event_store.rb`, `lib/result.rb`, `config/**` (except `config/routes.rb`), `app/controllers/application_controller.rb`, `.build-kit/**` (except `.slices/**` and `AGENTS.local.md`) | "Don't touch Gemfile, lib/event_store.rb, lib/result.rb or config/" |
| `10-slice-scope` | every path is one of `app/slices/<ctx>/**`, `spec/slices/<ctx>/**`, `config/routes.rb`, `docs/screens/**`, `.build-kit/.slices/**`, `.build-kit/AGENTS.local.md`, `progress.txt` | "Strict path" |
| `15-one-context` | exactly one context directory per commit | "One slice directory per board Context" |
| `20-package-yml` | `app/slices/<ctx>/package.yml` is in the commit | "A new context directory gets a package.yml" |
| `30-spec-present` | each added/modified `app/slices/<ctx>/domain/<name>.rb` (except `events.rb`) has `spec/slices/<ctx>/<name>_spec.rb` | "One example per specifications[] entry" |
| `40-routes-module` | every `resources`/`resource`/verb-with-path line **added** to `config/routes.rb` carries `module: :<ctx>` (or `to: "<ctx>/…"`) | the `uninitialized constant` trap |
| `45-openapi-present` | a `web/*_controller.rb` implies `web/openapi.rb` in that context | "Every web-facing slice ships web/openapi.rb" |
| `50-spec-coverage` | every `specifications[].title` appears literally as `it "…"`/`specify "…"` or a `describe "…"`/`context "…"` group under `spec/slices/<ctx>/`; duplicate titles need that many examples or one group | "named after the scenario's literal title" |
| `55-rejection-messages` | every `SPEC_ERROR` step's `title` (or `description`) appears verbatim in `app/slices/<ctx>/**` | "Rejection messages are the board's, verbatim" |
| `60-event-types` | every INTERNAL event the slice's command produces is constructed in `domain/events.rb` with `type: "<PascalCaseTitle>"` | "Event type strings are the board's titles verbatim" |
| `65-id-tags` | that constructor carries a `"<key>:#{` tag per `idAttribute: true` field (`walletId` → `"wallet:#{`) | **the tag rule** |
| `70-no-pii-tags` | no `pii: true` field's snake_case name inside any `tags: [ … ]` array in `app/slices/<ctx>/**` | "pii never becomes a tag" |
| `90-gate` (`skipIfAlreadyFailing`) | `bundle exec rspec spec/slices/<ctx>`, `bundle exec rubocop <staged .rb>`, `bundle exec packwerk check`; the first failure's last ~20 lines | the quality gate |

`90-gate` is scoped (touched context's specs, staged files only) so a commit
stays well under ~30 s; the **full** suite is still the agent's job before
committing. It runs against the working tree, like any pre-commit test run —
an unstaged edit can make it pass or fail.

**`55`–`70` parse Ruby with regexes, not a parser.** They understand the
shapes the worked example uses (`type: "…"` in a `def` chunk of `events.rb`,
literal `tags: [ "key:#{value}" ]` arrays, `it "title"`); a tag built by a
helper method is invisible to them. The rule, same as the Node stack:
**prefer not blocking over a false positive** — when a check can't tell, it
returns nothing. `60-event-types` only judges events the slice's own command
produces (via `dependencies[]`); events a state-view or automation slice
merely consumes are another slice's to construct.

## Adding a check

Create a new file here, e.g. `35-my-check.cjs`, exporting:

```js
'use strict';

module.exports = {
  name: 'my-check',            // short id, prefixed onto any violation it reports
  skipIfAlreadyFailing: false, // optional: true = skip once an earlier check found a
                               // violation (use for slow checks — no point running the
                               // suite on a commit that is already going to be rejected)
  needsSlice: false,           // optional: true = only run when ctx.slice is resolved
                               // (commit-msg phase, or a manual run that found the slice)
  run(ctx) {
    // Inspect ctx and return an array of violations. No violations → return
    // [] (or undefined/null).
    return [
      { path: 'app/slices/orders/domain/place_order.rb', reason: 'why this is a problem' },
    ];
  },
};
```

### `ctx` passed to every check

| field | type | meaning |
|---|---|---|
| `changes` | `{status, path}[]` | changed files — `status` is git's single-letter code (`A`/`M`/`D`/…); staged only with `--staged`, every uncommitted change otherwise |
| `contexts` | `Set<string>` | the context directory names the commit touches (`app/slices/<ctx>/`, `spec/slices/<ctx>/`) — never empty, the runner only loads checks when it isn't |
| `touchesSlice` | `boolean` | always `true` |
| `staged` | `boolean` | `--staged` given: `exists`/`read`/`files` look at the **index** (what the commit will contain), not the working tree |
| `repoRoot` | `string` | absolute path to this project's root (`process.cwd()`, not `git rev-parse --show-toplevel` — the app may be a subfolder of a larger repo) |
| `SLICE_PATTERN` | `RegExp` | `/^(app\|spec)\/slices\/([^/]+)\//` — group 2 is the context |
| `slice` | `object \| null` | `{ title, json, entry, contextSlug, file }` — the board slice this commit is, when resolved; `json` is the parsed `slice.json` |
| `exists(path)` | `fn → boolean` | will this path exist after the commit? |
| `read(path)` | `fn → string \| null` | its content after the commit (`null` if absent) |
| `files(prefix)` | `fn → string[]` | paths under a directory prefix after the commit |
| `addedLines(path)` | `fn → string[]` | the lines this change **adds** to a file — for judging new code only |

### Return value

An array of `{ path, reason }` objects — one per violation. `path` should be
the offending file, or a synthetic label like `'(contexts)'` when the
problem isn't one file. `reason` is a short, human-readable sentence; the
runner prefixes it with `[<check name>]`.

Return `[]`, `undefined`, or `null` when there's nothing to report. Throwing
is treated as a violation too (`[<check name>] threw: <message>`), so a check
doesn't need its own top-level try/catch.

### Conventions

- **Prefer not blocking over a false positive** when a check can't determine
  the answer confidently — these are heuristics layered on top of the hard
  path-scope rules, not a Ruby parser.
- Path-level checks that flag the *same file* are deduped by path (the first
  to run wins), so keep genuinely distinct concerns in separate files rather
  than avoiding overlap yourself. Slice-aware checks each report their own
  finding even on the same file — a missing tag and a pii tag can both sit
  in `events.rb`.
- `../util/naming.cjs` (PascalCase/snake_case/tag key),
  `../util/find-slice.cjs` (slice lookup by title) and
  `../util/slice-elements.cjs` (owned events, constructor chunks, context
  files) are shared by the existing checks — reuse them.
