# Records money arriving in a wallet. Input shape first (a positive integer
# amount in cents); no invariant depends on what was read — two deposits are
# two real facts — so the append deliberately carries no condition
# (.build-kit/CLAUDE.md, "Architecture rules").
#
# `deposit_id:` is the board's `generated: true` identifier, minted here in
# the impure shell — but as a **keyword argument defaulting to the
# generator**, never an inline `SecureRandom.uuid` at the call site. That is
# what lets a spec pass the board's literal example id and assert on it; a
# hard-coded generator makes the scenario's own data untestable.
module Wallet
  class Deposit
    def self.call(wallet_id:, amount_cents:, deposit_id: SecureRandom.uuid)
      wallet_id = wallet_id.to_s.strip
      amount_cents = Integer(amount_cents.to_s, exception: false)
      return Result.failure("wallet is required") if wallet_id.empty?
      return Result.failure("amount must be a positive number of cents") if amount_cents.nil? || amount_cents <= 0

      EventStore.append(Events.deposited(wallet_id:, amount_cents:, deposit_id:))
      Result.success(wallet_id)
    end
  end
end
