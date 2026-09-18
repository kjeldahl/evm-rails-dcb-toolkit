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
    # The board's scenario carries a literal depositId, so the spec passes it
    # in rather than asserting on a UUID it can never predict — that is the
    # whole point of the generator being a defaulted keyword argument.
    result = described_class.call(wallet_id: "w1", amount_cents: 500, deposit_id: "DEP-0001")

    expect(result.success?).to be(true)
    events = wallet_events("w1")
    expect(events.map(&:type)).to eq(%w[Deposited])
    expect(events.first.data).to eq(wallet_id: "w1", amount_cents: 500, deposit_id: "DEP-0001")
    expect(events.first.tags).to contain_exactly("wallet:w1", "deposit:DEP-0001")
  end

  it "mints its own identifier when the caller has none" do
    described_class.call(wallet_id: "w1", amount_cents: 500)

    expect(wallet_events("w1").first.data[:deposit_id]).to match(/\A\h{8}-\h{4}-/)
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
