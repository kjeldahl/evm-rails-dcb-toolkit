# frozen_string_literal: true

require "rails_helper"

# Every web-facing slice needs one of these (.build-kit/CLAUDE.md, "JSON API
# and OpenAPI"). Domain specs cannot see the web layer at all: the route's
# `module:`, the view lookup path and the JSON content type are only
# exercised by a real request, and each of them fails *quietly* — a missing
# template answers 204 or 406 depending on the request's Accept header
# rather than raising, and a bad route only blows up at request time. This
# file is the gate for all three.
RSpec.describe "Wallet endpoints", type: :request do
  it "renders the balance screen" do
    Wallet::Deposit.call(wallet_id: "w1", amount_cents: 500)

    get "/wallets/w1"

    expect(response).to have_http_status(200)
    expect(response.body).to include("Wallet w1", "$5.00")
  end

  it "serves the same read model as JSON" do
    Wallet::Deposit.call(wallet_id: "w1", amount_cents: 500)

    get "/wallets/w1.json"

    expect(response).to have_http_status(200)
    expect(response.parsed_body).to eq("wallet_id" => "w1", "balance_cents" => 500)
  end

  it "accepts a token-less JSON command, as documented in web/openapi.rb" do
    post "/wallets/w1/deposit.json",
         params: { amount_cents: 500 }.to_json,
         headers: { "content-type" => "application/json" }

    expect(response).to have_http_status(200)
    expect(response.parsed_body).to eq("wallet_id" => "w1", "balance_cents" => 500)
  end

  it "answers a rejected command with 422 and the board's own message" do
    post "/wallets/w1/withdraw.json",
         params: { amount_cents: 500 }.to_json,
         headers: { "content-type" => "application/json" }

    expect(response).to have_http_status(422)
    expect(response.parsed_body).to eq("error" => "wallet is overdrawn")
  end

  it "redirects an HTML form post back to the screen" do
    post "/wallets/w1/deposit", params: { amount_cents: 500 }

    expect(response).to redirect_to("/wallets/w1")
  end

  it "carries a rejection back to the screen as a flash" do
    post "/wallets/w1/withdraw", params: { amount_cents: 500 }

    expect(response).to redirect_to("/wallets/w1")
    expect(flash[:alert]).to eq("wallet is overdrawn")
  end
end
