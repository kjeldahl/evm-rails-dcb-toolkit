# frozen_string_literal: true

# Event-store observability, on by default.
#
# The gem instruments every operation it performs and publishes a *.dcb
# event for it — append.dcb, read.dcb, subscribe.dcb, projection.dcb,
# decision_model.dcb — through DcbEventStore.instrumentation. Nothing is
# emitted while no one subscribes, so both halves below are needed for the
# store to show up in the log at all.
#
# 1 · The engine. ActiveSupportInstrumentation is a drop-in replacement for
#     the gem's own pub/sub that routes every *.dcb event through
#     ActiveSupport::Notifications. Everything that already consumes AS::N —
#     APM agents, lograge, your own subscribers — then sees event-store
#     activity natively, nested inside the surrounding request/job span. The
#     gem's own subscriber API keeps working against it, which is what the
#     log subscriber below uses.
#
# 2 · The logger. RailsLogSubscriber renders those events the way
#     ActiveRecord renders SQL queries — bold label, duration, payload:
#
#       DCB Append (1.4ms)  store=DcbEventStore::SqliteStore event_count=1 ...
#
#     It logs at *debug*, like SQL queries do: visible in development and
#     test, quiet in production until RAILS_LOG_LEVEL=debug. Set
#     EVENT_STORE_LOG=false to detach it — the AS::N events keep flowing, so
#     metrics and APM subscribers are unaffected.
#
# This runs at boot rather than on reload on purpose: subscriptions are
# process-wide and would stack up one copy per reload in to_prepare.
DcbEventStore.instrumentation = DcbEventStore::ActiveSupportInstrumentation.new

unless %w[0 false no off].include?(ENV["EVENT_STORE_LOG"].to_s.strip.downcase)
  # Kept on config.x so a spec can assert the wiring is in place, and so an
  # app can detach it later: `...event_store_log_subscription`.
  config = Rails.application.config
  subscriber = DcbEventStore::RailsLogSubscriber.new(
    logger: Rails.logger,
    colorize: config.colorize_logging
  )
  config.x.event_store_log_subscriber = subscriber
  config.x.event_store_log_subscription = subscriber.attach_to
end
