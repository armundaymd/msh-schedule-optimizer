"""Guards against the two ways a refresh silently lost data: Excel-mangled CSNs
collapsing under dedup, and a refresh replacing a large dataset with a small one."""

import pandas as pd
import pytest

import pipeline
from pipeline import RawDataError, ShrinkError, check_csns, run_pipeline


def test_scientific_notation_csns_are_rejected():
    df = pd.DataFrame({"CSN": ["1.0023E+11", "1.00238E+11", "1.0023E+11"]})
    with pytest.raises(RawDataError, match="scientific notation"):
        check_csns(df, "export.csv")


def test_normal_csns_pass():
    check_csns(pd.DataFrame({"CSN": ["100231234567", "100231234568"]}), "export.csv")


def _write_csv(path, n):
    rows = [{
        "CSN": str(100230000000 + i), "Arrived": "6/1/26 00:12", "Roomed": "6/1/26 00:28",
        "First Non-PIT ED Team": "Green", "Acuity Abbr": 3,
        "Dispo Selected": "6/1/26 01:34", "ED Disch Disposition": "Discharge",
    } for i in range(n)]
    pd.DataFrame(rows).to_csv(path, index=False)


def test_refresh_refuses_to_shrink_stored_data_unless_forced(tmp_path, monkeypatch):
    _write_csv(tmp_path / "small.csv", 10)
    monkeypatch.setattr(pipeline, "load_processed",
                        lambda engine, key: {"total_encounters": 62658, "date_range": "old"})
    with pytest.raises(ShrinkError, match="62,658"):
        run_pipeline(tmp_path, engine=None)

    saved = []
    monkeypatch.setattr(pipeline, "load_schedule", lambda engine: [])
    monkeypatch.setattr(pipeline, "save_output", lambda engine, key, payload: saved.append(key))
    run_pipeline(tmp_path, engine=None, force=True)
    assert "summary" in saved
