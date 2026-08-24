"""
scripts/dev_seed_percentiles.py

DEV DATA, NOT REAL PERCENTILES.

Synthesises p50/p75/p90 demand percentiles from the mean and CV already
present in the local Postgres 'demand'/'demand_ci' pipeline outputs, assuming
a negative binomial distribution with the observed mean and variance
(variance = (CV * mean) ** 2, falling back to Poisson when that isn't
overdispersed). This exists ONLY so the frontend's percentile UI can be
built and tested without raw CSVs (data/raw/ is gitignored and normally
absent in dev). It must NEVER be run against production: refuses to run
unless DATABASE_URL points at localhost, and only ever writes to that
database.

When real raw CSVs are available (in data/raw/), re-run the actual pipeline
instead (python3 pipeline.py / the /api/refresh route) so percentiles come
from real per-day counts, not this approximation.

Run:
    python3 scripts/dev_seed_percentiles.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scipy.stats import nbinom, poisson

from db import get_engine
from pipeline import load_processed, save_output, DOW_NAMES

BANNER = (
    "\n" + "=" * 70 +
    "\nDEV DATA, NOT REAL PERCENTILES"
    "\nSynthesised from mean + CV via negative binomial approximation."
    "\nDo not treat these as empirical. Re-run the real pipeline once raw"
    "\nCSVs are available." +
    "\n" + "=" * 70 + "\n"
)

# Mirrors pipeline.py's MIN_DOW_DAYS_FOR_PCT — by-DOW percentiles need at
# least this many days to be worth showing.
MIN_DOW_DAYS_FOR_PCT = 20


def _require_localhost(engine) -> None:
    host = engine.url.host or ""
    if host not in ("localhost", "127.0.0.1"):
        raise RuntimeError(
            f"DATABASE_URL host is {host!r}, not localhost. This script writes "
            "SYNTHETIC data and must only ever run against a local dev database. "
            "Stopping."
        )


def _nb_percentiles(mean: float, cv: float) -> dict:
    """p50/p75/p90 of a negative binomial with the given mean and CV
    (std/mean). Falls back to Poisson when the data isn't overdispersed
    (var <= mean), since a negative binomial isn't defined there."""
    if mean <= 0:
        return {50: 0.0, 75: 0.0, 90: 0.0}
    var = (cv * mean) ** 2
    if var <= mean:
        return {p: float(poisson.ppf(p / 100, mean)) for p in (50, 75, 90)}
    n_shape = mean ** 2 / (var - mean)
    p_param = n_shape / (n_shape + mean)
    return {p: float(nbinom.ppf(p / 100, n_shape, p_param)) for p in (50, 75, 90)}


def _percentiles_by_hour(means: list, cvs: list) -> dict:
    out = {f"p{p}": [] for p in (50, 75, 90)}
    for h in range(24):
        vals = _nb_percentiles(means[h], cvs[h] if cvs else 0.0)
        for p in (50, 75, 90):
            out[f"p{p}"].append(round(vals[p], 3))
    return out


def main():
    engine = get_engine()
    _require_localhost(engine)

    print(BANNER)

    demand = load_processed(engine, "demand")
    demand_ci = load_processed(engine, "demand_ci")

    for team, payload in demand.items():
        team_ci = demand_ci.get(team, {})
        cv = team_ci.get("cv", [0.0] * 24)
        n_days = team_ci.get("n_days", 0)

        pct_overall = _percentiles_by_hour(payload["overall"], cv)

        # The committed reference files don't carry per-DOW day counts or a
        # per-DOW CV, so this approximates: days spread evenly across DOWs,
        # and the overall CV reused for every DOW. Dev fallback only — not
        # meant to be accurate, just present so the UI has something to show.
        approx_n_per_dow = round(n_days / 7) if n_days else 0
        pct_by_dow = {}
        n_days_by_dow = {}
        for dow_name in DOW_NAMES:
            n_days_by_dow[dow_name] = approx_n_per_dow
            if approx_n_per_dow < MIN_DOW_DAYS_FOR_PCT:
                continue
            dow_means = payload.get("by_dow", {}).get(dow_name)
            if not dow_means:
                continue
            pct_by_dow[dow_name] = _percentiles_by_hour(dow_means, cv)

        payload["pct"] = {"overall": pct_overall, "by_dow": pct_by_dow}
        payload["n_days"] = n_days
        payload["n_days_by_dow"] = n_days_by_dow

    save_output(engine, "demand", demand)

    print(f"Wrote synthetic percentiles for {list(demand.keys())} to the local 'demand' pipeline output.")
    print(BANNER)


if __name__ == "__main__":
    main()
