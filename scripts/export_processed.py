"""
Write the aggregated pipeline outputs from a database into data/processed/.

    python3 scripts/export_processed.py --dry-run   # show what would change
    python3 scripts/export_processed.py             # write the files

Reads the database named by DATABASE_URL (your LOCAL one, via .env) and
writes demand, demand_ci, schedule, service_params, summary and validation
as data/processed/<key>.json — the committed snapshot that seeds production
(README → "Updating production data") and feeds frontend/analysis/.

Only aggregated outputs are written (hourly counts, distributions,
service-time fits, the staff schedule); raw patient-level exports never
leave data/raw/.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

KEYS = ("demand", "demand_ci", "schedule", "service_params", "summary", "validation")
OUT = ROOT / "data" / "processed"
IDENTIFIER_FIELDS = ('"CSN"', '"MRN"', '"Patient"', '"patient_name"')


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="report what would change; write nothing")
    args = parser.parse_args(argv)

    from db import get_engine
    from pipeline import load_processed

    engine = get_engine()
    print(f"Database: {engine.url.render_as_string(hide_password=True)}")
    payloads = {}
    for key in KEYS:
        try:
            payloads[key] = load_processed(engine, key)
        except FileNotFoundError:
            print(f"ERROR: no '{key}' row in pipeline_outputs — run the pipeline and validate.py first.")
            return 1

    s = payloads["summary"]
    print(f"Summary: {s.get('total_encounters'):,} encounters, {s.get('date_range')}, {s.get('unique_days')} days")
    v = payloads["validation"].get("data_summary", {})
    if v.get("n_encounters") != s.get("total_encounters") or v.get("date_range") != s.get("date_range"):
        print(f"ERROR: validation ({v}) was computed on different data from summary — re-run validate.py first.")
        return 1

    for key, payload in payloads.items():
        text = json.dumps(payload, indent=2) + "\n"
        if any(f in text for f in IDENTIFIER_FIELDS):
            print(f"ERROR: {key} contains an identifier-like field; refusing to write it.")
            return 1
        path = OUT / f"{key}.json"
        old = path.read_text() if path.exists() else None
        if old is not None and json.loads(old) == payload:
            print(f"  {key}: unchanged")
            continue
        print(f"  {key}: {'would update' if args.dry_run else 'updated'} ({len(text):,} bytes)")
        if not args.dry_run:
            path.write_text(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
