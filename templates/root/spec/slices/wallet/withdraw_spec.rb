# frozen_string_literal: true

require "rails_helper"

RSpec.describe Wallet::Withdraw do
  # Arrange through the context's own Events constructors — the same shapes
  # production writes, so the fold under test sees real events.
  def deposit(wallet_id, amount_cents, deposit_id: SecureRandom.uuid)
    EventStore.append(Wallet::Events.deposited(wallet_id:, amount_cents:, deposit_id:))
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
    # The conflicting event has to land *inside* the command's own read →
    # append window; appending it beforehand only changes the balance the
    # command reads, and the business rule — not the condition — is what
    # then rejects it. Wrapping the read is what makes the race
    # deterministic, and it is the command's own Result that is asserted:
    # a spec that only proves the store raises never reaches the rescue.
    allow(EventStore).to receive(:decide).and_wrap_original do |read, *args, **projections|
      decision = read.call(*args, **projections)
      EventStore.append(Wallet::Events.withdrawn(wallet_id: "w1", amount_cents: 100))
      decision
    end

    result = described_class.call(wallet_id: "w1", amount_cents: 200)

    expect(result.failure?).to be(true)
    expect(result.error).to eq("the wallet changed while you were working — please retry")
  end
end
