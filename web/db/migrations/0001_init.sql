-- Applied automatically on first request (idempotent).

CREATE TABLE IF NOT EXISTS zones (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  points      JSONB NOT NULL,             -- [[x, y], ...] normalized 0..1
  active      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one active zone at a time.
CREATE UNIQUE INDEX IF NOT EXISTS zones_one_active ON zones (active) WHERE active;

CREATE TABLE IF NOT EXISTS incidents (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracker_id         INTEGER NOT NULL,
  zone_id            TEXT,
  zone_name          TEXT,
  rule               TEXT NOT NULL,
  started_at         TIMESTAMPTZ NOT NULL,
  triggered_at       TIMESTAMPTZ NOT NULL,
  duration_s         REAL NOT NULL,
  violating_frames   INTEGER NOT NULL,
  window_frames      INTEGER NOT NULL,
  confidence         REAL NOT NULL,
  bbox               JSONB NOT NULL,      -- [x1, y1, x2, y2] normalized
  has_snapshot       BOOLEAN NOT NULL DEFAULT FALSE,
  has_raw            BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'confirmed', 'false_alarm')),
  reviewed_at        TIMESTAMPTZ,
  roboflow_status    TEXT CHECK (roboflow_status IN ('uploading', 'uploaded', 'failed', 'skipped')),
  roboflow_image_id  TEXT,
  roboflow_error     TEXT,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_triggered_idx ON incidents (triggered_at DESC);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents (status);
