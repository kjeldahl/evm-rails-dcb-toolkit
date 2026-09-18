# What we learned building

Reusable patterns and traps. Add what you find here, without repeating what's
already written. This file is read **before every slice**: it's the memory
that stops mistakes repeating across iterations.

It ships seeded with what this kit's own authors verified against the
`dcb_event_store` gem's source, the eventmodelers export schema, and a real
production-shaped Rails app built on this exact stack — facts, not guesses
about your board.

## The gem

- `DcbEventStore::Event` is a `Data` value: `type:` (string), `data:`
  (Hash, symbol keys), `tags:` (array of strings), plus auto-generated
  `id`/`causation_id`/`correlation_id`. Events read back are
  `SequencedEvent`s carrying `sequence_position` and a server-stamped
  `created_at` — a "generated timestamp" board field is usually this, free.
- `EventStore.decide(name: projection, ...)` (the app wrapper over
  `DcbEventStore::DecisionModel.build`) reads **once** across all named
  projections and returns `.states[:name]` per projection plus one
  `.append_condition` covering everything read. One `decide` call per
  command — never several sequential `project` calls when the invariants
  must be checked together, because separate reads get separate (useless)
  conditions.
- `EventStore.append(event_or_events, condition)` raises
  `DcbEventStore::ConditionNotMet` when a matching event landed after the
  read. Rescue it **in the command**, return a retry
  `Result.failure(...)` — never let it bubble to the controller.
- `EventStore.project(projection)` is the read-side shortcut: build + fold
  in one call, no condition kept.
- **Projections fold on demand at read time.** There are no materialized
  read-model rows, no registration, no `consumed_event_types` to keep in
  sync — but the flip side: a projection's `query:` (`event_types` +
  `tags`) is the *only* thing deciding what it sees, and a missing event
  type or wrong tag fails silently (state just never changes). Test the
  fold with the exact events the board's scenarios give.
- Handlers receive `(state, event)` and return the **new state** — treat
  state as immutable (`Data.define` + `#with` works well); returning `nil`
  from a handler when state is nil-guarded (`state&.with(...)`) keeps
  not-yet-created entities as `nil` instead of half-built.
- The in-memory adapter (`EVENT_STORE_ADAPTER=memory`, the spec default) is
  per-process and behaviour-equivalent for append/read/conditions. The dev
  server runs on SQLite (`storage/<env>.sqlite3`, no server to install);
  `EVENT_STORE_ADAPTER=sqlite`/`postgres` runs the same suite against a real
  SQL store.

## About `slice.json`

- **`tags: []` doesn't mean "no tags", it means "underived"** — see
  `.build-kit/CLAUDE.md`'s tag section. Most important rule in this kit.
- **`Element.context: "EXTERNAL"`** (the per-element field, not the
  slice-level bounded-context name) is the real signal for "webhook, not
  automation" — better than parsing `description` prose for who-starts
  language.
- The schema this kit was built against has **no `TRANSLATION` sliceType**
  and no `queries`/`projections` fields — only `readmodels`. Don't assume
  extra values exist on your board; route by field presence and handle
  unknown `sliceType`s defensively.
- `specifications[].given/when/then[].fields[].example` carries **literal
  example data** — use it in specs verbatim, don't invent values.
- The `Slice.status` values seen in the wild: `Created`, `Planned`,
  `InProgress`, `Review`, `Blocked`, `Done`. Handle an unrecognized status
  by logging, never by hard-failing.

## About Rails (no-AR) on this stack

- `domain/` and `web/` are Zeitwerk-**collapsed** (see
  `config/application.rb`): `app/slices/wallet/domain/deposit.rb` defines
  `Wallet::Deposit`, not `Wallet::Domain::Deposit`. Getting the constant
  path wrong is the most common first-slice error.
- Slice `views/` directories are appended to the view paths **at boot** —
  the directory must exist when the server starts (keep a `.keep` file);
  view resource directory names must be unique across slices because they
  share one lookup path. `ApplicationController.local_prefixes` strips the
  slice namespace, so `Wallet::WalletsController#show` renders
  `app/slices/wallet/views/wallets/show.html.erb` — a template under a
  `views/<context>/<resource>/` path is never found (the symptom is an
  empty 204 response, not an error).
- **Route lines need `module: :<context>`.** The controller is
  `<Context>::<Resource>Controller`; without the option Rails looks up a
  top-level `<Resource>Controller` and raises `uninitialized constant`.
- JSON requests skip forgery protection (`ApplicationController`), so the
  API is callable with plain `curl`; HTML form posts keep it.
- **The worked example survives the install cleanup** at
  `.build-kit/examples/wallet/` (`slice/` + `spec/`). When a skill names
  `app/slices/wallet/...` and the app has its own slices, that is where to
  read it.
- Ruby-keyword field names (`end`, `class`, `begin`) get a trailing
  underscore **in Ruby code only** — the event `data` key and the tag keep
  the board's name, because symbols are never keywords.
- A `generated: true` id is a defaulted keyword argument
  (`deposit_id: SecureRandom.uuid`), never an inline generator: otherwise
  the board's literal example ids can't be asserted. Same for a
  `derived:<expr>()` identifier — and an *opaque* derivation
  (`derived:code()`) is `request-feedback`, never reverse-engineered from
  the example.
