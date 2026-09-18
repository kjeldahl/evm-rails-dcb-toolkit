# frozen_string_literal: true

require "fileutils"

require "dcb_event_store"
require "connection_pool"

# Application-wide access to the DCB event store. All domain state lives in
# the append-only events table; slices read it through projections and write
# through commands that use append conditions for consistency.
#
# Three adapters (config/event_store.yml): "sqlite" (default — one file, no
# server, `path:`), "postgres" (`host/port/username/password/database:`) and
# "memory" (DcbEventStore::InMemoryStore — the test default; single-threaded,
# per-process, so parallel test workers are fully isolated).
#
# The driver gem is required lazily, so an app only bundles the one its
# adapter uses (sqlite3 or pg).
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

      pool.with { |conn| block.call(store_for(conn)) }
    end

    def create_schema!
      return if memory?

      pool.with { |conn| schema.create!(conn) }
    end

    # Idempotent bootstrap: create the configured database (the SQLite file's
    # directory, or the PostgreSQL database) if it is missing, then the event
    # store schema. Lets a fresh checkout start with one task.
    def prepare!
      return if memory?

      create_database!
      create_schema!
    end

    def drop_schema!
      return if memory?

      pool.with { |conn| schema.drop!(conn) }
    end

    # Test-only: the events table is append-only, so wiping it means swapping
    # the in-memory store instance, or drop + recreate for the SQL backends.
    def reset!
      if memory?
        @memory_store = DcbEventStore::InMemoryStore.new
      else
        drop_schema!
        create_schema!
      end
    end

    def adapter
      connection_config[:adapter]
    end

    def memory?
      adapter == "memory"
    end

    def sqlite?
      adapter == "sqlite"
    end

    def pool
      @pool ||= ConnectionPool.new(size: pool_size, timeout: 5) { connect }
    end

    private

    def notify_append_hooks(events)
      append_hooks.each { |hook| hook.call(events) }
    end

    def append_hooks
      @append_hooks ||= []
    end

    def store_for(conn)
      sqlite? ? DcbEventStore::SqliteStore.new(conn) : DcbEventStore::PostgresStore.new(conn)
    end

    def schema
      sqlite? ? DcbEventStore::SqliteStore::Schema : DcbEventStore::PostgresStore::Schema
    end

    def connect
      sqlite? ? sqlite_connection : postgres_connection
    end

    # Every connection opened against the file needs the store's pragmas (WAL,
    # foreign keys, the GVL-releasing busy handler), not just the one that
    # installed the schema.
    def sqlite_connection
      require "sqlite3"
      SQLite3::Database.new(database_path).tap do |db|
        DcbEventStore::SqliteStore::Schema.configure!(db)
      end
    end

    def postgres_connection
      require "pg"
      PG.connect(**pg_config)
    end

    def create_database!
      return FileUtils.mkdir_p(File.dirname(database_path)) if sqlite?

      create_postgres_database!
    end

    def create_postgres_database!
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

    # SQLite: `path:` from config/event_store.yml, relative to Rails.root
    # (an absolute path is used as given).
    def database_path
      Rails.root.join(connection_config[:path]).to_s
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
