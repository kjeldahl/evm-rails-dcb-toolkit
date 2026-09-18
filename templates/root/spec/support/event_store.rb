# frozen_string_literal: true

# Every example starts from an empty event store. With the default in-memory
# adapter this swaps the store instance (cheap); against a SQL backend
# (EVENT_STORE_ADAPTER=sqlite or postgres) it drops and recreates the schema,
# because the events table is append-only and cannot be truncated mid-history.
RSpec.configure do |config|
  config.before do
    EventStore.reset!
  end
end
