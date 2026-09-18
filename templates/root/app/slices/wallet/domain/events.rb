# The wallet context's event constructors. Only this module builds the
# events the context owns, and only this context appends them — events are
# the sole cross-slice contract, so their shape (type, data, tags) is fixed
# here in exactly one place.
#
# Tag rule (.build-kit/CLAUDE.md): every idAttribute field on the board
# becomes a "key:value" tag — walletId → "wallet:#{wallet_id}".
module Wallet
  module Events
    extend self

    def deposited(wallet_id:, amount_cents:)
      DcbEventStore::Event.new(
        type: "Deposited",
        data: { wallet_id:, amount_cents: },
        tags: [ "wallet:#{wallet_id}" ]
      )
    end

    def withdrawn(wallet_id:, amount_cents:)
      DcbEventStore::Event.new(
        type: "Withdrawn",
        data: { wallet_id:, amount_cents: },
        tags: [ "wallet:#{wallet_id}" ]
      )
    end
  end
end
