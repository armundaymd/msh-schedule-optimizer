# ED Staffing Optimizer — Mount Sinai Adult ED

Interactive dashboard for modeling patients-per-hour (PPH) capacity
against observed demand by team and time of day.

---

## Setup (one time)

```bash
pip install flask pandas numpy openpyxl
```

---

## Running the dashboard

```bash
cd ed_staffing
python app.py
```

Then open **http://localhost:5050** in your browser.

---

## Adding new data

1. Drop new `.xlsx` files (same column format) into `data/raw/`
2. Either:
   - Restart `app.py`, or
   - Click **↻ Refresh data** in the dashboard header

The pipeline will automatically deduplicate on CSN across all files,
so you can drop in overlapping exports without double-counting.

---

## Updating the schedule

Replace `data/Current_Schedule_Block.csv` with an updated version
(same column format), then refresh data.

---

## Project structure

```
ed_staffing/
├── app.py              ← Flask web server (run this)
├── pipeline.py         ← Data ingestion and processing
├── data/
│   ├── raw/            ← DROP NEW EXCEL FILES HERE
│   ├── processed/      ← Auto-generated JSON (do not edit)
│   └── Current_Schedule_Block.csv
└── templates/
    └── index.html      ← Dashboard UI
```

---

## Dashboard controls

| Control | What it does |
|---------|-------------|
| Max PPH sliders | Set the realistic ceiling for each team type |
| Team count sliders | Adjust attendings per time window |
| Day of week filter | Show demand for a specific DOW vs overall average |
| Quick scenarios | Snap to predefined staffing configurations |
| Team tabs | Switch between Main / Fast Track / ERU views |

**Red bars** = demand exceeds capacity at that hour.
**Blue line** = current capacity ceiling (teams × max PPH).

The summary table bottom-left shows status across all time windows at a glance.
