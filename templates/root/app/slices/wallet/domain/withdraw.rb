# Takes money out of a wallet, but never below zero. The invariant depends
# on the folded balance, so the decision model's append condition rides the
# write: if any wallet event lands between the read and the append, the
# store raises ConditionNotMet and the caller is told to retry — the
# overdraft race is closed by the store, not by luck.
module Wallet
  class Withdraw
    def self.call(wallet_id:, amount_cents:)
      wallet_id = wallet_id.to_s.strip
      amount_cents = Integer(amount_cents.to_s, exception: false)
      return Result.failure("wallet is required") if wallet_id.empty?
      return Result.failure("amount must be a positive number of cents") if amount_cents.nil? || amount_cents <= 0

      decision = EventStore.decide(balance: Balance.projection(wallet_id:))
      return Result.failure("wallet is overdrawn") if decision.states[:balance] < amount_cents

      EventStore.append(Events.withdrawn(wallet_id:, amount_cents:), decision.append_condition)
      Result.success(wallet_id)
    rescue DcbEventStore::ConditionNotMet
      Result.failure("the wallet changed while you were working — please retry")
    end
  end
end
