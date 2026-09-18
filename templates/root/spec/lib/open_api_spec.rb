# frozen_string_literal: true

require "rails_helper"

# Permanent infrastructure spec: it must keep passing after the wallet worked
# example is deleted, so nothing here names a slice. The wallet slice's own
# contribution is asserted in spec/slices/wallet/openapi_spec.rb, which goes
# away with the example.
RSpec.describe OpenApi do
  let(:document) { described_class.document }

  it "assembles a 3.1 document with the app's identity" do
    expect(document[:openapi]).to eq("3.1.0")
    expect(document[:info]).to include(:title, :version)
  end

  it "merges every slice's web/openapi.rb contribution" do
    # Discovery is by file glob + constantize — a new slice needs no
    # registration step, so this holds for whatever slices exist.
    described_class.contributors.each do |contributor|
      %i[paths schemas].each do |section|
        next unless contributor.respond_to?(section)

        keys = contributor.public_send(section).keys
        target = section == :paths ? document[:paths] : document[:components][:schemas]
        expect(target.keys).to include(*keys) if keys.any?
      end
    end
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
