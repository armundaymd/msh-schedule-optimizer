"""
migrate_schedule_to_db.py — One-time load of data/Current_Schedule_Block.csv
into the schedule_shifts table on Postgres.

Run this once after standing up the Render Postgres database:

    python migrate_schedule_to_db.py

Re-running replaces whatever is currently in schedule_shifts, so it's safe
to use again after editing the CSV — just don't run it after the schedule
has since been edited directly in the database.
"""

from pathlib import Path

import pandas as pd

from db import get_engine, init_schema, schedule_shifts

CSV_PATH = Path(__file__).parent / "data" / "Current_Schedule_Block.csv"


def main():
    engine = get_engine()
    init_schema(engine)

    df = pd.read_csv(CSV_PATH, encoding="utf-8-sig")
    df = df[["day_type", "team", "role_type", "role_detail", "resident_level", "start_time", "end_time"]]

    records = df.to_dict(orient="records")
    for r in records:
        for k, v in r.items():
            if isinstance(v, float) and pd.isna(v):  # NaN -> None so it inserts as SQL NULL
                r[k] = None

    with engine.begin() as conn:
        conn.execute(schedule_shifts.delete())
        conn.execute(schedule_shifts.insert(), records)

    print(f"Loaded {len(df):,} shifts from {CSV_PATH.name} into schedule_shifts.")


if __name__ == "__main__":
    main()
