---
name: build-state-change
description: Implements a write slice (a command validated against a decision model folded from tag-scoped events, new events appended with the model's condition) in Rails with dcb_event_store, from a slice.json
---

# Build a write slice

> Before anything else, read the definition at
> `.build-kit/.slices/{Context}/{slice}/slice.json`. That file is the
> **source of truth** for every field, event and piece of metadata. Never
> invent fields that aren't there.

> And read `.build-kit/CLAUDE.md`. It carries the tag rule, the
> generated-fields rules and the `pii` rules — all show up below.

> Read the worked example first if this is your first slice:
> `app/slices/wallet/domain/` and `spec/slices/wallet/`.

> Paths like `app/slices/wallet/...` are the worked example **while it is
> still installed**. INSTALL.md's last step deletes it; the permanent copy
> lives at `.build-kit/examples/wallet/` (`slice/` mirrors
> `app/slices/wallet/`, `spec/` mirrors `spec/slices/wallet/`). Read
> whichever is present.

---

## What a write slice is

A command that decides, against tag-scoped history, whether to append events.

```
controller (or an automation worker) → <Context>::<Command>.call(...)
    1. input-shape validation — pure, no store access; failure never writes
    2. EventStore.decide(name: projection, ...) — ONE read folding every
       projection the decision needs, returning states + append_condition
    3. rejections from the folded states (messages verbatim from the board)
    4. EventStore.append(Events.<event>(...), decision.append_condition)
       → DcbEventStore::ConditionNotMet on a concurrent conflicting write
```

The command class is the impure shell *and* the decision core in one place —
there is no separate handler/aggregate layer to write. `EventStore` and the
gem do the read/fold/append plumbing.

---

## Step 1 — Read the `slice.json`

Pull out:

- **`title`** — the slice name (for the commit message).
- **`context`** — the bounded context. Becomes (or joins)
  `app/slices/<context_snake_case>/` — **append to that directory if it
  already exists**, don't create a new one; see `.build-kit/CLAUDE.md`'s
  "one slice directory per Context" rule.
- **`commands[]`** with their `fields[]`: `name`, `type`, `cardinality`,
  `idAttribute`, `generated`, `optional`, `mapping`, `pii`.
- **`events[]`** — same, plus `dependencies[]` so you know who consumes them.
- **`specifications[]`** — the given/when/then scenarios **with example
  data**. They are the specs, almost literally.
- **Each element's `description`** — it carries the invariants written out
  in prose. It is the source of the business rules; read all of it.

> **Comments**: elements can carry comments. Use them as hints. If a comment
> raises an **open decision** rather than a hint, don't decide it yourself —
> invoke `request-feedback`.

---

## Step 2 — The events module

**File:** `app/slices/<context>/domain/events.rb` — one module per context,
**append a constructor method** if the module already exists.

```ruby
module <Context>
  module Events
    extend self

    def <event_snake_case>(field_a:, field_b:)
      DcbEventStore::Event.new(
        type: "<EventTitlePascalCase>",   # the board's event title, verbatim
        data: { field_a:, field_b: },
        tags: [ "<key>:#{field_a}" ]       # see the tag rule below
      )
    end
  end
end
```

**The data keys are the ones in `events[].fields[]`** (snake_cased),
translated by `Field.type` into JSON-safe Ruby values:

| `slice.json` `Field.type` | Ruby value in `data` |
|---|---|
| `String` | `String` |
| `Boolean` | `true`/`false` |
| `Int` / `Long` | `Integer` |
| `Double` | `Float` |
| `Decimal` | **Integer minor units (cents) by default** — event data round-trips through JSON, and a `Float` silently corrupts money. If the slice's own numbers aren't money-like (arbitrary precision, fractions of odd units), that's a real decision: `BigDecimal` serialized as a string, with parsing on every read. **Flag via `request-feedback` rather than picking silently** if the specifications do arithmetic on it. |
| `Date` | ISO8601 `String` (`date.iso8601`), parsed on read |
| `DateTime` | ISO8601 `String` (`time.iso8601`) — `Time` objects don't survive the JSON round-trip |
| `UUID` | `String` |
| `Custom` | a nested `Hash` (symbol keys) built from `subfields[]` |

`cardinality: "List"` → an `Array` of the above. `optional: true` → the key
is still present, value `nil` (keep the shape stable). `technicalAttribute:
true` → a plain data key; note in the constructor's comment that it's for
forensics/re-derivation and is never folded by any projection.

### The tags (a rule `slice.json` doesn't state)

`slice.json` ships `tags: []` on every element. **They aren't empty, they're
underived.**

> Every field with `idAttribute: true` becomes a tag `"<key>:<value>"` —
> `key` the field name without its `Id`/`_id` suffix (`walletId` →
> `wallet`), `value` the field's runtime value.

**Both sides need the tag**: the event constructor puts it on the event,
*and* Step 4's decision-model projections filter on the same tag. That
symmetry — not the field's mere presence — is what scopes the decision's
read correctly. A made-up or missing tag doesn't fail anywhere; it silently
changes which prior events a decision sees. **This matters more than
anything else in this skill.**

**An element with more than one `idAttribute: true` field needs more than
one tag** — the DCB pattern that replaces a saga for facts checked together
(an enrolment tagging both `student:` and `course:`; the decision model
folds one projection per invariant, each with its own tag filter, and the
single `append_condition` covers them all). Don't collapse a genuinely
multi-tag element onto one tag out of aggregate-ID habit.

If an element has no `idAttribute: true` field at all, **stop and invoke
`request-feedback`**: an untagged event can't be scoped, and a genuinely
global one is rare enough to confirm rather than assume.

### `pii: true`

The gem has no field-level encryption. The enforced rule: a `pii` field
**never becomes a tag** (tags are indexed plain text) — tag the subject's
id, keep the value in `data`, normalise (`strip.downcase` for emails). If
retention/erasure looks compliance-sensitive (events are never deleted),
invoke `request-feedback` — see `.build-kit/CLAUDE.md`.

---

## Step 3 — Generated fields

- **Generated identifier** (`generated: true` on an id field): the command
  mints it — `SecureRandom.uuid` — just before constructing the event, and
  returns it via `Result.success(the_id)`. It never appears in `.call`'s
  parameters.
- **Generated timestamp** (`mapping: "derived:append instant"` or similar):
  free — the store stamps `created_at` server-side on every append and
  hands it back on read (`SequencedEvent#created_at`). Don't put it in
  `data` unless a specification asks a "when" question about a *business*
  time distinct from append time.

---

## Step 4 — The command class

**File:** `app/slices/<context>/domain/<command_snake_case>.rb`

```ruby
# <one paragraph: input shape first, then what the decision model checks,
#  and what the append condition protects against — mirror the board's
#  description, don't restate the code>
module <Context>
  class <Command>
    def self.call(field_a:, field_b:)
      # 1 — input shape: pure, no store access. Integer(x, exception: false),
      #     .to_s.strip, presence — reject with the board's message.
      # 2 — ONE decision read folding every projection the invariants need:
      decision = EventStore.decide(
        thing: Thing.projection(thing_id: field_a),
        other: OtherInvariant.projection(...)
      )
      # 3 — rejections, messages verbatim from the board's scenarios:
      return Result.failure("<the board's rejection message>") if ...
      # 4 — append with the condition (invariant depended on the read):
      EventStore.append(
        Events.<event>(field_a:, field_b:),
        decision.append_condition
      )
      Result.success(field_a)
    rescue DcbEventStore::ConditionNotMet
      Result.failure("the <thing> changed while you were working — please retry")
    end
  end
end
```

Rules that are not optional:

- **One `EventStore.decide` call.** Several sequential reads get several
  separate conditions — only the last would ride the append, and the others'
  invariants would be unprotected. Fold everything the decision needs in one
  model.
- **Failed validation never writes.** Every `Result.failure` returns before
  the append.
- **Append condition iff an invariant depends on what was read.** A command
  whose only checks are input-shape (recording a pure fact — a deposit, a
  registration with no uniqueness rule) appends **without** a condition,
  deliberately — say so in the class comment. If the board's scenarios imply
  uniqueness ("already registered" rejections), that IS a read-dependent
  invariant: fold it and condition the append.
- **Rejection messages verbatim** from `specifications[]` — they're asserted
  by the specs and shown by the screens.
- **Decision projections live in their own domain files** when they fold
  another context's events (`app/slices/<context>/domain/<thing>.rb`, a
  module with `.projection(...)` and usually `.find(...)`) — this context
  folds *event types and tags*, never another slice's classes. Small
  same-context folds may live as private methods on the command.

