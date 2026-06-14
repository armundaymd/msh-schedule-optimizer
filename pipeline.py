"""
pipeline.py — Data ingestion and processing for ED Staffing Dashboard

DROP NEW EXCEL FILES INTO:  data/raw/
UPDATE SCHEDULE CSV AT:     data/Current_Schedule_Block.csv

Then either restart app.py or click "Refresh Data" in the dashboard.
"""

import pandas as pd
import numpy as np
import json
from pathlib import Path


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
    """Load all .xlsx files from raw_dir, deduplicate on CSN."""
    files = sorted(raw_dir.glob("*.xlsx"))
    if not files:
        raise FileNotFoundError(f"No .xlsx files found in {raw_dir}")

    dfs = []
    for f in files:
        try:
            df = pd.read_excel(f, dtype={"CSN": str, "Visit ID/CSN": str})
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
    df["arr_dt"]    = pd.to_datetime(df["Arrv Date/Time"], errors="coerce")
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

    # Team start time = arrival + time to first attending
    df["att_delay_mins"] = pd.to_numeric(df["Arrival to 1st Attending"], errors="coerce")
    df["team_start_dt"]  = df["arr_dt"] + pd.to_timedelta(df["att_delay_mins"], unit="m")

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

def compute_demand(df: pd.DataFrame) -> dict:
    """
    Patients assigned to each team per hour, averaged by DOW then overall.
    Returns dict suitable for JSON serialisation.
    """
    # Days per DOW (for averaging)
    days_per_dow = (
        df[["dow","date"]].drop_duplicates()
        .groupby("dow")["date"].count()
        .reindex(range(7), fill_value=1)
    )

    teams = ["Main", "FastTrack", "ERU"]
    result = {}

    for team in teams:
        sub = df[df["sim_team"] == team]

        # Overall hourly average
        hourly = sub.groupby("team_hour").size().reindex(range(24), fill_value=0)
        total_days = len(df["date"].unique())
        overall = (hourly / total_days).round(3).tolist()

        # By DOW
        by_dow = {}
        for dow in range(7):
            sub_dow = sub[sub["dow"] == dow]
            h = sub_dow.groupby("team_hour").size().reindex(range(24), fill_value=0)
            n = max(days_per_dow[dow], 1)
            by_dow[DOW_NAMES[dow]] = (h / n).round(3).tolist()

        result[team] = {"overall": overall, "by_dow": by_dow}

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


def load_schedule(sched_csv: Path) -> list:
    """Parse schedule CSV into list of shift dicts."""
    df = pd.read_csv(sched_csv)
    team_norm = {"Green":"Main","Red":"Main","Blue":"Main","FastTrack":"FastTrack","ERU":"ERU"}
    df["team_norm"] = df["team"].map(team_norm)
    df = df.dropna(subset=["team_norm"])

    shifts = []
    for _, row in df.iterrows():
        shifts.append({
            "day":       row["day_type"],
            "team":      row["team_norm"],
            "role_type": row["role_type"],
            "start":     row["start_time"],
            "end":       row["end_time"],
        })
    return shifts


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(raw_dir: Path, sched_csv: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)

    print("\n=== ED Data Pipeline ===")

    # 1. Load and clean encounters
    raw = load_raw_encounters(raw_dir)
    df  = clean_encounters(raw)

    # 2. Compute outputs
    demand  = compute_demand(df)
    svc     = compute_service_params(df)
    summary = compute_summary(df)
    sched   = load_schedule(sched_csv)

    # 3. Save JSON
    with open(out_dir / "demand.json", "w") as f:
        json.dump(demand, f, indent=2)
    with open(out_dir / "service_params.json", "w") as f:
        json.dump(svc, f, indent=2)
    with open(out_dir / "summary.json", "w") as f:
        json.dump(summary, f, indent=2, default=str)
    with open(out_dir / "schedule.json", "w") as f:
        json.dump(sched, f, indent=2)

    print(f"\nPipeline complete. Outputs written to {out_dir}")
    print(f"  {summary['total_encounters']:,} encounters | {summary['unique_days']} days | {summary['date_range']}")
    return summary


def load_processed(path: Path) -> dict:
    """Load a processed JSON file."""
    with open(path) as f:
        return json.load(f)
