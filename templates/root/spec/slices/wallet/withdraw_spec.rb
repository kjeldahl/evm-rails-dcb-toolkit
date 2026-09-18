# frozen_string_literal: true

require "rails_helper"

RSpec.describe Wallet::Withdraw do
  # Arrange through the context's own Events constructors — the same shapes
  # production writes, so the fold under test sees real events.
  def deposit(wallet_id, amount_cents)
    EventStore.append(Wallet::Events.deposited(wallet_id:, amount_cents:))
  end

  it "a withdrawal within the balance succeeds" do
    deposit("w1", 500)

    result = described_class.call(wallet_id: "w1", amount_cents: 200)

    expect(result.success?).to be(true)
    expect(Wallet::Balance.find(wallet_id: "w1")).to eq(300)
  end

  it "a withdrawal beyond the balance is rejected" do
    deposit("w1", 100)

    result = described_class.call(wallet_id: "w1", amount_cents: 200)

    expect(result.failure?).to be(true)
    expect(result.error).to eq("wallet is overdrawn")
    expect(Wallet::Balance.find(wallet_id: "w1")).to eq(100)
  end

  it "another wallet's balance never covers this one" do
    deposit("w2", 1_000)

    result = described_class.call(wallet_id: "w1", amount_cents: 1)

    expect(result.failure?).to be(true)
    expect(result.error).to eq("wallet is overdrawn")
  end

  it "a concurrent write between read and append is told to retry" do
    deposit("w1", 500)
    # Recreate the race deterministically: capture the decision the command
    # would have made, land a conflicting event, then append with the stale
    # condition — exactly what the command's rescue turns into a retry.
    stale = EventStore.decide(balance: Wallet::Balance.projection(wallet_id: "w1"))
    EventStore.append(Wallet::Events.withdrawn(wallet_id: "w1", amount_cents: 400))

    expect {
      EventStore.append(Wallet::Events.withdrawn(wallet_id: "w1", amount_cents: 200), stale.append_condition)
    }.to raise_error(DcbEventStore::ConditionNotMet)
    # And the command translates that raise for its caller:
    expect(described_class.call(wallet_id: "w1", amount_cents: 200).error).to eq("wallet is overdrawn")
  end
end
