# frozen_string_literal: true

require "rails_helper"

RSpec.describe Wallet::Balance do
  it "an untouched wallet has a renderable default state" do
    expect(described_class.find(wallet_id: "nope")).to eq(0)
  end

  it "deposits and withdrawals fold to the running balance" do
    EventStore.append(Wallet::Events.deposited(wallet_id: "w1", amount_cents: 500))
    EventStore.append(Wallet::Events.withdrawn(wallet_id: "w1", amount_cents: 150))
    EventStore.append(Wallet::Events.deposited(wallet_id: "w1", amount_cents: 25))

    expect(described_class.find(wallet_id: "w1")).to eq(375)
  end

  it "events tagged for other wallets are never folded in" do
    EventStore.append(Wallet::Events.deposited(wallet_id: "w1", amount_cents: 500))
    EventStore.append(Wallet::Events.deposited(wallet_id: "w2", amount_cents: 9_000))

    expect(described_class.find(wallet_id: "w1")).to eq(500)
  end
end
