---
name: build-state-view
description: Implements a read slice (a read model folded on demand from tag-scoped events via a DcbEventStore::Projection) in Rails with dcb_event_store, from a slice.json
---

# Build a read slice

> Before anything else, read the definition at
> `.build-kit/.slices/{Context}/{slice}/slice.json`. Never invent fields
> that aren't there.

> And read `.build-kit/CLAUDE.md`, especially the tag rule — it applies
> here as the projection query's `tags:` filter.

> Worked examples — **read the one matching your read model's shape**:
> a scalar, `app/slices/wallet/domain/balance.rb` +
> `spec/slices/wallet/balance_spec.rb`; a **list**,
> `app/slices/wallet/domain/history.rb` +
> `spec/slices/wallet/history_spec.rb`, with its table screen at
> `views/wallets/history.html.erb`. The only difference between them is what
> the fold accumulates.

> Paths like `app/slices/wallet/...` are the worked example **while it is
> still installed**. INSTALL.md's last step deletes it; the permanent copy
> lives at `.build-kit/examples/wallet/` (`slice/` mirrors
> `app/slices/wallet/`, `spec/` mirrors `spec/slices/wallet/`). Read
> whichever is present.

---

## What a read slice is

A projection module — folded **on demand, at read time**. Unlike stacks
whose read models are materialized rows updated as events arrive,
`dcb_event_store` has no registration step and no stored state: a read
model is `DcbEventStore::Projection.new(initial_state:, handlers:, query:)`
and the query's `event_types` + `tags` are the *only* thing deciding what
it sees.

```
controller → <Context>::<ReadModel>.find(...)
               → EventStore.project(projection(...))
                   → one store read of the query's matching events
                   → handlers fold them, in order, into the state
```

What that changes compared to materialized stacks:

- **Nothing can go stale** — every read folds current history; reads are
  read-your-writes by construction. There is no sync-vs-background choice
  to make.
- **Nothing warns you about a missing event type** — a type absent from the
  query just never reaches a handler and the field silently stays at its
  initial value. The specs are the only guard (Step 4).
- **Cost is per read.** For the entity-scoped folds this skill produces
  (one tag, a handful of event types) that's the right trade. A genuinely
  unbounded fold (an all-time, all-entities report) is a modelling
  conversation — flag via `request-feedback` rather than folding the world
  on every page view.

---

## Step 1 — Read the `slice.json`

- **`readmodels[]`** and their `fields[]`. Look at:
  - `mapping: "<Event>.<field>"` → **direct copy** inside that event's
    handler.
  - `mapping: "derived:…"` → **computed** — inside the handler when one
    event alone determines it, or as a method on the state value when it
    combines several stored fields.
  - `optional: true` → the event that carries it may not have folded yet —
    model as `nil` in the initial/intermediate state, never a sentinel.
  - `generated: true` → derived, comes from no event — same rule as
    `derived:`. (A "when did this happen" field is usually the store's own
    `created_at` on the read-back `SequencedEvent` — fold it from the
    event, don't invent a clock.)
  - `cardinality: "List"` with `subfields[]` → an `Array` of small `Data`
    values in the state.
- **`listElement: true`** on the read model → the state is a collection
  (see "Shape of the state" below).
- **`dependencies[]` with `type: "INBOUND"`** name the event types this
  model folds — cross-check against every field's `mapping:`.
- **`specifications[]`** — `given` are events (in board order),
  `then`/examples is the expected folded state.
- **The read model's `description`** — says what's computed vs. copied, and
  usually why. Read all of it.

---

## Step 2 — The projection module

**File:** `app/slices/<context>/domain/<read_model_snake_case>.rb` —
append to the existing context directory.

```ruby
# <what this view answers, and which events — possibly another context's —
#  it folds; note anything computed rather than copied>
module <Context>
  module <ReadModel>
    Summary = Data.define(:field_a, :field_b) do
      # derived-on-read fields become methods here, not stored state
    end

    extend self

    def find(<id_field>:)
      EventStore.project(projection(<id_field>:))
    end

    def projection(<id_field>:)
      DcbEventStore::Projection.new(
        initial_state: nil,   # or 0, [], {} — whatever "nothing yet" renders as
        handlers: {
          "<EventA>" => ->(_state, event) { Summary.new(field_a: event.data.fetch(:field_a), field_b: nil) },
          "<EventB>" => ->(state, event) { state&.with(field_b: event.data.fetch(:field_b)) }
        },
        query: DcbEventStore::Query.new(
          DcbEventStore::QueryItem.new(
            event_types: %w[<EventA> <EventB>],
            tags: [ "<key>:#{<id_field>}" ]
          )
        )
      )
    end
  end
end
```

### The query lists every event type any `mapping:` references

Derive `event_types` from the `mapping:` values and the INBOUND
dependencies. **A type missing here is the expensive failure**: the field
stays at its initial value forever and nothing errors. Step 4's specs are
the only thing that catches it.

### The `tags:` filter is the read-side half of the tag rule

The read model's `idAttribute: true` field names the tag
(`"<key>:#{value}"`), matching what the events' constructors put on. If
this view folds **another context's events**, the contract is those events'
*types and tags* — never the other slice's classes; write the fold here, in
this context's own `domain/`.

**A cross-entity list** (all X for account Y) filters on the broader tag
(`"account:#{account_id}"`) that the events already carry — check the
event's own tag list on the board; if the events don't carry the tag the
list needs, that's a board conversation (`request-feedback`), not a
fold-everything-and-filter-in-Ruby workaround.

### Shape of the state

- Entity view → a `Data` value (or `nil` until its creating event folds).
- List view (`listElement: true`) → a `Hash` keyed by id folded into
  `Array` on return, or an `Array` if order is append order.
- **Handlers return the new state, never mutate shared structures in
  place**; `state&.with(...)` keeps not-yet-created entities `nil` instead
  of half-built.
- **Derived, never stored redundantly**: "status = presence of `<Event>`"
  is set in that event's handler, not copied from data.

---

## Step 2b — What this read model costs

Folding at read time means **every read replays every event the query
matches**, on every request. The query is the only lever:

- **A tag-scoped query is bounded by one entity's history** (`"wallet:w1"` —
  a few hundred events) and is the default. Fine forever, list or scalar:
  `Wallet::History` folds a whole ledger this way.