### Idempotent caller retries

Whether a genuine caller retry (double-click, webhook redelivery) should be
a safe no-op instead of a second event is a **modelling decision** — look
for a scenario describing "the same command submitted twice". If the board
calls for it: the decision model already folds this identity's history, so
check "already happened" in the folded state and return the same
`Result.success` **without appending**. Don't add this speculatively — two
deposits are two real facts, not a retry of one.

### Thresholds get justified

A constant `slice.json` doesn't give you needs a comment saying where it
comes from and in what units. An unjustified threshold is an invented
business rule.

---

## Step 5 — Web layer (only if the slice has a screen or an actor triggers it over HTTP)

- **Controller:** `app/slices/<context>/web/<resource>_controller.rb` —
  parse params, call the command, branch on `Result`, respond to **both**
  formats: HTML redirect with the flash carrying `result.error`, and JSON
  (success renders the relevant read model; failure renders
  `{ error: result.error }` with `422`). No domain logic. Worked example:
  `app/slices/wallet/web/wallets_controller.rb`.
- **Route:** one `resources`/`post` line in `config/routes.rb`, **with
  `module: :<context>`** — the controller is namespaced
  (`<Context>::<Resource>Controller`), and without it Rails raises
  `uninitialized constant <Resource>Controller`.
- **OpenAPI:** add (or extend) `app/slices/<context>/web/openapi.rb` —
  `<Context>::Openapi.paths`/`.schemas` documenting exactly these routes,
  the command's fields as the request schema, and the rejection shape. See
  `.build-kit/CLAUDE.md`'s "JSON API and OpenAPI" section; worked example:
  `app/slices/wallet/web/openapi.rb`.
