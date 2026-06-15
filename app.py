"""
ED Staffing Optimization Dashboard
Mount Sinai Adult ED

Run:  python app.py
Then: open http://localhost:5050
"""

from flask import Flask, render_template, jsonify, request
import json, os
from pathlib import Path
from pipeline import run_pipeline, load_processed

app = Flask(__name__)
DATA_DIR = Path(__file__).parent / "data"


@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/demand")
def api_demand():
    df = load_processed(DATA_DIR / "processed" / "demand.json")
    return jsonify(df)

@app.route("/api/schedule")
def api_schedule():
    path = DATA_DIR / "processed" / "schedule.json"
    with open(path) as f:
        return jsonify(json.load(f))

@app.route("/api/summary")
def api_summary():
    path = DATA_DIR / "processed" / "summary.json"
    with open(path) as f:
        return jsonify(json.load(f))

@app.route("/api/demand-ci")
def api_demand_ci():
    path = DATA_DIR / "processed" / "demand_ci.json"
    if not path.exists():
        return jsonify({"status": "not_run"})
    with open(path) as f:
        return jsonify(json.load(f))

@app.route("/api/validation")
def api_validation():
    path = DATA_DIR / "processed" / "validation.json"
    if not path.exists():
        return jsonify({"status": "not_run"})
    with open(path) as f:
        return jsonify(json.load(f))

@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    try:
        summary = run_pipeline(
            raw_dir   = DATA_DIR / "raw",
            sched_csv = DATA_DIR / "Current_Schedule_Block.csv",
            out_dir   = DATA_DIR / "processed",
        )
        return jsonify({"status": "ok", "summary": summary})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    processed = DATA_DIR / "processed" / "demand.json"
    if not processed.exists():
        print("Processing data on first run...")
        run_pipeline(
            raw_dir   = DATA_DIR / "raw",
            sched_csv = DATA_DIR / "Current_Schedule_Block.csv",
            out_dir   = DATA_DIR / "processed",
        )
    print("\n  ED Staffing Dashboard running at http://localhost:5050\n")
    app.run(debug=True, port=5050)
