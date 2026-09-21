# Guide 3 · How this kit was built — and how to build or adapt one

A build kit is not magic: it's a documented, conventional layout the
Eventmodelers CLI knows how to install, plus prompts and skills teaching an
agent one stack's idioms. This guide records the official path this kit
followed, so you can maintain it, or build the next one.

## The official guides this kit follows

1. **The build-kit pattern itself** —
   [nebulit-gmbh/Eventmodelers-Build-Kits](https://github.com/nebulit-gmbh/Eventmodelers-Build-Kits):
   the CLI (`@eventmodelers/cli`), the official stacks (node, supabase,
   axon, cratis-csharp, opencqrs, umadb, kurrent), and — in
   `eventmodelers-cli/README.md` — the two sections that matter for kit
   authors:
   - *"Building a new kit for an unsupported stack"*:
     `npx @eventmodelers/cli init --build-kit` scaffolds
     `.build-kit/CLAUDE.md`, `lib/prompt.md`, `lib/backend-prompt.md` and
     the `build-*` skills as TODO placeholders to fill in against a real
     project.
   - *"Adding a stack"*: the `stacks/<name>/templates/` layout
     (`.claude/` skills, `root/` project scaffold, `build-kit/` agent kit),
     with everything stack-agnostic layered in from `shared/` — which is
     why this kit ships **no** runner scripts and no `connect`/`load-slice`
     skills of its own (`useShared: true`).
2. **Community-kit installation** — `init --stack <name> --git <url>`
   installs a repo mirroring that layout, optionally with a `stack.json`
   declaring `label`/`kitSubdir`/`useShared`/`needsBoardId`. That's this
   repo's shape.
3. **The code-generator course** — the 10-day "Build Your Own Code
   Generator" series at <https://eventmodelers.ai/docs/code-generator/>
   (mirrored at eventmodelers.de). Day 3 documents the exported JSON
   structure this kit's guide 2 maps to Ruby.
4. **The method itself** — Martin Dilger, *Understanding Eventsourcing*
   (the pattern catalogue behind the slice shapes), and
   <https://eventmodeling.org>.

## The precedents it's modeled on

- [`gklijs/skilj-build-kit`](https://github.com/gklijs/skilj-build-kit)
  (Rust · skilj) — the community kit closest in spirit: also
  SQL-backed, also **DCB instead of classic aggregates**, and the
  file-by-file structural reference for this kit (README shape, blueprint
  CLAUDE.md, seeded AGENTS.md, screen briefs, the
  "decisions made explicit, not silent" discipline).
- `ortegacmanuel/eventmodelers-elixir-fact-kit` — the precedent for a
  framework needing its own scaffold step first (`mix phx.new` there,
  `rails new` here), hence the overlay-plus-INSTALL.md approach.

## What was verified against real sources (not assumed)

- **The gem's API**, from
  [Kjeldahl/ruby-dcb](https://github.com/Kjeldahl/ruby-dcb) directly:
  `Event`/`Query`/`QueryItem`/`Projection`/`DecisionModel`/
  `AppendCondition`/`ConditionNotMet`, the in-memory adapter, the
  server-stamped `created_at` on read-back `SequencedEvent`s, and the
  `symbolize_names: true` JSON round-trip.
- **The export schema**, from a real board export: `readmodels` (not
  `queries`/`projections`), per-element `context: "EXTERNAL"` as the
  webhook signal, `tags: []` always shipped underived, the
  `aggregate*` vestige fields.
- **The Rails conventions**, from a production-shaped Rails 8.1 app built
  on this exact stack first (Scorekeepr, in the repository this kit was
  authored in): the no-ActiveRecord setup, the Zeitwerk-collapsed
  `app/slices/<context>/{domain,web,views}` layout, the
  `EventStore`/`Result` plumbing shipped in `templates/root/lib/`, the
  thin-controller rule, the events-are-the-only-cross-slice-contract
  discipline **and its packwerk enforcement** (one package per slice, the
  collapsed-dirs load-path extension included — without it packwerk
  silently checks nothing).

The order matters: **conventions were proven in a real app before being
written into skills.** A kit whose skills describe an imagined stack
produces confidently wrong code at scale — every rule in
`templates/build-kit/CLAUDE.md` traces to working code or gem source.

## Anatomy recap

```
stack.json                       # label, kitSubdir, useShared, needsBoardId
templates/
  build-kit/                     # → .build-kit/ in the target project
    CLAUDE.md                    #   the blueprint: "how we build things here"
    AGENTS.md                    #   seeded, verified learnings; grows in use
    lib/prompt.md                #   realtime-loop prompt (task queue)
    lib/backend-prompt.md        #   ralph-loop prompt (+ stack-specific tail)
    lib/check-commit-scope.cjs   #   the commit guard's runner (Node, zero deps)
    lib/checks/*.cjs             #   one rule per file; README.md = the contract
    lib/util/                    #   slice lookup by title, naming, slice.json helpers
  root/                          # → project root (overlay onto `rails new`)
    .githooks/                   #   pre-commit + commit-msg → the guard; `init --hooks` only
    INSTALL.md                   #   the manual steps the CLI can't do
    lib/event_store.rb, lib/result.rb, config/event_store.yml, ...
    lib/open_api.rb, app/controllers/openapi_controller.rb   # OpenAPI assembly
    packwerk.yml, package.yml, config/packwerk/              # boundary gate
    app/slices/wallet/, spec/slices/wallet/   # the worked example
    docs/screens/EXAMPLE-*.md    #   worked screen brief
  .claude/skills/build-*/        # → .claude/skills/ — the four slice shapes
```

Shared pieces (runner scripts, `connect`/`load-slice`/
`update-slice-status`/`request-feedback`/`learn-eventmodelers-api`) come
from the CLI at install time — never copy them into a kit; they'd go stale.

## The commit guard

The kit's rules in `CLAUDE.md` were prose until issue #9: nothing stopped an
unattended agent from committing a slice that broke them and marking it
`Done`. The guard is the Node stack's `--hooks` mechanism (the CLI copies
`templates/root/.githooks/`, chmods `pre-commit`, sets `core.hooksPath`)
with this kit's rules as the checks. Two things differ from the Node stack,
both forced by the layout: the slice pattern is per *context*
(`app/slices/<ctx>/`), so the runner exposes `ctx.contexts`; and because a
context directory holds many board slices, `pre-commit` can't tell which
slice is being committed — the `commit-msg` hook reads it from
`feat: <Slice Name>` and runs the slice-aware checks (scenario coverage,
verbatim messages, event types, tags) against that `slice.json`. Every
check is a fixture test in `test/`, and CI scaffolds a real app to run
`git commit` through the hooks with the real gate behind them.

## Adapting this kit

- **Different Rails house style** (different test framework, packwerk,
  ActionCable live views, stricter gates like mutation testing): edit
  `templates/build-kit/CLAUDE.md` (the contract), the `build-*` skills
  (the how-to), and the quality-gate lines in both `lib/*.md` prompts —
  keep the three in agreement, that's the whole maintenance burden.
- **Gem API changes**: re-verify `templates/root/lib/event_store.rb` and
  the wallet example against the gem, then re-check every skill's code
  sketches. The worked example is the canary — if it stops compiling
  against a new gem version, the skills are stale too.
- **Export-schema changes**: the routing rules live in three places by
  design (CLAUDE.md "Building a slice", `lib/prompt.md` step 3,
  `lib/backend-prompt.md`) — update all three.
- **Provenance of this repository**: the kit was authored as the
  `evm-rails-dcb-buildkit/` folder of
  [kjeldahl/Claude-experiments](https://github.com/kjeldahl/Claude-experiments)
  (alongside the Scorekeepr app its conventions were proven in) and
  extracted here; the authoring history lives there. The repo name says
  "toolkit" (a typo at creation), the content says **build kit** — the
  platform's term; the install command is unaffected.
- **Promoting to a first-class stack**: follow "Adding a stack" in the
  Eventmodelers-Build-Kits README — copy `templates/` into
  `stacks/rails-dcb/templates/`, add the `STACKS` entry in `cli.js`, PR.

## Testing a kit

The only real test is a real board: model a small context (the wallet
example is exactly that shape), mark slices `Planned`, and watch the loop
build them. When the agent stumbles, the fix goes in this order —
`AGENTS.md` (a learning), the skill (a rule), `CLAUDE.md` (the contract) —
and the stumble becomes a seeded lesson for every future project, which is
what `templates/build-kit/AGENTS.md` shipping non-empty is about.