- **View:** per `.build-kit/CLAUDE.md`'s "Screens" section — a plain form
  posting exactly the command's fields, or a screen brief at
  `docs/screens/<slice>.md` when the screen isn't a plain render/form.
- **Request spec:** `spec/slices/<context>/requests_spec.rb` (`type:
  :request`) — the JSON endpoint returns the documented body, a rejected
  command answers 422 with the board's message, the HTML post redirects and
  carries the rejection as a flash. The domain specs below cannot see any of
  this, and both failure modes are quiet (a route missing `module:` raises
  only at request time; a template the lookup misses renders 204). Worked
  example: `spec/slices/wallet/requests_spec.rb`.
- **Package:** if this slice created the context directory, copy
  `app/slices/wallet/package.yml` into it — packwerk silently stops
  guarding a slice without one.

---

## Step 6 — Specs

**File:** `spec/slices/<context>/<command_snake_case>_spec.rb`

**One example per `specifications[]` entry, described by the scenario's
literal title** — a board scenario and its spec stay recognizable at a
glance. **The data comes from
`specifications[].given/when/then[].fields[].example`, literally** — don't
invent values.

```ruby
RSpec.describe <Context>::<Command> do
  it "<the scenario's literal title>" do
    # given — append the scenario's events through the context's own
    # Events constructors (the same shapes production writes):
    EventStore.append(<Context>::Events.<given_event>(...))

    # when
    result = described_class.call(<the scenario's example data, literally>)

    # then — a SPEC_ERROR scenario asserts failure? AND the exact message:
    expect(result.failure?).to be(true)
    expect(result.error).to eq("<the board's message, verbatim>")
    # and that nothing was written; a success scenario asserts the appended
    # event's type, data and tags instead.
  end
end
```

Beyond the board's scenarios, always add:

- **A tag-scoping spec**: events for a *different* id must not influence
  this command's decision (append them in `given`, assert the decision
  ignores them). This is the test that catches a wrong tag key — the
  board's own scenarios usually can't, because they only ever use one id.
- **A race spec** when the command carries an append condition. Land the
  conflicting event **inside the command's own read → append window** by
  wrapping the read, then assert the *command's* `Result`:

  ```ruby
  allow(EventStore).to receive(:decide).and_wrap_original do |read, *args, **projections|
    decision = read.call(*args, **projections)
    EventStore.append(<Context>::Events.<conflicting>(...))
    decision
  end

  expect(described_class.call(...).error).to eq("… please retry")
  ```

  Appending the conflicting event *before* the call proves nothing: the
  command simply reads the newer state and the **business rule** rejects it,
  so the `rescue ConditionNotMet` branch — and the retry message — is never
  reached. Asserting only that `EventStore.append` raises tests the gem, not
  your command. Worked example: `spec/slices/wallet/withdraw_spec.rb`.

Specs run on the in-memory store, reset around every example — no database
server, no mocking of `EventStore`.

---

## Step 7 — Quality gate

```
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bundle exec rspec spec/slices/<context_snake_case>   # this slice only, while iterating
```

Never commit red.

---

## Final check against `slice.json`

- [ ] Every field in `commands[].fields[]` is a `.call` parameter (except
      `generated: true` ids, minted inside — Step 3).
- [ ] Every field in `events[].fields[]` is in the event constructor's
      `data`.
- [ ] No invented fields — a generated timestamp isn't a field at all.
- [ ] Every `idAttribute: true` produces its tag, symmetric on the event
      constructor and every decision-model query.
- [ ] No `pii: true` field appears in any tag.
- [ ] Every `specifications[]` entry has its own spec, named after its
      literal title, with the board's example data and messages verbatim.
- [ ] There's a tag-scoping spec (other ids don't leak in) and — when the
      append is conditioned — a race spec.
- [ ] Exactly one `EventStore.decide` call; failed validation never writes;
      `ConditionNotMet` is rescued into a retry `Result.failure`.
- [ ] Only this context's `Events` module constructs its events; no other
      slice's classes are referenced anywhere (packwerk green proves it —
      and the context directory has its `package.yml`).
- [ ] If the slice has web endpoints: `web/openapi.rb` documents them —
      routes, request fields, rejection shape — and matches the controller.
- [ ] If the slice has `screens` and it wasn't a plain render/form: the
      **screen brief** exists at `docs/screens/<slice>.md`, listing every
      rejection message.
