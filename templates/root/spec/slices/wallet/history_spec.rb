# frozen_string_literal: true

require "rails_helper"

# The list read model's spec. A fold into rows is worth testing for three
# things a scalar fold can't go wrong at: order, the running total, and the
# empty case.
RSpec.describe Wallet::History do
  def deposit(wallet_id, amount_cents, deposit_id: SecureRandom.uuid)
    EventStore.append(Wallet::Events.deposited(wallet_id:, amount_cents:, deposit_id:))
  end

  def withdraw(wallet_id, amount_cents)
    EventStore.append(Wallet::Events.withdrawn(wallet_id:, amount_cents:))
  end

  it "an untouched wallet has a renderable empty state" do
    expect(described_class.find(wallet_id: "nope")).to eq([])
  end

  it "rows come back in the order they were appended, with the balance after each" do
    deposit("w1", 500)
    withdraw("w1", 150)
    deposit("w1", 25)

    entries = described_class.find(wallet_id: "w1")

    expect(entries.map(&:kind)).to eq(%w[Deposit Withdrawal Deposit])
    # A withdrawal is signed, so the running balance is a plain sum.
    expect(entries.map(&:amount_cents)).to eq([ 500, -150, 25 ])
    expect(entries.map(&:balance_cents)).to eq([ 500, 350, 375 ])
  end

  it "ends on the same number the Balance projection folds to" do
    deposit("w1", 500)
    withdraw("w1", 150)

    expect(described_class.find(wallet_id: "w1").last.balance_cents)
      .to eq(Wallet::Balance.find(wallet_id: "w1"))
  end

  it "events tagged for other wallets are never folded in" do
    deposit("w1", 500)
    deposit("w2", 9_000)

    expect(described_class.find(wallet_id: "w1").map(&:amount_cents)).to eq([ 500 ])
  end

  it "stamps each row with the store's own created_at" do
    deposit("w1", 500)

    expect(described_class.find(wallet_id: "w1").first.at).to be_a(Time)
  end
end
