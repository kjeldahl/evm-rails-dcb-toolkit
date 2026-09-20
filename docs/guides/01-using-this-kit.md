# Guide 1 · Using this kit: from board to running Rails app

The workflow this kit plugs into is Martin Dilger's / Nebulit's
[Eventmodelers](https://eventmodelers.ai) platform: you design the system as
an **event model** (events, commands, read models, screens, automations,
sliced vertically), and an autonomous coding agent turns each slice into
code — here, into a Rails 8 app event-sourced on
[`dcb_event_store`](https://github.com/Kjeldahl/ruby-dcb).

## 0 · Prerequisites

- An [app.eventmodelers.ai](https://app.eventmodelers.ai) account with a
  board; API token, Organization ID and Board ID from
  `app.eventmodelers.ai/account`.
- Ruby ≥ 3.3, Rails 8, Node (for the `npx` CLI), and Claude Code (the agent
  loop drives it). No database server: the event store defaults to SQLite
  (PostgreSQL is one env var away).
- Re-installing over an earlier version? The CLI caches its clone of a
  `--git` stack in `~/.eventmodelers/git-stacks/` and does not pull — clear
  it first or you install the version you originally fetched.

## 1 · Scaffold

```bash
rails new my_app --skip-active-record --skip-action-mailbox --skip-action-text \
  --skip-active-storage --skip-test --skip-system-test
cd my_app
npx @eventmodelers/cli init --stack rails-dcb --git https://github.com/kjeldahl/evm-rails-dcb-toolkit
```

The installer prompts for your credentials, writes
`.eventmodelers/config.json` (gitignored), copies this kit's overlay
(`templates/root/` → project root, `templates/build-kit/` → `.build-kit/`,
`templates/.claude/skills/` → `.claude/skills/`), and layers in the CLI's
shared pieces (the `ralph-claude.js` agent runner and the stack-agnostic
skills: `connect`, `load-slice`, `update-slice-status`, `request-feedback`,
`learn-eventmodelers-api`).

Then follow **`INSTALL.md`** in your project root — Gemfile lines, the
slice-autoloading block for `config/application.rb`, RSpec install,
`bin/rails event_store:prepare`, routes. End state:
`bundle exec rspec && bundle exec rubocop && bundle exec packwerk check`
green, `bin/rails server` serving the wallet worked example — ERB screen,
JSON API, and the assembled OpenAPI document at `/openapi.json`.

## 2 · Model

Model on the board as usual (the platform's own tutorial:
<https://eventmodelers.ai/docs/event-modeling-tutorial/>). What this kit
reads from each slice:

- **Fields** — names, types, `idAttribute` (→ DCB tags — the single most
  important flag; see guide 2), `generated`, `optional`, `pii`.
- **Specifications** — given/when/then scenarios with literal example data
  and rejection messages. Each becomes one RSpec example, verbatim. **A
  slice without specifications gets built without behavioural guarantees —
  write them.**
- **Descriptions** — the prose invariants. The agent reads all of it.

## 3 · Build

Two ways to run the loop:

```bash
npx @eventmodelers/cli run        # realtime agent: listens for board changes
```

Mark a slice **`Planned`** on the board. The agent claims it (sets
`InProgress`), loads its `slice.json` into `.build-kit/.slices/`, routes it
to the matching skill —

| slice shape | skill |
|---|---|
| `events[]` element with `context: "EXTERNAL"` | `/build-webhook` |
| `processors[]` non-empty | `/build-automation` |
| `readmodels[]` non-empty | `/build-state-view` |
| default (`commands[]`/`events[]`) | `/build-state-change` |

— implements it (domain, specs, web layer with JSON + OpenAPI
registration, packwerk package for a new context), runs
`bundle exec rspec && bundle exec rubocop && bundle exec packwerk check`,
commits `feat: <Slice Name>`, and flips the slice to **`Done`**. A genuinely
ambiguous slice comes back as **`Blocked`** with a question posted as a
comment (`request-feedback`) — answer on the board, set it `Planned` again.

You can also drive it manually inside Claude Code: `/load-slice`, then the
matching `/build-*` skill.

## 4 · Review

- The commit-per-slice history mirrors the board — review PR-style.
- `progress.txt` is the agent's running log; `.build-kit/AGENTS.md`
  accumulates reusable learnings (worth reading and pruning occasionally).
- A slice the loop picked up repeatedly (`RALPH_MAX_PLANNED_ATTEMPTS`,
  default 2) without ever leaving `Planned` is **auto-blocked by the loop
  runner** itself (the CLI's `lib/ralph.js`, not this kit). It flips the
  slice to `Blocked` on the board but does not post a comment — the reason
  is only in `progress.txt` (`Slice auto-blocked`). A `Blocked` slice with
  no question on it is that case: read `progress.txt`, fix the cause, set
  it `Planned` again.
- Screens the agent judged non-trivial arrive as **screen briefs** under
  `docs/screens/` instead of invented UI — that's by design; build the view
  from the brief, or simplify the screen on the board.

## 5 · Day-2

- `npx @eventmodelers/cli re-init` after a CLI upgrade refreshes
  `.build-kit/` + skills without touching your app code.
- Adding specifications to an already-`Done` slice and re-marking it
  `Planned` is the supported way to evolve a slice — the JSON is the
  desired state; the agent diffs code against it.
- Events are immutable: schema evolution happens via the gem's upcaster
  (transform-on-read), not by editing history.
