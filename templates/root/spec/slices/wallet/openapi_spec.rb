# frozen_string_literal: true

require "rails_helper"

# The wallet worked example's contribution to the app-wide OpenAPI document.
# It lives here, not in spec/lib/open_api_spec.rb, so it is deleted together
# with the example (INSTALL.md's last step) instead of failing afterwards.
RSpec.describe "Wallet OpenAPI contribution" do
  let(:document) { OpenApi.document }

  it "merges the slice's paths and schemas into the document" do
    # A new slice's web/openapi.rb is picked up by file glob with no
    # registration step.
    expect(document[:paths].keys).to include(
      "/wallets/{wallet_id}",
      "/wallets/{wallet_id}/history",
      "/wallets/{wallet_id}/deposit",
      "/wallets/{wallet_id}/withdraw"
    )
    expect(document[:components][:schemas].keys)
      .to include("WalletBalance", "WalletHistory", "WalletHistoryEntry", "AmountCents", "CommandRejected")
  end
end
