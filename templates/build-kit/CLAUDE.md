# Blueprint: Rails 8 + dcb_event_store (event sourcing, SQLite/Postgres, DCB)

This is "how we build things here". Not a style guide: it's the contract that
lets an agent implement a slice without anyone having to review where each
class goes or what each thing is called.

Read `app/slices/wallet/` and `spec/slices/wallet/` before your first slice —
one worked bounded context (deposit, withdraw, balance) on top of the shared
plumbing in `lib/event_store.rb` and `lib/result.rb`. The
[`dcb_event_store`](https://github.com/Kjeldahl/ruby-dcb) gem already *is*
the read → fold → decide → append layer (`Projection`, `DecisionModel`,
`AppendCondition`, optimistic DCB concurrency) — a consuming app only ever
writes event constructors, commands, projections and plain Rails web code,
never the plumbing around them.

## File constraints

- **One slice directory per board *Context*, not per board slice.** A board
  `context` (`slice.json`'s own `"context"` field) usually contains many
  slices over its lifetime — each adds new command classes, projection
  modules, and constructor methods on that context's **single `Events`
  module**, all inside the *same* directory
  (`app/slices/<context_snake_case>/`). **Don't create a new directory per
  board slice** — splitting one context across directories duplicates its
  `Events` module and tag helpers, which then drift.
- **Slice layout** (Zeitwerk-collapsed, wired in `config/application.rb`):

  ```
  app/slices/<context>/
    domain/     # pure Ruby: commands, the Events module, projections
    web/        # controllers only
    views/<resource>/   # ERB templates for this slice's controllers
                        # (no <context>/ segment — ApplicationController
                        #  strips the namespace from the lookup prefix)
  spec/slices/<context>/   # this context's specs
  ```

  `domain/` files define `<Context>::<Class>` directly (the `domain`/`web`
  segment adds no namespace): `app/slices/wallet/domain/deposit.rb` defines
  `Wallet::Deposit`.
- **Strict path:** work inside `app/slices/<context>/`,
  `spec/slices/<context>/`, plus a route line in `config/routes.rb`. Nothing
  else, unless the skill you're running says so explicitly.
- **`domain/` is pure Ruby.** No `params`, no `session`, no route helpers,
  no view code. It may use `EventStore`, `DcbEventStore::*` value objects,
  `Result`, and stdlib (`SecureRandom`, `Time`, `BigDecimal`).
- **Slices never reference each other's classes** — not commands, not
  projections, not `Events` modules. **Events are the only cross-slice
  contract**: if you need another context's data, fold *its event types and
  tags* in your own projection, inside your own `domain/`. This rule is
  **machine-enforced by packwerk**: each slice directory is a package whose
  only dependency is the root package, so any cross-slice constant
  reference fails `bundle exec packwerk check`.
- **A new context directory gets a `package.yml`** — copy
  `app/slices/wallet/package.yml` verbatim. Packwerk silently stops
  guarding a slice that lacks one.
- **Don't touch `Gemfile`, `lib/event_store.rb`, `lib/result.rb` or
  `config/`** except the routes line each web-facing slice adds — unless a
  skill says so.

## Standards

- **Language:** Ruby ≥ 3.3, Rails 8 (`load_defaults 8.x`), **no
  ActiveRecord** — the only persistence is the append-only `events` table,
  reached exclusively through `EventStore` (`lib/event_store.rb`).
  **Store:** SQLite by default via `dcb_event_store` (PostgreSQL with
  `EVENT_STORE_ADAPTER=postgres`); specs default to the gem's in-memory
  adapter (`config/event_store.yml`). Slice code never knows which — it
  only ever talks to `EventStore`.
- **Domain names follow the board.** Event type strings are the board's
  event titles **verbatim, PascalCase past tense, no spaces**
  (`"CustomerRegistered"`); command classes are the board's command titles
  in PascalCase (`RegisterCustomer`); Ruby files/methods/keys are the
  snake_case of the same words. They're the shared vocabulary with whoever
  modelled the board — don't embellish.
- **Event `data` is a Hash with symbol keys** (the store round-trips JSON
  with `symbolize_names: true` — handlers read `event.data[:wallet_id]`).
  Values must be JSON-safe: strings, integers, floats, booleans, arrays,
  nested hashes. Times as ISO8601 strings (`time.iso8601`), money as integer
  minor units (cents) unless the board says otherwise.
- **"Verbatim" governs the input; ISO8601 governs the stored value.** The
  board's examples are written the way the modeller types them
  (`"14.03.2026 18:00"`). The spec passes that literal string into the
  command; the command parses it; the event carries
  `"2026-03-14T18:00:00Z"`; the spec asserts the *normalised* value. Parse
  in the command's input-shape section with the format spelled out —
  `Time.zone.strptime(value, "%d.%m.%Y %H:%M")`, derived from the board's
  own examples — never bare `Time.parse`, which reads `03.04.2026` as a
  different day depending on the machine. An unparseable value is an
  input-shape rejection, not an exception. **Never store a display format in
  an event, and never assert one on an event.** Examples in different
  formats across one slice's scenarios, or a time whose rule depends on a
  zone the board doesn't give, are `request-feedback`.
- **Time zone.** The app's zone is set once at install
  (`config.time_zone`, default `UTC`) and `config/` stays off-limits to you.
  So: never `Time.now` or `Date.today` — take the time as input or use
  `Time.current`; store `iso8601` in UTC; use `Time.zone.parse` for a board
  value that is local wall-clock time. **A business rule that depends on a
  local calendar notion** — a business day, a cutoff hour, "the same day", a
  month boundary — **is `request-feedback`**: the zone is a deployment fact
  the board doesn't carry, and guessing it makes the rule wrong for half the
  year in any zone with DST.
- **Tags are strings of the form `kind:value`** (`"wallet:#{wallet_id}"`).
  Normalise before tagging (e.g. emails `strip.downcase`).
- **A board field whose snake_case name is a Ruby keyword gets a trailing
  underscore — in Ruby code only.** `end` → `end_`, `class` → `class_`,
  `begin` → `begin_`, and the same for `do`, `if`, `then`, `next`, `return`,
  `self`, `nil`, `true`, `false`, `module`, `def`. The **event `data` key,
  the tag and the spec's scenario title keep the board's name verbatim**
  (`data: { end: end_ }`) — symbols are never keywords, so only parameters
  and locals need it. `def call(end:)` does parse, but the local it binds is
  then reachable only through `binding.local_variable_get(:end)`; don't.
- **Rubocop omakase** (`rubocop-rails-omakase`) — run it, don't fight it.

## Architecture rules

- **The dependency direction is always** `web → domain → EventStore`.
  Controllers contain no domain logic — no folding, no invariant checks, no
  event construction. They parse params, call one command or one projection
  reader, branch on `Result`, render.
- **All invariants live in the command's `.call`.** Input-shape checks first
  (pure, no store access — nil/blank/type/range), then one
  `EventStore.decide(...)` read folding every projection the decision needs,
  then rejections, then the append. Failed validation **never writes**.
- **Every append that depends on what was read carries the decision model's
  `append_condition`.** That is the DCB race-safety mechanism: if a matching
  event lands between read and write, `DcbEventStore::ConditionNotMet` is
  raised — rescue it and return a retry `Result.failure`. A command with no
  read-dependent invariant (pure fact recording, e.g. a deposit) appends
  without a condition, deliberately.
- **Generated identifiers are a defaulted keyword argument, never an inline
  `SecureRandom.uuid`.** A board field marked `generated: true` is minted in
  the command — `def self.call(..., deposit_id: SecureRandom.uuid)` — so a
  spec can pass the scenario's literal example (`"CONF1RM-0042"`) and assert
  on it. Hard-coding the generator inside the body makes the board's own
  example data untestable, which is the one thing specs here exist to check.
  Worked example: `Wallet::Deposit`.
- **Only a context's `Events` module constructs the events it owns, and only
  that context appends them.** One constructor method per owned event type,
  returning a `DcbEventStore::Event` with the exact type, data and tags.
- **Every read goes through a projection module**, never an ad hoc
  `EventStore.read` scattered in controllers. Projections here are **folded
  on demand at read time** — there are no materialized read-model rows and
  no registration step; a projection is just
  `DcbEventStore::Projection.new(initial_state:, handlers:, query:)` and the
  query's `event_types` + `tags` decide everything it sees.
- **Commands return `Result`** (`lib/result.rb`): `Result.success(value)` /
  `Result.failure("message")`. **Rejection messages come from two places,
  and never from your imagination:**
  - **Business-rule rejections** — anything decided from folded state, and
    anything the board models as a `SPEC_ERROR` — carry the board's message
    **verbatim**, and the spec asserts it exactly. Verbatim means the
    `SPEC_ERROR` element's **`title`**: it is the field the board always
    carries and the text on the card, where `description` is optional prose
    that drifts. Use `description` only when `title` is empty. Never merge
    the two, never reword, never append context ("…for wallet w1"). If the
    two disagree about *what* is forbidden rather than how it reads, that's
    a modelling defect — `request-feedback`, don't pick one.
  - **Input-shape rejections** — the pure checks before any store read
    (nil, blank, type, range) — are **the kit's, not the board's**; the
    board doesn't model them. Use this template verbatim so every slice
    sounds the same, with `<field>` the board's field name in snake_case:

    | check | message |
    |---|---|
    | missing / blank | `"<field> is required"` |
    | wrong type | `"<field> must be a <type>"` |
    | out of range | `"<field> must be a positive integer"` (or the board's stated range) |
    | unparseable time | `"<field> must be a date and time"` |

    A board scenario that *does* specify one of these wins over the
    template. A screen brief lists the two tiers separately — only the
    first is shared vocabulary with the modeller.

## Building a slice

**Always use the matching skill. Never implement a slice by hand.**
**Every field, event name, command name and business rule comes EXCLUSIVELY
from `slice.json`.** Don't invent anything that isn't there.

0. **Check the `slice.json` is complete before anything else.** If it has no
   `fields[]`, no `events[]`, no `specifications[]`, it's a stub written
   from the summary endpoint — reload via `load-slice` (or
   `learn-eventmodelers-api`'s slice-data call) before building anything.
1. Read `.build-kit/.slices/<context>/<slice>/slice.json`.
2. Work out the shape and call the skill. `sliceType` is `STATE_CHANGE` |
   `STATE_VIEW` | `AUTOMATION` in the schema this kit was built against —
   **don't hard-fail on a value outside that set**; fall through to the
   field-presence checks instead:
   - an `events[]` element with **`context: "EXTERNAL"`** (the *element's*
     own field, not the slice-level `context`) → `/build-webhook`
   - non-empty `processors[]` → `/build-automation`
   - non-empty `readmodels[]` → `/build-state-view`
   - default (has `commands[]`/`events[]`) → `/build-state-change`
3. Follow the whole skill. Don't deviate.
4. **Verify against `slice.json`**: every command field, every event field
   and every specification must appear in the code.
5. Quality gate: `bundle exec rspec && bundle exec rubocop && bundle exec
   packwerk check`. While iterating, this slice's own specs only:
   `bundle exec rspec spec/slices/<context>`.
6. If it passes: `git commit -m "feat: <Slice Name>"` and set status `Done`.

## The one rule `slice.json` doesn't tell you: tags come from `idAttribute: true`

`slice.json` ships `tags: []` on every element — **they aren't empty,
they're underived.** The rule is mechanical:

> Every field with `idAttribute: true` becomes a tag `"<key>:<value>"` —
> `key` the field's own name without its `Id`/`_id` suffix, snake_cased
> (`walletId` → `wallet`), `value` the field's runtime value
> (`"wallet:#{wallet_id}"`).

**Symmetry is the point.** The event constructor puts the tag on the event,
*and* every decision-model projection and read-model query that must see
that event filters on the same tag (plus the matching `event_types`). A
made-up or missing tag doesn't fail anywhere — it silently changes which
prior events a decision or a read model sees. Tags are the query keys of the
whole system; this matters more than anything else in this kit.

An element with **more than one** `idAttribute: true` field gets **more than
one tag** — the DCB pattern replacing a saga for facts that must be checked
together (`EnrollStudentInCourse` tagging both `student:` and `course:`, its
decision model folding one projection per invariant and one append condition
covering both). Don't collapse a genuinely multi-tag element onto a single
tag out of aggregate-ID habit. The gem is built for this: one event may
carry many tags and belong to many consistency boundaries at once.

If an element has no `idAttribute: true` field at all, **stop and invoke
`request-feedback`**: an untagged event can't be scoped, and a genuinely
global one is rare enough to confirm rather than assume.

### When the rule isn't keyed on an `idAttribute` at all

"No duplicate reservation for the same email, start and end" is not about
identity, but it still needs a tag — DCB has no other consistency
mechanism, and an append condition is only as narrow as the query it
carries. **Pick the coarsest tag that provably contains every event which
could violate the rule, and no coarser:**

1. **Equality on a fixed set of fields** → derive one deterministic tag from
   exactly those fields, normalised (`strip.downcase` for text, `iso8601`
   for times), on the event *and* in the decision model's query:
   `"slot:#{email}|#{starts_at.iso8601}|#{ends_at.iso8601}"`. The condition
   then serialises exactly the appends that could collide, and nothing else.
2. **Ranges, overlaps, counts, "at most N"** — no single equality tag can
   exist. Tag the **containing scope the rule is scoped to** (the table, the
   room, the day: `"table:#{table_id}"`, `"day:#{date.iso8601}"`), fold that
   scope, and check the precise rule in Ruby against the folded state. The
   tag guarantees you *saw* every candidate; the fold decides. This is the
   DCB replacement for "SELECT … then INSERT", and most non-trivial
   invariants land here.
3. **An untagged query plus an append condition is the last resort.** It is
   correct, and it is O(all events) on every command *and* serialises every
   append of those types application-wide. Only when no containing scope
   exists — and say so in a comment on the command.

Either way the derived tag is symmetric, exactly like an `idAttribute` one:
on the event and in every query that must see it.

**`request-feedback`** when the rule's scope is genuinely global ("no two
reservations anywhere may share a code") and the volume isn't obviously
small: that's a registry or a different boundary — an architecture decision,
not a slice decision.

## Generated fields — this stack has a home for them

- **A generated identifier** (`generated: true` on an id field, or the
  command's `description` saying the system assigns it): the command class
  mints it — `SecureRandom.uuid` — right before constructing the event, and
  returns it in `Result.success`. The caller never supplies it. (Unlike
  wire-direct stacks, a Rails command class *is* the impure shell, so no
  custom route is ever needed for this.)
- **A generated timestamp** (`mapping: "derived:append instant"` or similar):
  already free — the store stamps `created_at` on every appended event,
  server-side, and hands it back on read (`SequencedEvent#created_at`).
  Don't add it to `data` unless a specification actually asks a "when"
  question of the *data* (e.g. a business-meaningful occurred-at that
  differs from append time).
- `Kernel#Integer(x, exception: false)` for numeric input coercion; never
  `.to_i` (which silently turns garbage into 0).

## `pii: true` — what this stack can and can't do

The gem has **no field-level encryption-at-rest** (no `sensitive_fields`
concept). The rules:

- A `pii: true` field **never becomes a tag** — tags are indexed, plain-text
  query keys by design. Tag the subject's id, keep the pii value in `data`.
- Normalise but don't transform (emails `strip.downcase`).
- If a board marks `pii` on data whose retention/erasure looks
  compliance-sensitive (events are immutable and never deleted), **invoke
  `request-feedback`** rather than deciding data-protection policy yourself
  — crypto-shredding or claim-check patterns are modelling decisions the
  board owns.

## `aggregate`/`aggregateDependencies`/`createsAggregate` — ignored

Vestiges of classic aggregate modeling in the export schema. DCB has no
aggregate-ID concept — `idAttribute: true` is the only signal that matters
for consistency boundaries. Don't derive anything from these fields.

## JSON API and OpenAPI

Every web-facing slice serves **both** the ERB screen and a JSON API from
the same thin controller (`respond_to` — the worked example's
`wallets_controller.rb` shows the shape: success renders the relevant read
model as JSON, a `Result.failure` renders `{ error: result.error }` with
`422`).

Every slice that exposes HTTP endpoints also ships
`app/slices/<context>/web/openapi.rb` — a `<Context>::Openapi` module with
`.paths` (and optionally `.schemas` / `.webhooks`, OpenAPI 3.1 shapes as
plain hashes). `lib/open_api.rb` discovers these modules **by file path at
call time** (no registry, no boot-order coupling, no cross-package constant
reference) and serves the merged document at `GET /openapi.json`. Rules:

- Document **exactly** the routes the slice's controller serves and the
  fields its commands accept — board names, nothing invented.
- Response/request schemas mirror the read model's fields and the command's
  fields; rejection responses reference a shared error shape carrying the
  board's verbatim messages.
- Inbound webhook endpoints go under `.webhooks` (OpenAPI 3.1's top-level
  `webhooks` section), not `.paths`.
- Keep controller and `openapi.rb` in sync — the OpenAPI spec
  (`spec/lib/open_api_spec.rb`) guards document validity ($refs resolve),
  but only you guard truthfulness.
- **Success when the slice has no read model.** JSON answers `201 Created`
  with `{ "<id_field>": "<value>" }` — the identifiers the command
  established (the values behind its own tags), nothing else. Never `{}`,
  never an invented read model, never another slice's. HTML does
  `redirect_back fallback_location: root_path` with the success flash:
  that's the only redirect target a slice can name without reaching across a
  boundary — **never another slice's route helper**, which is a cross-slice
  dependency packwerk cannot see. When the slice *does* have a read model,
  the normal rule stands: `200 OK` with that model (worked example: the
  wallet balance). A board screen implying a specific landing page is a
  screen brief, not a guess.
- **Every web-facing slice ships a request spec** (`type: :request`) in
  `spec/slices/<context>/requests_spec.rb`: the HTML screen renders 200 and
  shows the read model, the JSON endpoint returns the documented body, and a
  rejected command answers 422 with the board's message. Domain specs cannot
  see the web layer at all, and each of its failure modes is quiet — a
  namespaced route without `module:` only raises at request time, and a
  template the lookup path misses renders **204 No Content**, not an error.
  Worked example: `spec/slices/wallet/requests_spec.rb`.

Worked example: `app/slices/wallet/web/openapi.rb`.

## Screens

`slice.json` carries a screen as metadata and prose (`title`, `fields`,
`dependencies`, `description`) — **not as a design.** Whatever
HTML/CSS/React prototype lives on the board never travels in the payload.

This stack renders **plain server-side ERB**, on top of a **classless
stylesheet** the kit ships (`app/assets/stylesheets/_kit.css`): every rule
targets a semantic element, so a screen built from `<h1>`, `<form>`,
`<label>`, `<output>` and `<table>` is already styled — light and dark.

**So: write semantic HTML and add nothing.** No `class` attributes, no
`style` attributes, no CSS framework, no `<div>` scaffolding. There is no
design system to learn and none to keep in sync; a screen that genuinely
needs more than the baseline needs a designer, which is what a screen brief
is for. Two conventions the stylesheet relies on:

- a read model's headline value goes in `<output>`;
- flashes are `<p role="alert">` (rejection) and `<p role="status">`
  (success).

If a screen has two forms, give each input its own `id` and a `<label
for=…>` — `form_with` would otherwise emit the same id twice.

When a slice has `screens`:

- If the screen is a straightforward render of the slice's own read model
  and/or a form for its own command (the common case), build it: a thin
  controller in `web/`, an ERB template in `views/<resource>/`, a `resources`
  line in `config/routes.rb` **carrying `module: :<context>`** (the
  controller is namespaced; without it Rails raises `uninitialized
  constant <Resource>Controller`). Semantic HTML, no JS framework, no invented
  fields — the screen shows exactly the read model's fields and posts
  exactly the command's fields.
- If the screen composes data this slice doesn't own, or the `description`
  implies interaction the model doesn't specify — **build the domain, write
  a screen brief at `docs/screens/<slice-kebab>.md`, and stop.** Worked
  example: `docs/screens/EXAMPLE-wallet-balance.md` (read it for how much
  detail is worth writing, then delete it once you have your own). Every
  rejection message the command can return goes in the brief, **split into
  the two tiers** (board-verbatim vs this app's input-shape wording) — the
  screen translates them and can't guess them, and it needs to know which
  half it may reword.

## Slice shape (what one board slice typically adds)

```
app/slices/<context>/domain/events.rb        # + one constructor method (state-change)
app/slices/<context>/domain/<command>.rb     # the command class (state-change)
app/slices/<context>/domain/<read_model>.rb  # the projection module (state-view)
app/slices/<context>/web/<resource>_controller.rb
app/slices/<context>/web/openapi.rb          # this context's OpenAPI contribution
app/slices/<context>/views/<resource>/*.erb
app/slices/<context>/package.yml             # once per context (copy wallet's)
spec/slices/<context>/<file>_spec.rb         # one example per specifications[] entry
config/routes.rb                             # one resources/route line, module: :<context>
```

**Once you have a context built, read it before the next slice in it.**
Existing code beats these templates: if they diverge, the template is stale.

**The worked example is permanent.** `app/slices/wallet/` is deleted at the
end of the install; the copy at **`.build-kit/examples/wallet/`** (`slice/`
and `spec/`) is not, and is what every reference to "the worked example" in
these skills means once the app has its own slices. It sits outside the
autoload and eager-load paths and is excluded from packwerk, so it never
boots with the app.

**Two board scenarios can share a title** (the board does not enforce
uniqueness). One `it` per scenario still holds — group them under a
`describe "<the shared title>"` and let each example's *data* tell them
apart. Never merge two scenarios into one example, and never invent a
distinguishing title the board does not have.

## Before you start

Read `.build-kit/AGENTS.md` **and `.build-kit/AGENTS.local.md`** if they
exist, to load what earlier iterations learned. The first is the kit's, and
is replaced on every install; the second is this project's, and the kit
never writes it — so anything you learn goes in the local one. And when you start a slice, invoke `update-slice-status` with
`InProgress` before anything else.

## If something is ambiguous

If `slice.json` is genuinely ambiguous, contradictory, or missing a decision
you need — **don't guess and don't build anyway**. Invoke `request-feedback`
with the specific question. Then stop.

This is an escape hatch, not a routine step: read the whole `slice.json` and
the whole skill first. Most slices are fully specified.
