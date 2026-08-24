"""
pipeline.py — Data ingestion and processing for ED Staffing Dashboard

DROP NEW EXCEL FILES INTO:  data/raw/
UPDATE THE SCHEDULE VIA:    schedule_shifts table (Render Postgres)

Then either restart the server or click "Refresh Data" in the dashboard.
"""

import math

import pandas as pd
import numpy as np
import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db import pipeline_outputs, read_schedule_df


# ── Constants ────────────────────────────────────────────────────────────────

EXCLUDE_TEAMS  = {"Pediatrics", "Psych"}
TEAM_MAP = {
    "Green": "Main", "Red": "Main", "Blue": "Main",
    "ERU Red": "ERU", "ERU Green": "ERU",
    "Fast Track": "FastTrack",
}
DOW_NAMES = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]


# ── Loaders ──────────────────────────────────────────────────────────────────

def load_raw_encounters(raw_dir: Path) -> pd.DataFrame:
    """Load all .csv files from raw_dir, deduplicate on CSN."""
    files = sorted(raw_dir.glob("*.csv"))
    if not files:
        raise FileNotFoundError(f"No .csv files found in {raw_dir}")

    dfs = []
    for f in files:
        try:
            df = pd.read_csv(f, dtype={"CSN": str})
            dfs.append(df)
            print(f"  Loaded {f.name}: {len(df):,} rows")
        except Exception as e:
            print(f"  WARNING: Could not load {f.name}: {e}")

    combined = pd.concat(dfs, ignore_index=True)
    before   = len(combined)
    combined = combined.drop_duplicates(subset="CSN")
    print(f"  Deduplication: {before:,} → {len(combined):,} rows")
    return combined


def clean_encounters(df: pd.DataFrame) -> pd.DataFrame:
    """Parse dates, filter to adult ED, compute service times."""

    # Parse timestamps
    arr_col = "Arrived" if "Arrived" in df.columns else "Arrv Date/Time"
    df["arr_dt"]    = pd.to_datetime(df[arr_col], errors="coerce")
    df["dispo_dt"]  = pd.to_datetime(df["Dispo Selected"], errors="coerce")
    df["roomed_dt"] = pd.to_datetime(df["Roomed"], errors="coerce")

    # Exclude pediatrics and psych
    df = df[~df["First Non-PIT ED Team"].isin(EXCLUDE_TEAMS)].copy()

    # Drop null acuity
    df = df.dropna(subset=["Acuity Abbr"])
    df["acuity"] = df["Acuity Abbr"].astype(int)

    # Team assignment using First Non-PIT ED Team
    df["sim_team"] = df["First Non-PIT ED Team"].map(TEAM_MAP)
    df = df.dropna(subset=["sim_team"])

    # Team start time = when the patient was roomed
    df["team_start_dt"] = df["roomed_dt"]

    # Service time: team_start → dispo
    df["service_mins"] = (df["dispo_dt"] - df["team_start_dt"]).dt.total_seconds() / 60
    df = df[(df["service_mins"] > 0) & (df["service_mins"] < 1440)]

    # Time fields for aggregation
    df["team_hour"] = df["team_start_dt"].dt.hour
    df["dow"]       = df["team_start_dt"].dt.dayofweek   # 0=Mon
    df["date"]      = df["team_start_dt"].dt.date

    print(f"  Clean encounters: {len(df):,} rows, "
          f"{df['date'].nunique()} unique days, "
          f"{df['arr_dt'].min().date()} → {df['arr_dt'].max().date()}")
    return df


# ── Aggregations ─────────────────────────────────────────────────────────────

