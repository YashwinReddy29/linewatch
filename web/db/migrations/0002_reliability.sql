-- Durable Roboflow uploads, cursor pagination indexes.
--
-- Upload jobs live on the incident row: one job per false alarm, claimed with
-- FOR UPDATE SKIP LOCKED so any number of web processes can run the job loop.

ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_roboflow_status_check;
ALTER TABLE incidents ADD CONSTRAINT incidents_roboflow_status_check
  CHECK (roboflow_status IN ('queued', 'uploading', 'uploaded', 'failed', 'skipped'));

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS roboflow_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS roboflow_next_attempt_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS roboflow_locked_until TIMESTAMPTZ;

-- Sanity constraints on what the worker sends.
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_confidence_range;
ALTER TABLE incidents ADD CONSTRAINT incidents_confidence_range CHECK (confidence >= 0 AND confidence <= 1) NOT VALID;
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_frames_valid;
ALTER TABLE incidents ADD CONSTRAINT incidents_frames_valid
  CHECK (violating_frames >= 1 AND violating_frames <= window_frames) NOT VALID;

-- Keyset pagination: newest first, id breaks ties.
DROP INDEX IF EXISTS incidents_triggered_idx;
DROP INDEX IF EXISTS incidents_status_idx;
CREATE INDEX IF NOT EXISTS incidents_triggered_id_idx ON incidents (triggered_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS incidents_status_triggered_id_idx ON incidents (status, triggered_at DESC, id DESC);

-- The job loop only ever looks at queued or in-flight uploads.
CREATE INDEX IF NOT EXISTS incidents_upload_due_idx ON incidents (roboflow_next_attempt_at)
  WHERE roboflow_status IN ('queued', 'uploading');
