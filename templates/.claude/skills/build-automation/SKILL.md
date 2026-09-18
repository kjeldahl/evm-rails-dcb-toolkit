---
name: build-automation
description: Implements an automation slice (a background processor that watches a TODO-queue projection, calls an external system, and records the result as our own event) in Rails with dcb_event_store, from a slice.json
---

# Build an automation slice

> Paths like `app/slices/wallet/...` are the worked example **while it is
> still installed**. INSTALL.md's last step deletes it; the permanent copy
> lives at `.build-kit/examples/wallet/` (`slice/` mirrors
> `app/slices/wallet/`, `spec/` mirrors `spec/slices/wallet/`). Read
> whichever is present.

> Before anything else, read the definition at
> `.build-kit/.slices/{Context}/{slice}/slice.json`. Never invent fields
> that aren't there.

> And read `.build-kit/CLAUDE.md`. This slice shape deviates most from what
> the board appears to say, so its tag rule matters double here.

---

## What an automation slice is

Nobody clicks anything. A background processor folds a **TODO queue** — a
projection, not a table — does the work, and **writes a fact of our own**
through an ordinary command.

```
TODO-queue projection ("asked minus resolved", per /build-state-view)
  → a processor loop (bin/automation, one process per app)
      → external call
      → <Context>::<Command>.call(...)  → event (append condition and all)
```

Build the TODO queue's read model with `/build-state-view` and the command
it ends up calling with `/build-state-change` **first** — this skill only
covers the processor connecting them.

---

## Step 1 — The TODO queue exists and you don't build it here

`processors[].dependencies` points at a `READMODEL` that is the queue —
usually its own slice on the board.

**If that slice isn't built, stop.** Build it first with
`/build-state-view`, or invoke `request-feedback` if it isn't on the board
at all.

A TODO queue is "what was asked minus what was resolved" — **a fold, not a
counter**: it folds the event that opens the work and the one that closes
it, and stops returning an item once the closing event lands. Because this
stack folds on demand, the queue is *always current when polled* — there is
no staleness window, and re-running a poll after a crash re-derives exactly
the still-open work from the events. That is the whole recovery story:
**the durable queue is the event history itself.**

The queue projection is usually **unkeyed by entity** (it filters on the
event types, and on a tenant tag only if the board scopes it) — its
consumer is this processor, not a request about one entity.

---

## Step 2 — The anti-corruption layer, and which way it points

When the slice calls an external system, the temptation is to model "we
received this." **Don't.**

> Our domain fact leads and the external response fills it in, not the
> other way round.

- **One event, not two.** No `XResponseReceived` alongside the domain fact.
- **The raw response travels as a technical attribute** (`raw_response`,
  `technicalAttribute: true` on the board) for forensics — never a tag,
  never folded by any read model.
- **Field names are domain names**, not the external API's.
- **The event name's preposition matters** (`…EvaluatedWithX` vs
  `…EvaluatedByX` say different things about who judged). Match the
  board's title exactly — don't improve on it.
- **The translation is a pure method** — `to_domain(response, item)` —
  separate from HTTP and from the loop, so it's testable without the
  network.

### If you compute against a deployed file, the file is an interface too

Never hand-write the fixture for a reader of a deployed artefact — derive
it from the real file and add a spec comparing the two vocabularies
(skipping cleanly when the file is absent locally). A hand-written fixture
asserts the reader against itself; if the belief about the file's shape is
wrong, every spec stays green while production reads defaults forever.

### Translation happens inline

The board may show several nodes for one external call (request → external
event → response view → translator → command). **In code it's one
processor that calls and submits** — the board makes the system boundary
visible; the implementation avoids handlers that do nothing.

If the external system starts the exchange instead (it calls us) — that's
`/build-webhook`, not this skill.

---

## Step 3 — The processor

**Files:**
- `app/slices/<context>/domain/<processor_snake_case>.rb` — the logic
- `bin/automation` (create once, shared by all processors; see below)

