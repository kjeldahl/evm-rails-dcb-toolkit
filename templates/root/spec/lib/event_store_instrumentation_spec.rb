# frozen_string_literal: true

require "rails_helper"

# Permanent infrastructure spec: the store is observable out of the box,
# wired by the gem's railtie (no initializer in this app). Both failures it
# guards are silent — losing it costs you the query log and every APM/lograge
# subscriber, and nothing else breaks — so nothing here names a slice.
RSpec.describe "Event store instrumentation" do
  let(:event) do
    DcbEventStore::Event.new(type: "Instrumented", data: { n: 1 }, tags: [ "spec:instrumentation" ])
  end
  let(:query) { DcbEventStore::Query.new(DcbEventStore::QueryItem.new(event_types: %w[Instrumented])) }

  def capture_dcb_events(pattern = /\.dcb\z/)
    captured = []
    collector = ->(*args) { captured << ActiveSupport::Notifications::Event.new(*args) }
    ActiveSupport::Notifications.subscribed(collector, pattern) { yield }
    captured
  end

  it "routes every store operation through ActiveSupport::Notifications" do
    expect(DcbEventStore.instrumentation).to be_a(DcbEventStore::ActiveSupportInstrumentation)

    captured = capture_dcb_events do
      EventStore.append(event)
      EventStore.read(query)
    end

    expect(captured.map(&:name)).to include("append.dcb", "read.dcb")
    expect(captured.find { |e| e.name == "append.dcb" }.payload)
      .to include(event_count: 1, event_types: [ "Instrumented" ], appended_count: 1)
  end

  it "logs them through the Rails logger by default" do
    expect(Rails.application.config.dcb_event_store.log_subscriber)
      .to be_a(DcbEventStore::RailsLogSubscriber)

    lines = []
    allow(Rails.logger).to receive(:debug) { |*_args, &block| lines << block&.call }

    EventStore.append(event)

    expect(lines.compact).to include(a_string_matching(/DCB Append .*event_count=1/))
  end
end
