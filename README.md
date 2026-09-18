# Build kit: Ruby · Rails 8 + dcb_event_store

Turns slices from an [eventmodelers.ai](https://eventmodelers.ai) board
(Martin Dilger's / Nebulit's Event Modeling tool) into a running **Rails 8**
application, event-sourced on
[`dcb_event_store`](https://github.com/Kjeldahl/ruby-dcb) — a
SQLite- or PostgreSQL-backed event store using **Dynamic Consistency
Boundaries (DCB)**: tags and append conditions instead of
aggregate-per-stream. A produced app defaults to **SQLite** — no database
server to install — and switches to PostgreSQL with one env var.

A build kit is the piece that makes the board executable: an agent picks up a
slice marked `Planned` on the board, reads its `slice.json`, implements it
with this kit's skills, runs the tests, commits, and flips the slice to
`Done`. This kit follows the official build-kit skill/installer pattern from
[nebulit-gmbh/Eventmodelers-Build-Kits](https://github.com/nebulit-gmbh/Eventmodelers-Build-Kits)
(same layout the community `skilj` and Elixir/FACT kits use), so it installs
with the standard CLI:

```bash
npx @eventmodelers/cli init --stack rails-dcb \
  --git https://github.com/kjeldahl/evm-rails-dcb-toolkit
bin/rails app:template LOCATION=https://raw.githubusercontent.com/kjeldahl/evm-rails-dcb-toolkit/main/template.rb
```

The second line is `template.rb`, a Rails application template that patches
everything `rails new` owns and the overlay therefore cannot: gems, the slice
wiring in `config/application.rb`, the two `ApplicationController` policies,
the routes, RSpec, the app name in `config/event_store.yml`. It is
idempotent, and it can also install the kit on its own via
`rails new ... -m <that URL>`. `INSTALL.md` keeps every step in longhand as
the fallback.

> **Re-installing?** The CLI caches its clone of a `--git` stack under
> `~/.eventmodelers/git-stacks/` and reuses it without pulling, so an
> unrefreshed cache installs the kit version you first fetched. Delete that
> directory (or `git pull` in it) before `init`.

New here? Start with the guides:

| Guide | What it covers |
|---|---|
| [`docs/guides/01-using-this-kit.md`](docs/guides/01-using-this-kit.md) | Model → install → run the agent loop → slices become Rails code |
| [`docs/guides/02-board-to-rails-mapping.md`](docs/guides/02-board-to-rails-mapping.md) | The board's JSON export, and exactly how each part becomes Ruby |
| [`docs/guides/03-how-this-kit-was-built.md`](docs/guides/03-how-this-kit-was-built.md) | How to build (or adapt) a build kit like this one, with the official guides it follows |

## What it installs

| | |
|---|---|
| `.claude/skills/build-*` | four skills: state-change, state-view, automation, webhook |
| `.build-kit/CLAUDE.md` | the blueprint — "how we build things here" |
| `.build-kit/AGENTS.md` | seeded lessons, read before every slice (kit-owned, replaced on every install) |
| `.build-kit/AGENTS.local.md` | this project's own accumulated notes — created once, never overwritten by the kit |
| `.build-kit/lib/*.md` | the agent-loop prompts |
| `lib/event_store.rb`, `lib/result.rb`, `config/event_store.yml`, `lib/tasks/` | the shared plumbing every slice uses |
| `lib/open_api.rb` + `app/controllers/openapi_controller.rb` | OpenAPI 3.1 document assembled from slice-local `web/openapi.rb` registrations, served at `GET /openapi.json` |
| `packwerk.yml`, `package.yml`, `config/packwerk/` | packwerk slice-boundary gate (one package per slice; cross-slice constant references fail the build) |
| `app/slices/wallet/` + `spec/slices/wallet/` | one worked bounded context (deposit, withdraw, balance, history — both read-model shapes, scalar and list; ERB screens, JSON API, OpenAPI registration, request specs) |
| `app/assets/stylesheets/_kit.css` | ~100 lines of classless baseline styling (light + dark) so generated ERB screens look presentable with no classes to learn |
| `docs/screens/` | a worked example of a screen brief |
| `.gitignore` | Rails' ignores + `config/master.key`, `storage/`, `*.sqlite3`, `node_modules/` — `rails new --skip-git` writes none |

The shared skills — `connect`, `learn-eventmodelers-api`,
`update-slice-status`, `request-feedback`, `load-slice` — come from the CLI
itself (`useShared: true` in `stack.json`).

## Before installing

Unlike a kit whose `templates/root/` is a complete runnable project, **Rails
apps are scaffolded by `rails new`, so this kit's `templates/root/` is an
overlay**: run `rails new` first (exact command and flags in
`templates/root/INSTALL.md`, which the kit drops in your project root), then
`init` copies the overlay on top. Two steps, both paste-ready.

## dcb_event_store + what, exactly

The gem already *is* the read → fold → decide → append plumbing:
`Projection` folds events into state, `DecisionModel` reads once across many
projections and hands back the `AppendCondition` that makes the write
race-free, `Store#append` enforces it. A consuming app never writes that
layer — it writes:

- an **`Events` module** per slice directory (the only constructor of the
  events that slice owns — type, data, tags),
- **command classes** (`.call(...) -> Result`) that validate, fold a decision
  model, and append with its condition,
- **projection modules** for read models, folded on demand at read time
  (`dcb_event_store` read models are *not* materialized rows — see the
  state-view skill for what that changes),
- plain Rails controllers/views in front of them.

**No ActiveRecord.** The only persistence in a produced app is the
append-only `events` table. `rails new` runs with `--skip-active-record`.

## The slice shapes

| `slice.json` has | skill |
|---|---|
| an `events[]` element with `context: "EXTERNAL"` | `build-webhook` |
| non-empty `processors[]` | `build-automation` |
| non-empty `readmodels[]` | `build-state-view` |
| default (has `commands[]`/`events[]`) | `build-state-change` |

## Decisions this kit makes explicit, not silent

1. **Tags come from `idAttribute: true`.** Every such field becomes a
   `"key:value"` tag (`leagueId` → `"league:#{league_id}"`), on the event
   *and* in every decision-model / projection query that must see it — the
   symmetry is what scopes reads correctly. `slice.json` ships `tags: []` on
   every element: **they aren't empty, they're underived.** An element with
   more than one `idAttribute` field gets more than one tag — that's the DCB
   pattern that replaces a saga, not a smell.
2. **One Rails slice directory per board *Context*, not per board slice.**
   `app/slices/<context>/` grows command by command as the board's slices in
   that context are built; splitting one context across directories would
   duplicate its `Events` module and tag helpers, which then drift. Slice
   directories never reference each other's classes — **events are the only
   cross-slice contract**, machine-enforced by packwerk (one package per
   slice; any cross-slice constant reference fails
   `bundle exec packwerk check`).
3. **Generated fields have a real home here.** Unlike stacks where nothing
   sits between the wire and `decide()`, a Rails command class *is* the
   impure shell: a `generated: true` identifier is minted in the command
   (`SecureRandom.uuid`), and a generated timestamp is already free — the
   store stamps `created_at` server-side on every appended event.
4. **`pii: true` is a flag to act on, not silently drop.** The gem has no
   field-level encryption-at-rest. The rule this kit enforces: a `pii` field
   never becomes a tag (tags are indexed and unencrypted by design), and if
   a board marks `pii` on data whose storage looks compliance-sensitive, the
   agent raises `request-feedback` instead of deciding data-protection
   policy itself.
5. **Rejection messages are the board's, verbatim.** A `SPEC_ERROR`
   scenario's message is what `Result.failure(...)` carries and what the
   spec asserts — the shared vocabulary with whoever modelled the board.
6. **`aggregate`/`aggregateDependencies`/`createsAggregate` are ignored.**
   DCB has no aggregate-ID concept; `idAttribute: true` is the only signal
   that matters for consistency boundaries.
7. **Every web-facing slice is also a JSON API, self-documented.** Thin
   controllers respond to HTML and JSON; each slice registers its endpoints
   in `web/openapi.rb`, and `lib/open_api.rb` assembles the app-wide
   OpenAPI 3.1 document (webhooks included, under the spec's `webhooks`
   section) at `GET /openapi.json` — discovered by file path, so a new
   slice needs no central registration.

## What this kit does NOT do

**Screens beyond plain ERB.** A produced app renders server-side ERB views,
styled by a small classless stylesheet (semantic elements only — no classes,
no framework, light and dark) —
the kit builds a functional screen when the slice's data makes it
unambiguous, and otherwise writes a **screen brief** at
`docs/screens/<slice>.md` (worked example:
`docs/screens/EXAMPLE-wallet-balance.md`) rather than inventing a design.
The board's screen prototypes (React/CSS) never travel in `slice.json`.

## Quality gate

```bash
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
```

Specs default to the gem's **in-memory store** (per-process, parallel-safe;
no database at all to run the suite) — `EVENT_STORE_ADAPTER=sqlite bundle
exec rspec` (or `=postgres`) runs the same suite against a real SQL store.
Every board `specifications[]` scenario becomes one spec example named after
the scenario's literal title.

## Provenance

Structure modeled file-by-file on
[`gklijs/skilj-build-kit`](https://github.com/gklijs/skilj-build-kit) (the
community DCB/Rust kit) and the official kits in
[nebulit-gmbh/Eventmodelers-Build-Kits](https://github.com/nebulit-gmbh/Eventmodelers-Build-Kits);
Rails conventions proven in a real application first (the Scorekeepr app in
[kjeldahl/Claude-experiments](https://github.com/kjeldahl/Claude-experiments),
where this kit was authored — vertical slices, no-AR Rails 8.1, the same
`EventStore`/`Result` plumbing this kit ships). See
[`docs/guides/03-how-this-kit-was-built.md`](docs/guides/03-how-this-kit-was-built.md).

MIT.
