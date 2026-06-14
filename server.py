"""
FastAPI backend for ED Staffing Dashboard.
Run: uvicorn server:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import json, csv
from pathlib import Path
from pipeline import run_pipeline, load_processed

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = Path(__file__).parent / "data"


@app.get("/api/demand")
def api_demand():
    return load_processed(DATA_DIR / "processed" / "demand.json")


@app.get("/api/summary")
def api_summary():
    path = DATA_DIR / "processed" / "summary.json"
    with open(path) as f:
        return json.load(f)


@app.get("/api/schedule")
def api_schedule():
    path = DATA_DIR / "Current_Schedule_Block.csv"
    shifts = []
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            shifts.append({
                "day":         row["day_type"],
                "team":        row["team"],
                "role_type":   row["role_type"],
                "role_detail": row["role_detail"],
                "start_time":  row["start_time"],
                "end_time":    row["end_time"],
            })
    return shifts


@app.post("/api/refresh")
def api_refresh():
    try:
        summary = run_pipeline(
            raw_dir=DATA_DIR / "raw",
            sched_csv=DATA_DIR / "Current_Schedule_Block.csv",
            out_dir=DATA_DIR / "processed",
        )
        return {"status": "ok", "summary": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
