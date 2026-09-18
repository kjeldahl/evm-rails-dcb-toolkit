# frozen_string_literal: true

namespace :event_store do
  desc "Create the database (SQLite file or PostgreSQL database) if missing, then the schema"
  task prepare: :environment do
    EventStore.prepare!
    puts "Event store ready for #{Rails.env}."
  end

  desc "Create the events table and supporting functions"
  task setup: :environment do
    EventStore.create_schema!
    puts "Event store schema created for #{Rails.env}."
  end

  desc "Drop the events table"
  task drop: :environment do
    EventStore.drop_schema!
    puts "Event store schema dropped for #{Rails.env}."
  end

  desc "Drop and recreate the events table (destroys all events!)"
  task reset: :environment do
    EventStore.reset!
    puts "Event store schema reset for #{Rails.env}."
  end
end
