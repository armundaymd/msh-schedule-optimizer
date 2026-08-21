# ED Staffing Optimizer — Mount Sinai Adult ED

Interactive dashboard for modeling patients-per-hour (PPH) capacity
against observed demand by team and time of day.

**Stack:** FastAPI backend (`server.py`) + React/Vite frontend
(`frontend/`) + Postgres. All processed output (demand, summary,
schedule, etc.) lives in the `pipeline_outputs` table in Postgres —
nothing is read from local JSON at runtime.

**Deployment:** this repo is connected to a GitHub remote that
Coolify (running on a Hetzner box) auto-deploys from — pushing to
`main` rebuilds and redeploys the production site. Production has
its own Postgres instance and its own `DATABASE_URL`/`CORS_ORIGINS`
set as env vars inside Coolify; none of that is affected by anything
you do locally, since local dev uses its own separate database (see
below). See `Dockerfile` for the exact image Coolify builds.

---

## Setup (one time)

```bash
pip install -r requirements.txt
cd frontend && npm install
```

Copy `.env.example` to `.env` and point `DATABASE_URL` at a Postgres
instance. For local dev, spin one up with Docker instead of touching
production data:

```bash
docker compose up -d db
```

then set, in `.env`:

```
DATABASE_URL=postgresql://msh:msh@localhost:5433/msh_schedule_optimizer
```

This is a fresh, empty local database — separate from the production
one Coolify uses. `.env` is gitignored, so this never gets committed
or pushed.

---

## Running the dashboard

```bash
uvicorn server:app --reload --port 8000   # backend, one shell
cd frontend && npm run dev                 # frontend, separate shell
```

Then open **http://localhost:5173** in your browser (Vite proxies
`/api/*` requests to `localhost:8000`, per `frontend/vite.config.js`).

---

## Populating a fresh local database

A brand-new local Postgres starts empty — the endpoints will 500
until it's populated. Two ways to do that:

**A. Seed from the committed snapshot (fastest, no real patient data
needed).** `data/processed/*.json` is a committed snapshot of
previously-processed output. Load it straight into `pipeline_outputs`:

```bash
python3 -c "
import json
from pathlib import Path
from db import get_engine, init_schema
from pipeline import save_output

engine = get_engine()
init_schema(engine)
for f in Path('data/processed').glob('*.json'):
    save_output(engine, f.stem, json.loads(f.read_text()))
    print(f'Loaded {f.stem}')
"
```

**B. Run the real pipeline against raw census exports** (see below) —
required if you actually have new data to process, since the snapshot
in (A) won't reflect it.

Either way, also load the shift schedule once:

```bash
python migrate_schedule_to_db.py
```

(loads `data/Current_Schedule_Block.csv` into the `schedule_shifts`
table; re-running it replaces whatever's currently there, so don't
run it after editing the schedule directly in the DB/dashboard).

---

## Adding new data

1. Drop new raw encounter `.csv` export(s) (same column format as
   before) into `data/raw/` (create the folder if it doesn't exist —
   it's gitignored, since these exports contain patient data and
   should never be committed).
2. Either restart the backend (nothing auto-runs the pipeline on
   startup) or, with the backend already running, trigger it via:
   - the **↻ Refresh data** button in the dashboard header, or
   - `curl -X POST http://localhost:8000/api/refresh`

The pipeline (`pipeline.py`) recombines and deduplicates on CSN
across every file in `data/raw/`, so you can drop in overlapping
exports without double-counting, then writes fresh `demand`,
`summary`, `service_params`, and `schedule` rows straight into
Postgres.

Note: this same refresh flow also updates production — hitting
"Refresh data" on the live Coolify-deployed site re-runs the
pipeline there, against whatever files are in its own `data/raw/`.

---

## Updating the schedule

Replace `data/Current_Schedule_Block.csv` with an updated version
(same column format), then either re-run `python
migrate_schedule_to_db.py` or refresh data (which reloads the
schedule table as part of the pipeline run).

---

## Project structure

```
ed_staffing/
├── server.py                  ← FastAPI backend (run this)
├── db.py                      ← SQLAlchemy engine + table defs
├── pipeline.py                ← Data ingestion and processing
├── migrate_schedule_to_db.py  ← One-off CSV → schedule_shifts loader
├── docker-compose.yml         ← Local Postgres for dev
├── Dockerfile                 ← Image Coolify builds/deploys
├── data/
│   ├── raw/                   ← DROP NEW CSV EXPORTS HERE (gitignored)
│   ├── processed/             ← Committed snapshot, used only to
│   │                             seed a fresh local DB (see above)
│   └── Current_Schedule_Block.csv
└── frontend/                  ← React dashboard UI (Vite)
```

---

## Dashboard controls

| Control | What it does |
|---------|-------------|
| Max PPH sliders | Set the realistic ceiling for each team type |
| Team count sliders | Adjust attendings per time window |
| Day of week filter | Show demand for a specific DOW vs overall average |
| Quick scenarios | Snap to predefined staffing configurations |
| Team tabs | Switch between Main / Fast Track / ERU views |

**Red bars** = demand exceeds capacity at that hour.
**Blue line** = current capacity ceiling (teams × max PPH).

The summary table bottom-left shows status across all time windows at a glance.

