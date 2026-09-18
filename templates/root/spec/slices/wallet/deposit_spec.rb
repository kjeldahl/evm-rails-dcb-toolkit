# frozen_string_literal: true

require "rails_helper"

# One example per board scenario, named after the scenario's literal title;
# example data comes from the board verbatim (.build-kit/AGENTS.md).
RSpec.describe Wallet::Deposit do
  def wallet_events(wallet_id)
    EventStore.read(
      DcbEventStore::Query.new(
        DcbEventStore::QueryItem.new(event_types: %w[Deposited Withdrawn], tags: [ "wallet:#{wallet_id}" ])
      )
    )
  end

  it "a deposit is recorded" do
    result = described_class.call(wallet_id: "w1", amount_cents: 500)

    expect(result.success?).to be(true)
    events = wallet_events("w1")
    expect(events.map(&:type)).to eq(%w[Deposited])
    expect(events.first.data).to eq(wallet_id: "w1", amount_cents: 500)
  end

  it "a deposit must be a positive amount" do
    result = described_class.call(wallet_id: "w1", amount_cents: "-5")

    expect(result.failure?).to be(true)
    expect(result.error).to eq("amount must be a positive number of cents")
    expect(wallet_events("w1")).to be_empty
  end

  it "garbage input is rejected, not coerced to zero" do
    result = described_class.call(wallet_id: "w1", amount_cents: "lots")

    expect(result.failure?).to be(true)
    expect(result.error).to eq("amount must be a positive number of cents")
  end
end