- **An untagged query replays the whole log** ("all reservations", "all
  tables"): it is O(total events) per request and gets slower every day the
  app runs. Acceptable for a list the board says is small and for admin
  screens; not for anything on a hot path.
- The gem has **no snapshotting and no materialized read models**. There is
  nothing to configure your way out of this.

So: if the read model the board asks for is untagged *and* its query has no
natural bound, **don't quietly ship an O(all events) projection**. Build it,
say so plainly in the slice's `docs/screens/` brief or the spec's comment,
and raise `request-feedback` when the board implies it must stay fast —
choosing a caching or materialisation strategy is an architecture decision,
not a slice decision. If a bound *is* available (a period, a status, a
parent id that is itself an `idAttribute`), put it in the query as a tag
rather than filtering in Ruby after the fold: a filter in the handler still
reads every event.

## Rows are value objects

A list read model accumulates **rows, not hashes**:

```ruby
Entry = Data.define(:kind, :amount_cents, :balance_cents, :at)
```

A `Data.define` row makes a mistyped key a `NoMethodError` where the mistake
is, instead of a `nil` that reaches the screen and renders as blank. Keep the
fold immutable (`rows + [ entry ]`), and prefer a **signed** number over a
kind-plus-magnitude pair when the screen will sum it — `Wallet::History`
stores a withdrawal as a negative `amount_cents`, so the running balance is
a plain sum and neither the fold nor the view needs a branch.

Three things a list fold can get wrong that a scalar can't, so test all
three: **order**, the **running total**, and the **empty case**.

## Step 3 — Web layer

Read slices almost always have a screen. Per `.build-kit/CLAUDE.md`:

- A plain render of this model's fields → build it: thin controller in
  `web/` calling `.find(...)`, ERB in `views/<resource>/`, a route line
  (with `module: :<context>` — the controller is namespaced), a **request
  spec** (`spec/slices/<context>/requests_spec.rb`, `type: :request`: the
  screen renders 200 and shows the model, the JSON endpoint returns the
  documented body — nothing else catches a wrong route or a missed template,
  which renders 204),
  **and a JSON response** (`respond_to`, rendering the model's fields —
  worked example: `wallets_controller.rb#show`). **Render the
  empty/initial state meaningfully** — the screen sees it the first moment
  after (or before) the entity exists; never a 500.
- **OpenAPI:** add (or extend) `app/slices/<context>/web/openapi.rb` — a
  `get` path for the reader, its response schema mirroring the read
  model's fields exactly. See `.build-kit/CLAUDE.md`'s "JSON API and
  OpenAPI" section.
- If this slice created the context directory, copy
  `app/slices/wallet/package.yml` into it (packwerk guard).
- Anything more than a plain render → build the domain, write the screen
  brief at `docs/screens/<slice>.md`, stop.

---

## Step 4 — Specs

**File:** `spec/slices/<context>/<read_model_snake_case>_spec.rb`

One example per `specifications[]` entry, named after its literal title,
with the board's literal example data. Arrange by appending the `given`
events **through their own `Events` constructors** (same-context) or as
`DcbEventStore::Event.new` with the cataloged type/data/tags (another
context's events — this spec is then also the written record of the
cross-slice contract).

Always add, beyond the board's scenarios:

- **The empty/default state** — no events folded must return something the
  screen can render (`nil`/`0`/`[]`), never raise.
- **Tag scoping** — events for another id/tenant must not leak into this
  fold (the spec that catches a wrong tag key).
- **Coverage of the query's `event_types`** — a scenario folding *every*
  type the model consumes; this is what catches the
  silently-missing-event-type failure this stack can't catch anywhere else.
- **Order sensitivity** where the board's flows don't guarantee arrival
  order: two orderings must fold to the same state, or the difference is a
  real modelling question for `request-feedback`.

---

## Step 5 — Quality gate

```
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bundle exec rspec spec/slices/<context_snake_case>
```

---

## Final check against `slice.json`

- [ ] Every field in `readmodels[].fields[]` exists in the state or is a
      method on it (derived-on-read).
- [ ] The query's `event_types` name **every** event any `mapping:`/INBOUND
      dependency references — and a spec folds all of them.
- [ ] The `tags:` filter matches the read model's `idAttribute` field, and
      the events actually carry that tag on the board.
- [ ] `derived:`/`generated: true` fields are computed, never stored
      redundantly.
- [ ] Every `specifications[]` entry has its own spec; plus empty-state and
      tag-scoping specs.
- [ ] No other slice's classes referenced — cross-context data is folded
      from event types and tags here (packwerk green proves it — and the
      context directory has its `package.yml`).
- [ ] The reader's route is documented in `web/openapi.rb`, response schema
      matching the read model's fields.
- [ ] The screen renders the empty state, or the screen brief exists at
      `docs/screens/<slice>.md`.
