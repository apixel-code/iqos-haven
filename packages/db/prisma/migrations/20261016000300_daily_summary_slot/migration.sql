-- Daily summary (roadmap step 107, ADR 0073; architecture §8 Scheduling). One summary event per
-- Dubai day, whatever replica or retry writes it: a second write for the same day fails here,
-- so the same day's summary can only be sent again through a deliberate replay of that event.
CREATE UNIQUE INDEX outbox_events_one_daily_summary ON outbox_events (aggregate_id)
  WHERE event_type = 'report.daily_summary';
