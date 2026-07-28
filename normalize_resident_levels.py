"""
normalize_resident_levels.py — One-time best-effort migration of the free-text
Resident `role_detail` values in data/Current_Schedule_Block.csv into a
canonical `resident_level` column (PGY-1..4 / Off-Service).

Run:

    python normalize_resident_levels.py

Rewrites the CSV in place with the new `resident_level` column added, and
prints a report of every row whose mapping was ambiguous (combo/range values
like "EM2/3", or unrecognized text) so those can be hand-corrected afterward
via the schedule editor's level dropdown. Attending and PA rows are left
untouched (resident_level is left blank for them).

After running this, re-run migrate_schedule_to_db.py to push the updated
CSV (including resident_level) into Postgres.
"""

from pathlib import Path

import pandas as pd

CSV_PATH = Path(__file__).parent / "data" / "Current_Schedule_Block.csv"

# Confident, unambiguous mappings.
CONFIDENT_MAP = {
    "EM1": "PGY-1",
    "EM1-Green": "PGY-1",
    "EM2": "PGY-2",
    "EM2-Green": "PGY-2",
    "EM3": "PGY-3",
    "EM4": "PGY-4",
    "OS": "Off-Service",
    "OS-Green": "Off-Service",
}

# Ambiguous mappings — a defensible conservative guess, but flagged for review.
AMBIGUOUS_MAP = {
    "Senior": ("PGY-4", "assumed 'Senior' means most senior resident level"),
    "EM1/OS": ("Off-Service", "combo value — could be PGY-1 or Off-Service"),
    "EM1/OS-Red": ("Off-Service", "combo value — could be PGY-1 or Off-Service"),
    "EM1/2": ("PGY-1", "range value — picked conservative low end"),
    "EM2/3": ("PGY-2", "range value — picked conservative low end"),
    "EM3/4": ("PGY-3", "range value — picked conservative low end"),
    "EM3/4-Green": ("PGY-3", "range value — picked conservative low end"),
}


def map_level(role_detail: str):
    """Returns (level_or_None, flag_reason_or_None)."""
    if role_detail in CONFIDENT_MAP:
        return CONFIDENT_MAP[role_detail], None
    if role_detail in AMBIGUOUS_MAP:
        level, reason = AMBIGUOUS_MAP[role_detail]
        return level, reason
    return None, "unrecognized role_detail — needs manual assignment"


def main():
    df = pd.read_csv(CSV_PATH, encoding="utf-8-sig")

    if "resident_level" not in df.columns:
        df["resident_level"] = None

    flagged = []
    for idx, row in df.iterrows():
        if row["role_type"] != "Resident":
            continue
        level, reason = map_level(str(row["role_detail"]).strip())
        df.at[idx, "resident_level"] = level
        if reason:
            flagged.append({
                "row": idx + 2,  # +2: 1-indexed + header row
                "team": row["team"],
                "role_detail": row["role_detail"],
                "assigned_level": level,
                "reason": reason,
            })

    df.to_csv(CSV_PATH, index=False)
    print(f"Wrote resident_level for {(df['role_type'] == 'Resident').sum()} resident rows to {CSV_PATH.name}.")

    if flagged:
        print(f"\n{len(flagged)} row(s) flagged for manual review:")
        report = pd.DataFrame(flagged)
        print(report.to_string(index=False))
        report_path = CSV_PATH.parent / "ambiguous_resident_levels.csv"
        report.to_csv(report_path, index=False)
        print(f"\nReport also written to {report_path}")
    else:
        print("No ambiguous rows.")


if __name__ == "__main__":
    main()
