-- Incident times are kept at millisecond precision, the precision of the API's ISO strings
-- and of the pagination cursor. Rows written before this had microseconds (the worker sends
-- them), which made the cursor skip rows that shared a millisecond with a page boundary.
UPDATE incidents
   SET started_at   = date_trunc('milliseconds', started_at),
       triggered_at = date_trunc('milliseconds', triggered_at)
 WHERE started_at   <> date_trunc('milliseconds', started_at)
    OR triggered_at <> date_trunc('milliseconds', triggered_at);
