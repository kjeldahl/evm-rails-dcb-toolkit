# frozen_string_literal: true

require "rails_helper"

RSpec.describe OpenApi do
  let(:document) { described_class.document }

  it "assembles a 3.1 document with the app's identity" do
    expect(document[:openapi]).to eq("3.1.0")
    expect(document[:info]).to include(:title, :version)
  end

  it "merges every slice's paths and schemas" do
    # The wallet worked example contributes; a new slice's web/openapi.rb is
    # picked up by file glob with no registration step.
    expect(document[:paths].keys).to include(
      "/wallets/{wallet_id}",
      "/wallets/{wallet_id}/deposit",
      "/wallets/{wallet_id}/withdraw"
    )
    expect(document[:components][:schemas].keys)
      .to include("WalletBalance", "AmountCents", "CommandRejected")
  end

  it "every $ref points at a schema the document actually carries" do
    refs = []
    walk = lambda do |node|
      case node
      when Hash
        refs << node["$ref"] if node["$ref"]
        node.each_value { |child| walk.call(child) }
      when Array
        node.each { |child| walk.call(child) }
      end
    end
    walk.call(document[:paths])

    known = document[:components][:schemas].keys.map { |name| "#/components/schemas/#{name}" }
    expect(refs).to all(be_in(known))
  end
end