- **Two tiers of rejection message.** Board-modelled rules use the
  `SPEC_ERROR` element's `title` verbatim (not `description`). Input-shape
  checks use the kit's template: `"<field> is required"`, `"<field> must be
  a positive integer"`. Don't invent a third style.
- **A rule not keyed on an `idAttribute` still needs a tag.** Equality on
  fixed fields → derive one tag from exactly those fields. Ranges, overlaps
  and counts → tag the containing scope (table, day), fold it, check the
  rule in Ruby. Untagged query + condition is the last resort and gets a
  comment saying why.
- **Times:** the board's example format is what the *spec passes in*; UTC
  ISO8601 is what the *event stores*. Parse with an explicit `strptime`
  format, never bare `Time.parse`. Never `Time.now`/`Date.today` — use
  `Time.current`; the zone is set at install and a rule needing a local
  calendar notion is `request-feedback`.
- **A slice with no read model** answers JSON `201` with the identifiers it
  established and HTML `redirect_back` — never another slice's route
  helper.
- **Screens are styled already** by the kit's classless stylesheet
  (`app/assets/stylesheets/_kit.css`): semantic elements only, no `class`
  or `style` attributes, no framework. `<output>` for the headline value,
  `<p role="alert">` / `<p role="status">` for flashes. Two forms on one
  screen need distinct input `id`s.
- Controllers parse params → call **one** command or reader → branch on
  `Result` → render/redirect. If a controller grows an `if` about domain
  state, the logic belongs in the command.
- Event `data` round-trips through JSON: symbols come back as symbols
  (`symbolize_names: true`) but `Time` doesn't — store times as
  `iso8601` strings and parse on read. Money as integer minor units.

## About tests

- **A web-facing slice is not done without a request spec.** Its three
  runtime failures — route missing `module:`, template outside the lookup
  path (renders 204, no error), JSON body shape — are all invisible to
  domain specs, which is exactly how they reached production once already.
- **A race spec must assert the command's own `Result`**, with the
  conflicting event landing inside the read → append window (wrap
  `EventStore.decide`). Appending it beforehand only exercises the business
  rule, so the retry branch goes untested.
- **Two board scenarios may share a title** — `describe "<title>"` with one
  `it` per scenario, told apart by their data. Never merge them.
- **Specs are pure and fast by default** — the in-memory store resets
  around every example (`spec/support/event_store.rb`). Arrange by
  appending the scenario's `given` events **through the context's own
  `Events` constructors**, act by calling the command / folding the
  projection, assert on `Result` + appended events / folded state.
- One example per `specifications[]` entry, described by the scenario's
  **literal title** — a board scenario and its spec stay recognizable at a
  glance. `SPEC_ERROR` scenarios assert
  `result.failure?` **and the board's exact message**.
- Test the race too, when a command carries an append condition: append a
  conflicting event *after* building the command's inputs but *before* the
  command would append — simplest is appending the conflicting event, then
  calling the command whose decision was made against older state via a
  stubbed read, **or** just assert the `ConditionNotMet → Result.failure`
  rescue path by appending the conflict between two command calls. The
  wallet worked example shows the practical pattern.
- Test the **empty/default state** of every projection — the screen sees it
  the first moment after an entity exists (or before it does): must render,
  never raise.

## About packwerk and the OpenAPI doc

- **Packwerk is the machine check for "slices never reference each other".**
  Each context directory carries a `package.yml` (copy the wallet's) — a
  directory without one is silently unguarded. The Zeitwerk collapse needs
  the load-path extension in `config/packwerk/collapsed_slice_dirs.rb`
  (required from `packwerk.yml`); **without it every slice constant is
  unresolvable and the check silently passes** — after a packwerk upgrade,
  verify the gate still trips by adding a cross-slice reference and
  watching `packwerk check` fail.
- **`lib/open_api.rb` discovers `<Context>::Openapi` modules by file glob at
  call time** — nothing to register, and no static cross-package constant
  for packwerk to flag. The flip side: a typo'd module name inside
  `web/openapi.rb` (not matching `<Context>::Openapi`) fails only when the
  document is built — `spec/lib/open_api_spec.rb` is the guard; the
  document's `$ref`s are checked there too.
- Controller JSON responses and `web/openapi.rb` are kept in sync by hand —
  when a command's fields or rejections change, both change.

## About claiming slices

- The board rejects a status change if the slice is already in the target
  status: **that's not an error**, another agent claimed it first. Don't
  retry that slice; move to the next `Planned` one in the current context.

## The screen brief

- If the slice's screen isn't a plain render/form of its own slice data,
  write `docs/screens/<slice>.md` alongside the domain code — template
  in `.build-kit/CLAUDE.md`, worked example at
  `docs/screens/EXAMPLE-wallet-balance.md`.
- **The section that earns its keep is "What the domain does NOT give
  you."** Write it even if the rest ends up short.
- Every rejection message a command can return always goes in — the screen
  translates them and can't guess them from `slice.json`.
