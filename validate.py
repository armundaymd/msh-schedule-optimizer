"""
validate.py — Statistical validation for ED demand and service time models.

Outputs (written to the pipeline_outputs table in Postgres):
  validation  — GOF tests, service time fits, empirical PPH
  demand_ci   — bootstrap 95% CIs on hourly demand curves

Usage:
  python3 validate.py
"""

import warnings
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

from db import get_engine, read_schedule_df
from pipeline import load_raw_encounters, clean_encounters, save_output, DOW_NAMES

warnings.filterwarnings("ignore", category=RuntimeWarning)

RAW_DIR = Path("data/raw")

TEAMS = ["Main", "FastTrack", "ERU"]
SCHED_TEAM_MAP = {
    "Green": "Main", "Red": "Main", "Blue": "Main",
    "FastTrack": "FastTrack", "ERU": "ERU",
}
TIME_WINDOWS = {
    "Night_23_07":   list(range(23, 24)) + list(range(0, 7)),
    "Morning_07_11": list(range(7, 11)),
    "Day_11_19":     list(range(11, 19)),
    "Evening_19_23": list(range(19, 23)),
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _fit_dist(dist, data):
    """Fit distribution with loc fixed at 0; return (params, AIC, log-likelihood)."""
    params = dist.fit(data, floc=0)
    ll = float(np.sum(dist.logpdf(data, *params)))
    aic = 4.0 - 2.0 * ll   # k=2: shape + scale (loc pinned)
    return params, aic, ll


def _ad_statistic(data, dist, params):
    """Generic Anderson-Darling test statistic for any scipy continuous dist."""
    n = len(data)
    x = np.sort(data).astype(float)
    F = np.clip(dist.cdf(x, *params), 1e-10, 1 - 1e-10)
    i = np.arange(1, n + 1)
    A2 = -n - np.sum((2 * i - 1) * (np.log(F) + np.log(1 - F[::-1]))) / n
    return float(A2)


# ── A: Poisson GOF ───────────────────────────────────────────────────────────

def run_poisson_gof(df: pd.DataFrame) -> dict:
    """Chi-square GOF test for Poisson arrivals per (team, DOW, hour) cell."""
    date_to_dow = df.drop_duplicates("date").set_index("date")["dow"].to_dict()
    all_dates_by_dow = {
        dow: [d for d, v in date_to_dow.items() if v == dow]
        for dow in range(7)
    }

    results = []
    for team in TEAMS:
        sub_team = df[df["sim_team"] == team]
        for dow in range(7):
            dow_dates = all_dates_by_dow[dow]
            n_days = len(dow_dates)
            if n_days < 5:
                continue

            sub_dow = sub_team[sub_team["dow"] == dow]

            for hour in range(24):
                # Daily patient count for this (team, dow, hour) cell
                sub_cell = sub_dow[sub_dow["team_hour"] == hour]
                daily_cts = (
                    sub_cell.groupby("date").size()
                    .reindex(dow_dates, fill_value=0)
                    .values.astype(float)
                )

                if daily_cts.sum() < 10:
                    continue

                lam = float(daily_cts.mean())
                var = float(np.var(daily_cts, ddof=1))
                overdispersion = var / lam if lam > 0 else 1.0

                # Frequency table for chi-square GOF
                max_k = int(daily_cts.max())
                ks = np.arange(0, max_k + 1)
                obs = np.array([(daily_cts == k).sum() for k in ks], dtype=float)
                exp = np.array([stats.poisson.pmf(k, lam) * n_days for k in ks])

                # Merge sparse expected bins (< 5) from edges inward
                while len(exp) > 2 and exp[-1] < 5:
                    exp[-2] += exp[-1]; obs[-2] += obs[-1]
                    exp = exp[:-1]; obs = obs[:-1]
                while len(exp) > 2 and exp[0] < 5:
                    exp[1] += exp[0]; obs[1] += obs[0]
                    exp = exp[1:]; obs = obs[1:]

                if len(exp) < 2:
                    continue

                # Normalize expected to same total as observed (Poisson tail truncated)
                exp = exp * obs.sum() / exp.sum()
                chi2_stat, p_val = stats.chisquare(obs, exp, ddof=1)

                results.append({
                    "team": team,
                    "dow": DOW_NAMES[dow],
                    "hour": hour,
                    "n_days": int(n_days),
                    "total_patients": int(daily_cts.sum()),
                    "lambda": round(lam, 3),
                    "variance": round(var, 3),
                    "overdispersion_ratio": round(overdispersion, 3),
                    "chi2_stat": round(float(chi2_stat), 4),
                    "p_value": round(float(p_val), 4),
                    "passes_poisson": bool(p_val > 0.05),
                    "is_overdispersed": bool(overdispersion > 1.5),
                })

    n_tested = len(results)
    n_pass   = sum(r["passes_poisson"] for r in results)
    n_od     = sum(r["is_overdispersed"] for r in results)
    med_od   = float(np.median([r["overdispersion_ratio"] for r in results])) if results else 0.0
    pct_pass = round(100 * n_pass / n_tested, 1) if n_tested else 0.0

    summary = {
        "cells_tested": n_tested,
        "cells_passing_poisson": n_pass,
        "pct_passing": pct_pass,
        "cells_overdispersed": n_od,
        "pct_overdispersed": round(100 * n_od / n_tested, 1) if n_tested else 0.0,
        "median_overdispersion_ratio": round(med_od, 3),
        "interpretation": (
            f"{pct_pass}% of (team, DOW, hour) cells pass Poisson GOF (χ² p>0.05). "
            f"Median overdispersion ratio = {round(med_od, 3)} "
            f"({'Poisson model appropriate' if med_od < 1.5 else 'Negative Binomial may better capture variability'})."
        ),
    }
    return {"cells": results, "summary": summary}


# ── B: Service time distribution fitting ─────────────────────────────────────

def run_service_time_fits(df: pd.DataFrame) -> dict:
    """Fit Lognormal, Weibull, Gamma to service times per (team, acuity)."""
    results = []
    best_fit_counts = {"lognormal": 0, "weibull": 0, "gamma": 0}

    for (team, acuity), grp in df.groupby(["sim_team", "acuity"]):
        data = grp["service_mins"].values.astype(float)
        if len(data) < 30:
            continue

        try:
            ln_params, ln_aic, _ = _fit_dist(stats.lognorm,     data)
            wb_params, wb_aic, _ = _fit_dist(stats.weibull_min, data)
            ga_params, ga_aic, _ = _fit_dist(stats.gamma,       data)
        except Exception:
            continue

        aics = {"lognormal": ln_aic, "weibull": wb_aic, "gamma": ga_aic}
        best = min(aics, key=aics.get)
        best_fit_counts[best] += 1

        # Anderson-Darling for best-fit distribution
        if best == "lognormal":
            log_data = np.log(data[data > 0])
            ad_res   = stats.anderson(log_data, dist="norm")
            ad_stat  = float(ad_res.statistic)
            ad_cv5   = float(ad_res.critical_values[2])  # index 2 → 5%
        else:
            dist_obj  = stats.weibull_min if best == "weibull" else stats.gamma
            best_params = wb_params if best == "weibull" else ga_params
            ad_stat  = _ad_statistic(data, dist_obj, best_params)
            ad_cv5   = 0.749  # standard composite-hypothesis critical value at 5%

        passes_ad = bool(ad_stat < ad_cv5)

        # Mann-Whitney U: admitted vs discharged
        is_admitted = grp["ED Disch Disposition"].str.contains("Admit", case=False, na=False)
        adm_times   = grp.loc[is_admitted,  "service_mins"].values
        dis_times   = grp.loc[~is_admitted, "service_mins"].values
        mw = None
        if len(adm_times) >= 5 and len(dis_times) >= 5:
            mw_stat, mw_p = stats.mannwhitneyu(adm_times, dis_times, alternative="two-sided")
            mw = {
                "stat": round(float(mw_stat), 1),
                "p_value": round(float(mw_p), 4),
                "n_admitted": int(len(adm_times)),
                "n_discharged": int(len(dis_times)),
                "admitted_median_mins": round(float(np.median(adm_times)), 1),
                "discharged_median_mins": round(float(np.median(dis_times)), 1),
                "median_diff_mins": round(float(np.median(adm_times) - np.median(dis_times)), 1),
                "significant": bool(mw_p < 0.05),
                "interpretation": (
                    f"Admitted patients stay {round(float(np.median(adm_times) - np.median(dis_times)), 1)} min "
                    f"longer (median); difference {'is' if mw_p < 0.05 else 'is NOT'} statistically significant "
                    f"(Mann-Whitney p={round(float(mw_p), 4)})."
                ),
            }

        results.append({
            "team": team,
            "acuity": int(acuity),
            "n": int(len(data)),
            "mean_mins": round(float(data.mean()), 1),
            "median_mins": round(float(np.median(data)), 1),
            "std_mins": round(float(data.std()), 1),
            "best_fit": best,
            "lognormal_aic": round(float(ln_aic), 2),
            "weibull_aic": round(float(wb_aic), 2),
            "gamma_aic": round(float(ga_aic), 2),
            "ad_statistic": round(ad_stat, 4),
            "ad_critical_5pct": round(ad_cv5, 4),
            "passes_ad_5pct": passes_ad,
            "admitted_vs_discharged": mw,
        })

    n_tested  = len(results)
    n_pass_ad = sum(r["passes_ad_5pct"] for r in results)
    pct_ad    = round(100 * n_pass_ad / n_tested, 1) if n_tested else 0.0

    summary = {
        "groups_tested": n_tested,
        "best_fit_counts": best_fit_counts,
        "pct_passing_ad": pct_ad,
        "interpretation": (
            f"Tested {n_tested} (team, acuity) groups (n≥30). "
            f"Best-fit: lognormal {best_fit_counts['lognormal']}, "
            f"Weibull {best_fit_counts['weibull']}, Gamma {best_fit_counts['gamma']}. "
            f"{pct_ad}% pass Anderson-Darling at 5% significance."
        ),
    }
    return {"groups": results, "summary": summary}


# ── C: Empirical PPH ─────────────────────────────────────────────────────────

def run_empirical_pph(df: pd.DataFrame, engine) -> dict:
    """
    Observed PPH = dispositions per attended hour, empirically from data.
    Uses schedule to determine which hours had attending coverage per team.
    """
    sched = read_schedule_df(engine)
    sched["team_norm"] = sched["team"].map(SCHED_TEAM_MAP)
    attending = sched[(sched["role_type"] == "Attending") & sched["team_norm"].notna()]

    # {(dow_name, team_norm, hour): attending_count}
    att_count: dict[tuple, int] = {}
    for _, row in attending.iterrows():
        sh = int(str(row["start_time"]).split(":")[0])
        eh = int(str(row["end_time"]).split(":")[0])
        hours = list(range(sh, eh)) if eh > sh else list(range(sh, 24)) + list(range(0, eh))
        for h in hours:
            k = (row["day_type"], row["team_norm"], h)
            att_count[k] = att_count.get(k, 0) + 1

    # Date → DOW name, count dates per DOW
    date_dow_name = (
        df.drop_duplicates("date")
        .set_index("date")["dow"]
        .map(lambda x: DOW_NAMES[x])
        .to_dict()
    )
    dow_date_counts: dict[str, int] = {}
    for dow_name in date_dow_name.values():
        dow_date_counts[dow_name] = dow_date_counts.get(dow_name, 0) + 1

    results = {}
    for team in TEAMS:
        sub = df[df["sim_team"] == team].copy()
        sub["dispo_hour"] = sub["dispo_dt"].dt.hour.astype("Int64")

        hourly = []
        for hour in range(24):
            total_att_hrs = sum(
                att_count.get((dow_name, team, hour), 0) * n_dates
                for dow_name, n_dates in dow_date_counts.items()
            )
            total_slots = sum(
                n_dates
                for dow_name, n_dates in dow_date_counts.items()
                if att_count.get((dow_name, team, hour), 0) > 0
            )
            total_dispo = int((sub["dispo_hour"] == hour).sum())

            hourly.append({
                "hour": hour,
                "pph_per_slot":      round(total_dispo / total_slots,   3) if total_slots   > 0 else None,
                "pph_per_attending": round(total_dispo / total_att_hrs, 3) if total_att_hrs > 0 else None,
                "total_dispo": total_dispo,
                "total_attended_slots":   int(total_slots),
                "total_attending_hours":  int(total_att_hrs),
            })

        # Aggregate by time window (using pph_per_attending)
        windows = {}
        for win_name, win_hours in TIME_WINDOWS.items():
            vals = [h["pph_per_attending"] for h in hourly
                    if h["hour"] in win_hours and h["pph_per_attending"] is not None]
            if vals:
                windows[win_name] = {
                    "mean":  round(float(np.mean(vals)),             3),
                    "sd":    round(float(np.std(vals)),              3),
                    "p10":   round(float(np.percentile(vals, 10)),   3),
                    "p25":   round(float(np.percentile(vals, 25)),   3),
                    "p50":   round(float(np.percentile(vals, 50)),   3),
                    "p75":   round(float(np.percentile(vals, 75)),   3),
                    "p90":   round(float(np.percentile(vals, 90)),   3),
                }

        # Overall summary per team
        all_vals = [h["pph_per_attending"] for h in hourly if h["pph_per_attending"] is not None]
        results[team] = {
            "overall_mean_pph": round(float(np.mean(all_vals)), 3) if all_vals else None,
            "overall_p50_pph":  round(float(np.median(all_vals)), 3) if all_vals else None,
            "by_time_window":   windows,
            "hourly":           hourly,
        }

    return results


# ── D: Bootstrap confidence intervals ────────────────────────────────────────

def run_bootstrap_ci(df: pd.DataFrame, n_boot: int = 1000) -> dict:
    """Bootstrap 95% CI on mean hourly demand per (team, [dow])."""
    all_dates = sorted(df["date"].unique())
    n_dates   = len(all_dates)
    date_idx  = {d: i for i, d in enumerate(all_dates)}

    date_to_dow = df.drop_duplicates("date").set_index("date")["dow"].to_dict()
    dow_indices = {
        dow: np.array([i for i, d in enumerate(all_dates) if date_to_dow[d] == dow])
        for dow in range(7)
    }

    rng = np.random.default_rng(42)
    demand_ci = {}

    for team in TEAMS:
        sub = df[df["sim_team"] == team].copy()
        sub["date_idx_col"] = sub["date"].map(date_idx).astype(int)
        sub["team_hour"]    = sub["team_hour"].astype(int)

        # Build count matrix (n_dates × 24) via pivot
        pivot = (
            sub.groupby(["date_idx_col", "team_hour"])
            .size()
            .unstack(fill_value=0)
            .reindex(index=range(n_dates), columns=range(24), fill_value=0)
        )
        mat = pivot.values.astype(np.float32)   # (n_dates, 24)

        # Vectorised overall bootstrap
        idx_mat = rng.integers(0, n_dates, size=(n_boot, n_dates))
        boot    = mat[idx_mat].mean(axis=1)      # (n_boot, 24)

        overall_ci = [
            {
                "mean":    round(float(mat[:, h].mean()), 3),
                "ci_low":  round(float(np.percentile(boot[:, h], 2.5)),  3),
                "ci_high": round(float(np.percentile(boot[:, h], 97.5)), 3),
            }
            for h in range(24)
        ]
        cv = [
            round(float(mat[:, h].std() / mat[:, h].mean()), 3)
            if mat[:, h].mean() > 0 else 0.0
            for h in range(24)
        ]

        # Bootstrap by DOW
        by_dow_ci = {}
        for dow in range(7):
            didx  = dow_indices[dow]
            n_dow = len(didx)
            if n_dow < 5:
                continue
            dow_mat  = mat[didx]
            idx_dow  = rng.integers(0, n_dow, size=(n_boot, n_dow))
            boot_dow = dow_mat[idx_dow].mean(axis=1)   # (n_boot, 24)

            by_dow_ci[DOW_NAMES[dow]] = [
                {
                    "mean":    round(float(dow_mat[:, h].mean()), 3),
                    "ci_low":  round(float(np.percentile(boot_dow[:, h], 2.5)),  3),
                    "ci_high": round(float(np.percentile(boot_dow[:, h], 97.5)), 3),
                }
                for h in range(24)
            ]

        demand_ci[team] = {
            "overall_ci": overall_ci,
            "by_dow_ci":  by_dow_ci,
            "cv":         cv,
            "n_days":     int(n_dates),
        }

    return demand_ci


# ── Main ─────────────────────────────────────────────────────────────────────

def run_validation(raw_dir: Path = RAW_DIR, engine=None) -> dict:
    if engine is None:
        engine = get_engine()

    print("\n=== ED Statistical Validation ===")

    # Load data
    print("\nLoading encounters…")
    raw = load_raw_encounters(raw_dir)
    df  = clean_encounters(raw)

    # A: Poisson GOF
    print("A) Running Poisson GOF tests…")
    poisson_results = run_poisson_gof(df)
    print(f"   → {poisson_results['summary']['cells_tested']} cells tested, "
          f"{poisson_results['summary']['pct_passing']}% pass")

    # B: Service time fits
    print("B) Fitting service time distributions…")
    svc_results = run_service_time_fits(df)
    print(f"   → {svc_results['summary']['groups_tested']} groups, "
          f"best-fit: {svc_results['summary']['best_fit_counts']}")

    # C: Empirical PPH
    print("C) Computing empirical PPH…")
    pph_results = run_empirical_pph(df, engine)
    for team in TEAMS:
        print(f"   → {team}: overall mean PPH = {pph_results[team]['overall_mean_pph']}")

    # D: Bootstrap CI
    print("D) Running bootstrap CIs (1000 resamples)…")
    demand_ci = run_bootstrap_ci(df, n_boot=1000)
    print("   → Done")

    # Build output
    validation = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "data_summary": {
            "n_encounters": int(len(df)),
            "n_days":       int(df["date"].nunique()),
            "date_range":   f"{df['arr_dt'].min().date()} → {df['arr_dt'].max().date()}",
        },
        "poisson_gof":       poisson_results,
        "service_time_fits": svc_results,
        "empirical_pph":     pph_results,
    }

    save_output(engine, "validation", validation)
    save_output(engine, "demand_ci", demand_ci)

    print("\nOutputs written to Postgres (validation, demand_ci).")

    # Human-readable console summary
    print("\n" + "─" * 60)
    print("SUMMARY")
    print("─" * 60)
    print(f"\nPoisson GOF:\n  {poisson_results['summary']['interpretation']}")
    print(f"\nService Time:\n  {svc_results['summary']['interpretation']}")
    print("\nEmpirical PPH (per attending per hour):")
    for team in TEAMS:
        print(f"  {team}:")
        for win, vals in pph_results[team]["by_time_window"].items():
            print(f"    {win}: mean={vals['mean']}, p50={vals['p50']}, p90={vals['p90']}")
    print("─" * 60)

    return validation


if __name__ == "__main__":
    run_validation()
