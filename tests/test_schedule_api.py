"""Regression: /api/schedule must return resident_level (validation finding).

Before the fix the endpoint dropped the column, so every resident was priced
at the PGY-2 fallback rate by frontend/src/shared/capacity.js.
"""

import json
import math

import pandas as pd

from db import schedule_rows


def test_schedule_rows_include_resident_level_and_are_valid_json():
    df = pd.DataFrame([
        {"id": 1, "day_type": "Monday", "team": "Green", "role_type": "Resident", "role_detail": "Senior",
         "resident_level": "PGY-4", "start_time": "07:00", "end_time": "19:00"},
        {"id": 2, "day_type": "Monday", "team": "Green", "role_type": "Attending", "role_detail": "Attending",
         "resident_level": math.nan, "start_time": "07:00", "end_time": "15:00"},
    ])
    rows = schedule_rows(df)
    assert rows[0]["resident_level"] == "PGY-4"
    assert rows[1]["resident_level"] is None
    json.dumps(rows, allow_nan=False)  # what the web framework requires