def build_count_matrix(df: pd.DataFrame, team: str):
    """
    (n_dates, 24) matrix of per-hour patient counts for one team, one row per
    date in the FULL dataset's date range (so every team is compared against
    the same universe of days, including days that team saw zero patients).

    Returns (dates, mat, date_to_dow, dow_indices):
      dates       — sorted list of all dates in df, dates[i] is mat row i
      mat         — (n_dates, 24) float32 array of hourly counts
      date_to_dow — {date: dow} for every date in df
      dow_indices — {dow: np.array of row indices into mat for that DOW}

    Shared by compute_demand (means + percentiles) and run_bootstrap_ci
    (bootstrap CIs) so the pivot is only built once per team.
    """
    sub = df[df["sim_team"] == team].copy()
    all_dates = sorted(df["date"].unique())
    n_dates = len(all_dates)
    date_idx = {d: i for i, d in enumerate(all_dates)}
    sub["date_idx_col"] = sub["date"].map(date_idx).astype(int)
    sub["team_hour"] = sub["team_hour"].astype(int)

    pivot = (
        sub.groupby(["date_idx_col", "team_hour"])
        .size()
        .unstack(fill_value=0)
        .reindex(index=range(n_dates), columns=range(24), fill_value=0)
    )
    mat = pivot.values.astype(np.float32)

    date_to_dow = df.drop_duplicates("date").set_index("date")["dow"].to_dict()
    dow_indices = {
        dow: np.array([i for i, d in enumerate(all_dates) if date_to_dow[d] == dow])
        for dow in range(7)
    }
    return all_dates, mat, date_to_dow, dow_indices


def _percentiles_by_hour(mat: np.ndarray) -> dict:
    """Per-hour marginal percentile: for each hour independently, the Nth
    percentile of that hour's count across all rows (days) in `mat`."""
    return {
        f"p{p}": [round(float(np.percentile(mat[:, h], p, method="linear")), 3) for h in range(24)]
        for p in (50, 75, 90)
    }


# By-DOW percentiles need at least this many days to be statistically usable;
# below this, omit the DOW and let the frontend fall back to the overall
# percentile or the mean (see shared/demandSeries.js getDemandSeries).
MIN_DOW_DAYS_FOR_PCT = 20


def compute_demand(df: pd.DataFrame) -> dict:
    """
    Patients assigned to each team per hour, averaged by DOW then overall,
    plus per-hour marginal percentiles (p50/p75/p90) overall and by DOW.
    Returns dict suitable for JSON serialisation.
    """
    # Days per DOW (for averaging and for n_days_by_dow)
    days_per_dow = (
        df[["dow","date"]].drop_duplicates()
        .groupby("dow")["date"].count()
        .reindex(range(7), fill_value=1)
    )

    teams = ["Main", "FastTrack", "ERU"]
    result = {}
    total_days = len(df["date"].unique())

    for team in teams:
        sub = df[df["sim_team"] == team]

        # Overall hourly average
        hourly = sub.groupby("team_hour").size().reindex(range(24), fill_value=0)
        overall = (hourly / total_days).round(3).tolist()

        # By DOW
        by_dow = {}
        for dow in range(7):
            sub_dow = sub[sub["dow"] == dow]
            h = sub_dow.groupby("team_hour").size().reindex(range(24), fill_value=0)
            n = max(days_per_dow[dow], 1)
            by_dow[DOW_NAMES[dow]] = (h / n).round(3).tolist()

        # Percentiles, built off the same count matrix bootstrap CIs use
        dates, mat, _, dow_indices = build_count_matrix(df, team)
        pct_overall = _percentiles_by_hour(mat)
        pct_by_dow = {}
        for dow in range(7):
            didx = dow_indices[dow]
            if len(didx) < MIN_DOW_DAYS_FOR_PCT:
                continue
            pct_by_dow[DOW_NAMES[dow]] = _percentiles_by_hour(mat[didx])

        result[team] = {
            "overall": overall,
            "by_dow": by_dow,
            "pct": {"overall": pct_overall, "by_dow": pct_by_dow},
            "n_days": len(dates),
            "n_days_by_dow": {DOW_NAMES[d]: int(days_per_dow[d]) for d in range(7)},
        }

    return result


