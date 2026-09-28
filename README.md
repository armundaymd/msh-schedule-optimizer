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
2. With the backend running, trigger the pipeline (nothing runs it on
   startup) via:
   - the **↻ Refresh data** button in the dashboard header, or
   - `curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:8000/api/refresh`

   Refresh is **off unless `ADMIN_TOKEN` is set** in the backend's
   environment (`.env` locally). When it is, the button appears and asks
   for that password; without it the button is hidden and the endpoint
   returns 403.

The pipeline (`pipeline.py`) recombines and deduplicates on CSN
across every file in `data/raw/`, so you can drop in overlapping
exports without double-counting, then writes fresh `demand`,
`summary`, `service_params`, and `schedule` rows straight into
Postgres.

Note: on production, Refresh would re-run the pipeline against
whatever files are in the server's own `data/raw/` — normally none or
old ones, which would overwrite good data. Keep `ADMIN_TOKEN` **unset**
in Coolify so Refresh is disabled there, and update production data as
described under "Updating production data" below.

Refresh does **not** recompute the `validation` and `demand_ci` rows
(empirical PPH, the chart's 95% band). Run `python3 validate.py`
afterwards; it overwrites those two rows in the database named by
`DATABASE_URL` (`python3 validate.py --help` is safe and runs nothing).

Safety checks: a refresh that would leave fewer than half the encounters
currently stored is refused unless forced (`POST /api/refresh?force=true`)
— it usually means older exports are missing from `data/raw/`, since
refresh rebuilds from every file rather than appending. Files whose CSNs
were turned into scientific notation (opened and saved in Excel) are
rejected.

## Updating production data

Raw exports never leave your machine. Instead:

1. Locally: put the exports in `data/raw/`, Refresh (or run the pipeline),
   and run `python3 validate.py`.
2. Write the six aggregated outputs from the local database into
   `data/processed/` (see `scripts/export_processed.py`), review, commit
   and push. Coolify redeploys automatically.
3. In Coolify: open the app → **Terminal** → the backend container. If
   `data/Current_Schedule_Block.csv` changed, first run
   `python3 migrate_schedule_to_db.py` (replaces the shift schedule table).
   Then run the seed command from "Populating a fresh local database"
   (option A).
   The seed overwrites only those six result rows in the production
   database; saved scenarios are untouched.
4. Check the header shows the new encounter count and date range.

`data/processed/*.json` is a committed snapshot of **aggregated** outputs
(hourly counts, distributions, service-time fits, staff schedule — no
patient identifiers). It seeds a fresh database and is the input to the
analysis runs in `frontend/analysis/`; refreshing the database does not
update it.

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

## Using the dashboard

The landing page offers three versions: **Classic** (`/legacy`), **Optimizer v2**
(`/v2`) and **Optimizer v3** (`/v3`, the only one with the Staffing plan).

**Help for users lives in the app.** In v3, press **?** or click the **?** button
in the top bar; the small **?** next to each part of the screen opens its
explanation. The text is in `frontend/src/v3/help/helpContent.js` (edit wording
there; the Help panel only renders it). A plain-English user guide with
step-by-step recipes is kept separately: [PPH Scheduling Tool — Plain-English Guide](https://claude.ai/code/artifact/1b2929bc-21a3-4948-b7d7-169161bdad43).

v3 at a glance:

| Part | What it does |
|------|-------------|
| Area tabs + Mean / p50 / p75 / p90 | Choose the area (or Main + ERU / Whole ED) and how busy a day to plan for |
| Throughput sliders | Assumed patients/hr per attending (ceiling, solo) and per resident level / PA |
| Timeline | Drag, resize or click shifts; ←/→ moves a selected shift 30 min |
| Coverage bar, week heatmap, chart | Red = short, blue = excess, striped = total fine but an area short (shortfalls under 0.05 patients/hr display as covered) |
| ⚡ Auto-optimize | Rule-of-thumb patch for one day; keeps hard rules (ERU one attending, none in closed/cross-covered hours) |
| ✦ Generate schedule | Quick heuristic attending schedule for one area; keeps ERU max one and closed hours |
| ▦ Staffing plan | OR-Tools CP-SAT planner: fixed hours, coverage/unmet targets, minimum practical, resource frontier |

Operational rules the Staffing plan enforces (configured in
`frontend/src/shared/operationalCoverage.js`, built into the solver instance in
`frontend/src/shared/staffingPlan.js`):

- **Resident supervision (hard):** a resident may only work while their
  operating team has its own attending (explicitly cross-covered hours:
  the covering area supervises).
- **Confirmed staff routing:** FastTrack "-Green" / "-Red" overnight staff
  switch to that Main team at 01:00, when FastTrack closes, until 07:00. Staff
  move; patient demand never does.
- **No new patients before closing (intake cutoffs):** Blue from 20:00 (shift
  ends 23:00), FastTrack from midnight (closes 01:00), and teams added by the
  tools in the last 3 h of their coverage unless another attending continues
  it. The team then adds no capacity against demand. Staffing plan only.

All of these (except resident supervision and ERU's one-attending maximum)
are editable in the Staffing plan's Operational coverage section and are
saved with scenarios; the defaults live in `DEFAULT_OPERATIONAL_COVERAGE`.
- Main needs an attending 24/7; ERU has its current dedicated windows and at
  most one attending at a time; FastTrack is closed 01:00–07:00.

All numbers are modeled estimates (demand = historical patients roomed per
hour; capacity = assumed rates), not observed throughput, wait times or
clinical staffing requirements.

