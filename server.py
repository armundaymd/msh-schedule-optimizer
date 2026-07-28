"""
FastAPI backend for ED Staffing Dashboard.
Run: uvicorn server:app --reload --port 8000
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
from pipeline import run_pipeline, load_processed
from db import get_engine, init_schema, read_schedule_df

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:4173"],
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


@app.get("/api/schedule")
def api_schedule():
    df = read_schedule_df(engine)
    return [
        {
            "day":         row["day_type"],
            "team":        row["team"],
            "role_type":   row["role_type"],
            "role_detail": row["role_detail"],
            "start_time":  row["start_time"],
            "end_time":    row["end_time"],
        }
        for _, row in df.iterrows()
    ]


@app.post("/api/refresh")
def api_refresh():
    try:
        summary = run_pipeline(raw_dir=DATA_DIR / "raw", engine=engine)
        return {"status": "ok", "summary": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