def compute_service_params(df: pd.DataFrame) -> dict:
    """Lognormal service time params by (team, acuity)."""

    def lognorm(mean, std):
        if std <= 0 or mean <= 0:
            return None, None
        s2 = np.log(1 + std**2 / mean**2)
        return round(np.log(mean) - s2/2, 4), round(np.sqrt(s2), 4)

    result = {}
    for (team, acuity), grp in df.groupby(["sim_team","acuity"]):
        m, s = grp["service_mins"].mean(), grp["service_mins"].std()
        mu, sigma = lognorm(m, s)
        result[f"{team}_{acuity}"] = {
            "team": team, "acuity": int(acuity),
            "count": len(grp), "mean": round(m,1), "median": round(grp["service_mins"].median(),1),
            "std": round(s,1), "ln_mu": mu, "ln_sigma": sigma,
        }
    return result


def compute_summary(df: pd.DataFrame) -> dict:
    """High-level stats shown in dashboard header."""
    return {
        "total_encounters": len(df),
        "date_range": f"{df['arr_dt'].min().date()} → {df['arr_dt'].max().date()}",
        "unique_days": int(df["date"].nunique()),
        "team_counts": df["sim_team"].value_counts().to_dict(),
        "acuity_dist": df["acuity"].value_counts().sort_index().to_dict(),
        "dispo_dist": df["ED Disch Disposition"].value_counts().head(6).to_dict(),
    }


def load_schedule(engine) -> list:
    """Load the shift schedule from the schedule_shifts table into shift dicts."""
    df = read_schedule_df(engine)
    valid_teams = {"Green", "Red", "Blue", "FastTrack", "ERU"}
    df = df[df["team"].isin(valid_teams)]

    shifts = []
    for _, row in df.iterrows():
        shifts.append({
            "day":        row["day_type"],
            "team":       row["team"],        # keep original name (Green/Red/Blue/FastTrack/ERU)
            "role_type":  row["role_type"],
            "role_detail": row.get("role_detail"),
            "resident_level": row.get("resident_level"),
            "start_time": row["start_time"],  # field name normalizeShifts expects
            "end_time":   row["end_time"],
        })
    return shifts


# ── Postgres I/O ─────────────────────────────────────────────────────────────

def _json_safe(obj):
    """Recursively convert to plain JSON-serializable types (mirrors the old
    json.dump(default=str)). Postgres JSONB rejects the NaN/Infinity tokens
    Python's json module allows by default, so those are mapped to null."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, (str, int, bool)) or obj is None:
        return obj
    if isinstance(obj, np.floating):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.ndarray):
        return _json_safe(obj.tolist())
    return str(obj)


def save_output(engine, key: str, payload) -> None:
    """Upsert one processed output (demand/summary/service_params/schedule/
    validation/demand_ci) into the pipeline_outputs table."""
    stmt = pg_insert(pipeline_outputs).values(key=key, payload=_json_safe(payload))
    stmt = stmt.on_conflict_do_update(
        index_elements=["key"],
        set_={"payload": stmt.excluded.payload, "generated_at": stmt.excluded.generated_at},
    )
    with engine.begin() as conn:
        conn.execute(stmt)


def load_processed(engine, key: str) -> dict:
    """Load one processed output (by key) from the pipeline_outputs table."""
    with engine.connect() as conn:
        row = conn.execute(
            select(pipeline_outputs.c.payload).where(pipeline_outputs.c.key == key)
        ).first()
    if row is None:
        raise FileNotFoundError(f"No pipeline output found for key={key!r}. Run the pipeline first.")
    return row[0]


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(raw_dir: Path, engine) -> dict:
    print("\n=== ED Data Pipeline ===")

    # 1. Load and clean encounters
    raw = load_raw_encounters(raw_dir)
    df  = clean_encounters(raw)

    # 2. Compute outputs
    demand  = compute_demand(df)
    svc     = compute_service_params(df)
    summary = compute_summary(df)
    sched   = load_schedule(engine)

    # 3. Save to Postgres
    save_output(engine, "demand", demand)
    save_output(engine, "service_params", svc)
    save_output(engine, "summary", summary)
    save_output(engine, "schedule", sched)

    print("\nPipeline complete. Outputs written to Postgres.")
    print(f"  {summary['total_encounters']:,} encounters | {summary['unique_days']} days | {summary['date_range']}")
    return summary
