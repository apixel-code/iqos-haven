-- A transition command UUID identifies one staff action globally, including attempts aimed at
-- another order. Creation rows retain their stable internal labels; the existing per-order
-- constraint remains the fallback for every history kind.
CREATE UNIQUE INDEX order_status_history_transition_command
  ON order_status_history (command_id)
  WHERE actor_kind='staff' AND from_status IS NOT NULL;
