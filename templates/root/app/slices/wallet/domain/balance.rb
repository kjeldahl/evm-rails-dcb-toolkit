# The wallet's balance, folded on demand from its full deposit/withdrawal
# history. dcb_event_store read models are not materialized rows: the
# projection's query (event_types + tags) is the only thing deciding which
# events it sees, and the same projection doubles as a decision-model input
# (Withdraw) and a read-side reader (the controller, via .find).
module Wallet
  module Balance
    extend self

    def find(wallet_id:)
      EventStore.project(projection(wallet_id:))
    end

    def projection(wallet_id:)
      DcbEventStore::Projection.new(
        initial_state: 0,
        handlers: {
          "Deposited" => ->(state, event) { state + event.data.fetch(:amount_cents) },
          "Withdrawn" => ->(state, event) { state - event.data.fetch(:amount_cents) }
        },
        query: DcbEventStore::Query.new(
          DcbEventStore::QueryItem.new(
            event_types: %w[Deposited Withdrawn],
            tags: [ "wallet:#{wallet_id}" ]
          )
        )
      )
    end
  end
end
