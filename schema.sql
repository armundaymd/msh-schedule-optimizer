-- Schema for the ED Staffing Dashboard on Render Postgres.
-- Apply once against the database (e.g. `psql "$DATABASE_URL" -f schema.sql`).
-- pipeline.py / db.py also create these tables automatically on startup
-- (CREATE TABLE IF NOT EXISTS), so running this file by hand is optional.

-- One row per shift block, replacing data/Current_Schedule_Block.csv.
CREATE TABLE IF NOT EXISTS schedule_shifts (
    id          SERIAL PRIMARY KEY,
    day_type    TEXT NOT NULL
                CHECK (day_type IN ('Monday','Tuesday','Wednesday','Thursday',
                                     'Friday','Saturday','Sunday')),
    team        TEXT NOT NULL
                CHECK (team IN ('Green','Red','Blue','FastTrack','ERU')),
    role_type   TEXT NOT NULL
                CHECK (role_type IN ('Attending','PA','Resident')),
    role_detail TEXT,
    resident_level TEXT
                CHECK (resident_level IS NULL OR resident_level IN
                       ('PGY-1','PGY-2','PGY-3','PGY-4','Off-Service')),
    start_time  TEXT NOT NULL
                CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
    end_time    TEXT NOT NULL
                CHECK (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
);

-- NOTE: metadata.create_all() (used by db.py's init_schema on every app boot)
-- only creates missing tables — it will NOT add this column to an
-- already-existing schedule_shifts table. If schedule_shifts already exists
-- in your database, run this by hand once:
--   ALTER TABLE schedule_shifts ADD COLUMN IF NOT EXISTS resident_level TEXT
--       CHECK (resident_level IS NULL OR resident_level IN
--              ('PGY-1','PGY-2','PGY-3','PGY-4','Off-Service'));

CREATE INDEX IF NOT EXISTS idx_schedule_shifts_day_team
    ON schedule_shifts (day_type, team);

-- One row per pipeline/validation output (demand, summary, service_params,
-- schedule, validation, demand_ci), replacing data/processed/*.json.
CREATE TABLE IF NOT EXISTS pipeline_outputs (
    key          TEXT PRIMARY KEY
                 CHECK (key IN ('demand','summary','service_params',
                                'schedule','validation','demand_ci')),
    payload      JSONB NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved scenarios, one row per save, for both /legacy and /v2 (kept
-- separate by `version` so a scenario saved in one version isn't listed in
-- the other). payload shape: { shifts: { Monday: [...], ... }, pph,
-- costRates, customTeams, target, generatorSettings? }, with shift rows in
-- the same column convention as schedule_shifts (day_type, team, role_type,
-- role_detail, resident_level, start_time, end_time), never the frontend's
-- internal id/startMins/endMins fields.
CREATE TABLE IF NOT EXISTS scenarios (
    id         TEXT PRIMARY KEY,
    version    TEXT NOT NULL CHECK (version IN ('legacy','v2')),
    name       TEXT NOT NULL,
    payload    JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenarios_version_created
    ON scenarios (version, created_at DESC);