```ruby
# <what this processor watches, what it calls, what fact it records; note
#  the failure-visibility caveat if the external system's failure mode is
#  a reassuring answer rather than an error>
module <Context>
  module <Processor>
    extend self

    # One pass: fold the queue, process up to IN_FLIGHT items, return the
    # count processed. Pure orchestration — every effect is in the named
    # steps, so the spec can drive one pass deterministically.
    def run_once(client: default_client)
      queue = <Queue>.pending
      queue.first(IN_FLIGHT).count do |item|
        process_one(item, client:)
      end
    end

    # <where the number comes from: the provider's documented rate limit,
    #  a measured latency, or a guess flagged as one>
    IN_FLIGHT = 1

    def process_one(item, client:)
      response = client.call(item)          # may raise — rescued below
      result = <Command>.call(**to_domain(response, item))
      # A Result.failure here is decide() saying no to the mapped payload —
      # re-submitting would fail again, so log it (otherwise invisible) and
      # treat the item as handled; the queue closes via whatever event the
      # board models for rejection, or stays visible for a human.
      Rails.logger.warn("<Processor>: #{item.inspect} rejected: #{result.error}") if result.failure?
      true
    rescue StandardError => e
      # Leave the item in the queue — the next poll retries it; the poll
      # interval is the backoff. Never a second, in-memory queue.
      Rails.logger.error("<Processor>: #{item.inspect} failed, will retry next poll: #{e.message}")
      false
    end

    # Pure: external shape in, command keyword args out. Domain names only.
    def to_domain(response, item)
      { ... }
    end
  end
end
```

`bin/automation` (once per app — a plain runner loop, `Kernel#loop` +
`sleep`; each registered processor gets one `run_once` per tick):

```ruby
#!/usr/bin/env ruby
require_relative "../config/environment"

PROCESSORS = [ <Context>::<Processor> ]
# <where the number comes from — an unjustified interval is an invented
#  business rule the same way an unjustified threshold is>
POLL_INTERVAL = 30

loop do
  PROCESSORS.each do |processor|
    processor.run_once
  rescue StandardError => e
    Rails.logger.error("#{processor}: pass failed: #{e.message}")
  end
  sleep POLL_INTERVAL
end
```

Non-negotiable rules:

- **Secrets from environment/credentials**, never hardcoded. Missing
  credential → log and skip the pass, don't crash the process.
- **`POLL_INTERVAL` and `IN_FLIGHT` are named constants with a
  sourced comment.**
- **On failure, don't chain a retry inside the pass** — the poll interval
  is the backoff; the item stays in the (event-derived) queue.
- **The external system failing is a domain case only if `slice.json`
  models it.** No modelled failure event → log and leave queued; inventing
  one is the board's decision, not this skill's.
- **Idempotency against redelivery/crash-mid-pass**: the command the
  processor calls should treat "already recorded for this item" as a safe
  no-op — that's a `/build-state-change` "idempotent caller retries"
  decision; check the board's scenarios, and raise `request-feedback` if a
  crash between external call and append would double-charge anything.

---

## Step 4 — Specs

**File:** `spec/slices/<context>/<processor_snake_case>_spec.rb`

**The processor isn't tested with the network, and the loop isn't tested
at all.** What gets tested:

- The queue projection's fold, via `/build-state-view`'s specs — asked
  minus resolved, and that it **stops** returning a resolved item.
- `to_domain` as a pure method — external shape in, domain kwargs out.
- The command's own decision, via `/build-state-change`'s specs.
- **`run_once` end to end with a stub client**: given queue-opening events,
  one pass records the domain event (assert via the store) and a second
  pass finds nothing to do — the queue closed itself. Given a raising
  client, the pass returns without writing and the item is still pending
  on the next fold.
- The `IN_FLIGHT` ceiling: with more pending items than the ceiling, one
  pass processes exactly `IN_FLIGHT`.
- If a deployed file is read: the fixture-vocabulary spec from Step 2.

---

## Step 5 — Quality gate

```
bundle exec rspec && bundle exec rubocop && bundle exec packwerk check
bundle exec rspec spec/slices/<context_snake_case>
```

---

## Final check against `slice.json`

- [ ] The queue's own `/build-state-view` slice exists and is `Done` (or
      `request-feedback` was raised).
- [ ] **One domain event**, not a "response received" one; name matches the
      board exactly, preposition included.
- [ ] Field names are domain names; the raw response is a
      `technicalAttribute` field, never folded.
- [ ] The write goes through the `/build-state-change` command — never a
      bare `EventStore.append` from the processor.
- [ ] `POLL_INTERVAL`/`IN_FLIGHT` are named constants with sourced
      comments.
- [ ] Failure leaves the item in the event-derived queue; no second,
      in-memory queue anywhere.
- [ ] `to_domain` is pure and has its own specs; `run_once` has a
      stub-client spec including the crash/retry path.
- [ ] Secrets come from configuration, never hardcoded.
- [ ] If a deployed file is read: fixture derived from it, with the
      vocabulary-guard spec.
