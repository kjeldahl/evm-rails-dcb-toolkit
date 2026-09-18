# The wallet's ledger: one row per deposit and withdrawal, in order, with
# the balance after each. The **list** read model of this worked example —
# Balance is the scalar one, and the only difference is what the fold
# accumulates.
#
# Two things worth copying:
#
# - **Rows are a `Data.define`, not a Hash.** The folded state is immutable
#   and each row is a value object, so a typo in a key is a NoMethodError at
#   the point of the mistake rather than a `nil` that reaches the screen.
# - **The query is tag-scoped**, so this reads one wallet's history, not the
#   whole log. A list read model with an unbounded query is O(all events)
#   per request — see the build-state-view skill on what to do then.
module Wallet
  module History
    Entry = Data.define(:kind, :amount_cents, :balance_cents, :at)

    extend self

    def find(wallet_id:)
      EventStore.project(projection(wallet_id:))
    end

    def projection(wallet_id:)
      DcbEventStore::Projection.new(
        initial_state: [],
        handlers: {
          "Deposited" => ->(rows, event) { rows + [ entry("Deposit", event.data.fetch(:amount_cents), rows, event) ] },
          "Withdrawn" => ->(rows, event) { rows + [ entry("Withdrawal", -event.data.fetch(:amount_cents), rows, event) ] }
        },
        # Same event types and the same tag as Balance: two read models over
        # one stream of facts, neither of them a stored row.
        query: DcbEventStore::Query.new(
          DcbEventStore::QueryItem.new(
            event_types: %w[Deposited Withdrawn],
            tags: [ "wallet:#{wallet_id}" ]
          )
        )
      )
    end

    private

    # `amount_cents` is signed (a withdrawal is negative) so the running
    # balance is a sum and the screen needs no branching. `created_at` is a
    # Time on every backend — the store stamps it, so it is the one field a
    # projection gets for free.
    def entry(kind, amount_cents, rows, event)
      Entry.new(
        kind: kind,
        amount_cents: amount_cents,
        balance_cents: (rows.last&.balance_cents || 0) + amount_cents,
        at: event.created_at
      )
    end
  end
end
