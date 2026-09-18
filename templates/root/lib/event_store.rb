# frozen_string_literal: true

require "dcb_event_store"
require "connection_pool"
require "pg"

# Application-wide access to the DCB event store. All domain state lives in
# the append-only events table; slices read it through projections and write
# through commands that use append conditions for consistency.
#
# Two adapters (config/event_store.yml): "postgres" (default) and "memory"
# (DcbEventStore::InMemoryStore — the test default; single-threaded,
# per-process, so parallel test workers are fully isolated).
module EventStore
  class << self
    def append(events, condition = nil)
      appended = with_store { |store| store.append(events, condition) }
      notify_append_hooks(Array(events))
      appended
    end

    # Registers an observer block called with the appended events (always an
    # Array) after every successful append — never on a failed condition,
    # because the store raises before notification. Hooks survive reset!.
    def on_append(&block)
      append_hooks << block
    end

    def read(query)
      with_store { |store| store.read(query).to_a }
    end

    # Builds a decision model from one or more named projections, yielding
    # their folded states and an append condition covering everything read.
    def decide(**projections)
      with_store { |store| DcbEventStore::DecisionModel.build(store, **projections) }
    end

    def project(projection)
      decide(state: projection).states[:state]
    end

    def with_store(&block)
      return block.call(memory_store) if memory?

      pool.with { |conn| block.call(DcbEventStore::Store.new(conn)) }
    end

    def create_schema!
      return if memory?

      pool.with { |conn| DcbEventStore::Schema.create!(conn) }
    end

    # Idempotent bootstrap: create the configured database if it is missing,
    # then the event store schema. Lets a fresh checkout start with one task.
    def prepare!
      return if memory?

      create_database!
      create_schema!
    end

    def drop_schema!
      return if memory?

      pool.with { |conn| DcbEventStore::Schema.drop!(conn) }
    end

    # Test-only: the events table is append-only, so wiping it means swapping
    # the in-memory store instance, or drop + recreate for PostgreSQL.
    def reset!
      if memory?
        @memory_store = DcbEventStore::InMemoryStore.new
      else
        drop_schema!
        create_schema!
      end
    end

    def memory?
      connection_config[:adapter] == "memory"
    end

    def pool
      @pool ||= ConnectionPool.new(size: pool_size, timeout: 5) { PG.connect(**pg_config) }
    end

    private

    def notify_append_hooks(events)
      append_hooks.each { |hook| hook.call(events) }
    end

    def append_hooks
      @append_hooks ||= []
    end

    def create_database!
      with_maintenance_connection do |conn|
        next if database_exists?(conn)

        conn.exec("CREATE DATABASE #{conn.escape_identifier(connection_config[:database])}")
      end
    end

    def database_exists?(conn)
      query = "SELECT 1 FROM pg_database WHERE datname = $1"
      conn.exec_params(query, [ connection_config[:database] ]).ntuples.positive?
    end

    # CREATE DATABASE cannot run against the target database itself, so this
    # connects to the always-present "postgres" maintenance database instead.
    def with_maintenance_connection
      conn = PG.connect(**pg_config.merge(dbname: "postgres"))
      yield conn
    ensure
      conn&.close
    end

    def memory_store
      @memory_store ||= DcbEventStore::InMemoryStore.new
    end

    def pool_size
      Integer(ENV.fetch("EVENT_STORE_POOL_SIZE", 5))
    end

    def connection_config
      Rails.application.config_for(:event_store)
    end

    def pg_config
      config = connection_config
      {
        host: config[:host],
        port: config[:port],
        dbname: config[:database],
        user: config[:username],
        password: config[:password]
      }.compact
    end
  end
end
