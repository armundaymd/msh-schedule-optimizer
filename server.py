"""
FastAPI backend for ED Staffing Dashboard.
Run: uvicorn server:app --reload --port 8000
"""

import hmac
import os
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from pydantic import BaseModel
from sqlalchemy import select
from pipeline import run_pipeline, load_processed, RawDataError, ShrinkError
from db import get_engine, init_schema, read_schedule_df, schedule_rows, scenarios
from staffing.model import Instance as StaffingInstance
from staffing.service import solve as solve_staffing_plan

app = FastAPI()

# Comma-separated list of allowed origins, set via env var in Coolify, e.g.
# CORS_ORIGINS=https://schedule.adamrmunday.com
_extra_origins = [
    o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173", *_extra_origins],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"
engine = get_engine()
init_schema(engine)


@app.get("/api/demand")
def api_demand():
    return load_processed(engine, "demand")


@app.get("/api/summary")
def api_summary():
    return load_processed(engine, "summary")


@app.get("/api/demand-ci")
def api_demand_ci():
    try:
        return load_processed(engine, "demand_ci")
    except FileNotFoundError:
        return {"status": "not_run"}


@app.get("/api/validation")
def api_validation():
    try:
        return load_processed(engine, "validation")
    except FileNotFoundError:
        return {"status": "not_run"}


@app.get("/api/schedule")
def api_schedule():
    return schedule_rows(read_schedule_df(engine))


# Refresh rebuilds every processed output from the raw CSVs in THIS server's
# data/raw/, so on a server whose data/raw/ is empty or stale it would
# overwrite good data. It is therefore OFF unless an ADMIN_TOKEN environment
# variable is set, and then every request must send that token in the
# X-Admin-Token header. Production normally leaves ADMIN_TOKEN unset (data is
# updated by loading data/processed/ instead — see README).
def configured_admin_token():
    return os.environ.get("ADMIN_TOKEN") or None


def authorize_refresh(given, configured):
    if not configured:
        raise HTTPException(status_code=403, detail="Refresh data is disabled on this server (no ADMIN_TOKEN configured).")
    if not given or not hmac.compare_digest(given.encode(), configured.encode()):
        raise HTTPException(status_code=401, detail="Wrong admin password — refresh not run.")


@app.get("/api/refresh-status")
def api_refresh_status():
    return {"enabled": configured_admin_token() is not None}


@app.post("/api/refresh")
def api_refresh(force: bool = False, x_admin_token: str | None = Header(default=None)):
    authorize_refresh(x_admin_token, configured_admin_token())
    try:
        summary = run_pipeline(raw_dir=DATA_DIR / "raw", engine=engine, force=force)
        return {"status": "ok", "summary": summary}
    except ShrinkError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except RawDataError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


VALID_VERSIONS = ("legacy", "v2")


class ScenarioIn(BaseModel):
    version: str
    name: str
    payload: dict


@app.get("/api/scenarios")
def api_list_scenarios(version: str):
    if version not in VALID_VERSIONS:
        raise HTTPException(status_code=400, detail="version must be 'legacy' or 'v2'")
    with engine.connect() as conn:
        rows = conn.execute(
            select(scenarios)
            .where(scenarios.c.version == version)
            .order_by(scenarios.c.created_at.desc())
        ).mappings().all()
    return [dict(r) for r in rows]


@app.post("/api/scenarios")
def api_create_scenario(body: ScenarioIn):
    if body.version not in VALID_VERSIONS:
        raise HTTPException(status_code=400, detail="version must be 'legacy' or 'v2'")
    new_id = str(uuid.uuid4())
    with engine.begin() as conn:
        conn.execute(scenarios.insert().values(
            id=new_id, version=body.version, name=body.name, payload=body.payload,
        ))
        row = conn.execute(select(scenarios).where(scenarios.c.id == new_id)).mappings().first()
    return dict(row)


@app.get("/api/scenarios/{scenario_id}")
def api_get_scenario(scenario_id: str):
    with engine.connect() as conn:
        row = conn.execute(select(scenarios).where(scenarios.c.id == scenario_id)).mappings().first()
    if row is None:
        raise HTTPException(status_code=404, detail="scenario not found")
    return dict(row)


@app.delete("/api/scenarios/{scenario_id}")
def api_delete_scenario(scenario_id: str):
    with engine.begin() as conn:
        result = conn.execute(scenarios.delete().where(scenarios.c.id == scenario_id))
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail="scenario not found")
    return {"status": "ok"}


# Staffing resource allocation (staffing/). The frontend builds the instance
# (demand, capacity tables from shared/capacity.js, locks, rules); this only
# solves it. Plain `def` so FastAPI runs the CPU-bound solve in a worker
# thread instead of blocking the event loop.
@app.post("/api/staffing-plan")
def api_staffing_plan(instance: StaffingInstance):
    return solve_staffing_plan(instance)
