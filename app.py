"""
ED Staffing Optimization Dashboard
Mount Sinai Adult ED

Run:  python app.py
Then: open http://localhost:5050
"""

from flask import Flask, render_template, jsonify, request
from flask_cors import CORS
from pathlib import Path
from pipeline import run_pipeline, load_processed
from db import get_engine, init_schema

app = Flask(__name__)
CORS(app, origins=[
    "https://msh-schedule-optimizer-1.onrender.com",
    "http://localhost:5173",
])
DATA_DIR = Path(__file__).parent / "data"
engine = get_engine()
init_schema(engine)


@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/demand")
def api_demand():
    return jsonify(load_processed(engine, "demand"))

@app.route("/api/schedule")
def api_schedule():
    return jsonify(load_processed(engine, "schedule"))

@app.route("/api/summary")
def api_summary():
    return jsonify(load_processed(engine, "summary"))

@app.route("/api/demand-ci")
def api_demand_ci():
    try:
        return jsonify(load_processed(engine, "demand_ci"))
    except FileNotFoundError:
        return jsonify({"status": "not_run"})

@app.route("/api/validation")
def api_validation():
    try:
        return jsonify(load_processed(engine, "validation"))
    except FileNotFoundError:
        return jsonify({"status": "not_run"})

@app.route("/api/refresh", methods=["POST"])
def api_refresh():
    try:
        summary = run_pipeline(raw_dir=DATA_DIR / "raw", engine=engine)
        return jsonify({"status": "ok", "summary": summary})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 500


if __name__ == "__main__":
    try:
        load_processed(engine, "demand")
    except FileNotFoundError:
        print("Processing data on first run...")
        run_pipeline(raw_dir=DATA_DIR / "raw", engine=engine)
    print("\n  ED Staffing Dashboard running at http://localhost:5050\n")
    app.run(debug=True, port=5050)
