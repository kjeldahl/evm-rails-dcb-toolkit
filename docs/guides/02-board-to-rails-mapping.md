# Guide 2 · The board's JSON, and exactly how it becomes Ruby

Everything the agent builds comes from the board's export. This guide is
the reference for that translation — the same rules the `build-*` skills
enforce, collected in one place.

## The export shape

`/load-slice` (or `npx @eventmodelers/cli fetch --context <name>`) writes
`.build-kit/.slices/<context>/<slice>/slice.json`. The shape that matters:

```jsonc
{
  "title": "slice: Register Customer",
  "context": "Cool Customer demo",        // the bounded context
  "sliceType": "STATE_CHANGE",            // STATE_CHANGE | STATE_VIEW | AUTOMATION
  "commands":   [ { "title": "Register Customer", "fields": [...], "dependencies": [...] } ],
  "events":     [ { "title": "Customer registered", "context": "INTERNAL", "fields": [...] } ],
  "readmodels": [ { "title": "customers", "listElement": true, "fields": [...] } ],
  "screens":    [ { "title": "screen", "fields": [...] } ],
  "processors": [ ],
  "specifications": [ ]
}
```

Each element's `fields[]` entries look like
`{ "name": "email", "type": "String", "cardinality": "Single",
"idAttribute": false }`, optionally with `generated`, `optional`, `pii`,
`mapping`, `technicalAttribute`, `subfields`.

Routing is by **field presence**, not `sliceType` alone (unknown values are
handled defensively): an `events[]` element with its own
`context: "EXTERNAL"` → webhook; `processors[]` non-empty → automation;
`readmodels[]` non-empty → state-view; otherwise state-change.

## What each element becomes

| board | Ruby | file |
|---|---|---|
| Context | slice directory + namespace `<Context>` | `app/slices/<context>/` |
| Event | a constructor method on the context's single `Events` module, returning `DcbEventStore::Event` | `domain/events.rb` |
| Command | a class with `.call(**kwargs) -> Result` | `domain/<command>.rb` |
| Read model | a module with `.projection(...)` / `.find(...)` folding on demand | `domain/<read_model>.rb` |
| Processor | a module with `.run_once` polled by `bin/automation` | `domain/<processor>.rb` |
| Screen | thin controller (HTML **and** JSON) + ERB view + route — or a screen brief in `docs/screens/` | `web/`, `views/` |
| HTTP surface | slice-local OpenAPI registration (`<Context>::Openapi.paths`/`.schemas`; webhooks under `.webhooks`), assembled app-wide at `GET /openapi.json` | `web/openapi.rb` |
| Specification | one RSpec example, named after the scenario's literal title | `spec/slices/<context>/` |

Names follow the board verbatim: event **type strings** are the board's
event titles in PascalCase past tense (`"CustomerRegistered"`); classes are
the command titles in PascalCase; files/keys are the snake_case of the same
words. Rejection messages in commands are the board's scenario messages,
character for character — the specs assert them and the screens display
them.

## `idAttribute: true` → DCB tags (the rule the export doesn't state)

The export ships `tags: []` on every element — **underived, not empty**.
The mechanical rule:

> Every field with `idAttribute: true` becomes a tag `"<key>:<value>"`,
> where `key` is the field name minus its `Id`/`_id` suffix
> (`walletId` → `wallet`) and `value` is the runtime value.

The tag appears in **two places, symmetrically**:

1. on the event, in its `Events` constructor
   (`tags: ["wallet:#{wallet_id}"]`), and
2. in every `DcbEventStore::QueryItem` that must see that event — a
   command's decision-model projections and every read model's query.

That symmetry is the consistency mechanism of the whole system. There is no
aggregate ID and no per-entity stream: what a decision "sees" is exactly
the tag-scoped set, and the `AppendCondition` built from that same query is
what makes the write race-free. A wrong tag key fails nowhere loudly — it
silently changes what decisions and views see — which is why the skills
mandate a tag-scoping spec ("another id's events don't leak in") on every
slice.

**Multiple `idAttribute` fields → multiple tags.** That's DCB's replacement
for sagas: a command whose invariants span two entities (enrolment checking
both student and course) tags both, folds one projection per invariant, and
one append condition covers everything read. One event can belong to many
consistency boundaries at once.

**No `idAttribute` at all → stop and ask** (`request-feedback`): untagged
events can't be scoped.

## Field-type translation

| `Field.type` | in event `data` / command args |
|---|---|
| `String` | `String` |
| `Boolean` | `true`/`false` |
| `Int` / `Long` | `Integer` |
| `Double` | `Float` |
| `Decimal` | integer minor units (cents) by default; `BigDecimal`-as-string only as a flagged decision — never `Float` for money |
| `Date` / `DateTime` | ISO8601 `String` (`.iso8601`) — `Time` doesn't survive the JSON round-trip; parse on read |
| `UUID` | `String` |
| `Custom` + `subfields` | nested `Hash` with symbol keys |
| `cardinality: "List"` | `Array` of the above |

Event `data` is symbol-keyed and must stay JSON-safe — the store
round-trips it with `symbolize_names: true`.

Flags:

- `generated: true` on an id → minted in the command
  (`SecureRandom.uuid`), returned via `Result.success`; never a `.call`
  parameter. A generated *timestamp* is free — the store stamps
  `created_at` on every append.
- `optional: true` → key present, `nil` value (stable shape).
- `pii: true` → never in a tag (tags are indexed plain text); normalise;
  escalate compliance-sensitive cases (`request-feedback`) — the gem has
  no field-level encryption and events are never deleted.
- `technicalAttribute: true` → plain data key, forensics only, never
  folded by any read model.
- `aggregate` / `aggregateDependencies` / `createsAggregate` → **ignored**;
  DCB has no aggregate concept.

## Specifications → specs

`specifications[].given/when/then[].fields[].example` carries literal
example data. Each scenario becomes:

```ruby
it "<the scenario's literal title>" do
  # given: append the scenario's events via the context's Events constructors
  # when:  call the command / fold the projection with the literal examples
  # then:  Result + appended events, or the folded state
end
```

`SPEC_ERROR` scenarios assert `failure?` **and the exact message**. Beyond
the board's scenarios the skills always add: empty/default-state (views),
tag-scoping (everything), and a `ConditionNotMet` race spec (conditioned
commands).

## The one structural divergence from the board: contexts, not slices

The board organises by slice; the codebase organises by **context**
(`app/slices/<context>/` grows slice by slice). One `Events` module per
context, one directory, one namespace — splitting a context across
directories would duplicate its event constructors and tag conventions,
which then drift. The board slice survives as: the commit
(`feat: <Slice Name>`), the spec file, and the file-per-command/read-model
granularity inside the context directory.

Cross-context reads never touch another slice directory's classes — they
fold the other context's **event types and tags** in their own `domain/`.
Events are the only contract between slices; that's what keeps the model
on the board and the code structurally honest with each other. **Packwerk
enforces it mechanically**: every context directory is a package
(`package.yml`) depending only on the root package, so a cross-slice
constant reference fails `bundle exec packwerk check` — part of the
standard gate.
