"""
Deterministic tests for the staffing allocation optimizer (staffing/).

Capacity tables here are built with the same per-team rule as
frontend/src/shared/capacity.js — min(ceiling*n, own*n + extenders) + solo —
which is the frontend's job in production; the solver itself is rule-agnostic.
"""

import time

import pytest

from staffing.model import Instance
from staffing.service import solve

DAYS7 = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
PATTERNS_3x8 = [{"start": 0, "length": 8}, {"start": 8, "length": 8}, {"start": 16, "length": 8}]


def series(value=0.0, hours=range(24)):
    s = [0.0] * 24
    for h in hours:
        s[h % 24] = value
    return s


def slot(sid, ceiling, own, *, extenders=None, solo=None, locked=None, max_att=1, flex=False, ndays=1):
    """One slot with a capacity table for n = 0..max_att attendings."""
    ext = extenders or series(0)
    sol = solo or series(0)
    lock = locked or [0] * 24
    top = max(max_att, max(lock))

    def cap(h, n):
        return sol[h] + (min(ceiling * n, own * n + ext[h]) if n > 0 else 0)

    return {
        "id": sid, "flex": flex,
        "locked": [list(lock) for _ in range(ndays)],
        "maxAttendings": [[max(max_att, lock[h]) for h in range(24)] for _ in range(ndays)],
        "capacity": [[[cap(h, n) for n in range(top + 1)] for h in range(24)] for _ in range(ndays)],
    }


def area(key, demand, slots, *, min_cov=None, tolerance=1.0, ndays=1):
    per_day = demand if isinstance(demand[0], list) else [demand] * ndays
    return {
        "key": key,
        "demand": per_day,
        "excessTolerance": [[max(tolerance, 0.25 * d) for d in day] for day in per_day],
        "minCoverage": [list(min_cov or [0] * 24) for _ in range(ndays)],
        "slots": slots,
    }


def inst(areas, *, budget=None, mode="budget", patterns=PATTERNS_3x8, locked_hours=0, days=None, **kw):
    return Instance(
        mode=mode, days=days or ["Monday"], patterns=patterns, areas=areas,
        budgetHours=budget, lockedHours=locked_hours, workers=kw.pop("workers", 8), **kw,
    )


def hours_by_area(result):
    out = {}
    for s in result.shifts:
        out[s.area] = out.get(s.area, 0) + s.length
    return out


def assert_within_budget(r, i):
    assert r.hours.total <= i.budgetHours + 1e-9
    assert sum(s.length for s in r.shifts) == pytest.approx(r.hours.optimized)


# A Main team whose one attending covers exactly 2.0 PPH (ceiling 2, residents
# supply the rest), against flat 2.0 PPH demand all day.
def main_flat(budget, **kw):
    a = area("main", series(2.0), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    return inst([a], budget=budget, **kw)


# 1
def test_budget_exactly_sufficient():
    i = main_flat(24)
    r = solve(i)
    assert r.status == "optimal"
    assert r.hours.optimized == 24 and r.hours.unallocated == 0
    assert r.objective["deficitPphHours"] == 0
    assert_within_budget(r, i)


# 2
def test_budget_insufficient():
    i = main_flat(16)
    r = solve(i)
    assert r.status == "optimal"
    assert r.hours.optimized == 16
    assert r.objective["deficitPphHours"] == pytest.approx(16.0)   # 8 uncovered hours x 2.0
    assert_within_budget(r, i)


# 3
def test_more_hours_than_useful_are_left_unallocated():
    i = main_flat(100)
    r = solve(i)
    assert r.hours.optimized == 24
    assert r.hours.unallocated == pytest.approx(76)
    assert r.objective["deficitPphHours"] == 0


def test_fractional_budget_is_reported_not_rounded_away():
    i = main_flat(10_000 / 52)   # 192.307... h/week
    r = solve(i)
    assert r.hours.budget == pytest.approx(192.3077, abs=1e-4)
    assert r.hours.usableBudget == 192.0          # half-hour granularity, rounded DOWN
    assert r.hours.unallocated == pytest.approx(192.3077 - 24, abs=1e-4)


# 4
def test_hours_go_where_demand_is_larger():
    day = range(8, 16)
    main = area("main", series(2.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    eru = area("eru", series(0.5, day), [slot("ERU", 1.0, 1.0)])
    r = solve(inst([main, eru], budget=8))
    assert hours_by_area(r) == {"main": 8}


# 5
def test_eru_excess_cannot_hide_a_main_deficit():
    day = range(8, 16)
    # ERU already has a locked attending covering 4 PPH against zero demand —
    # the pooled Main + ERU total (4 >= 2) looks covered. Main has nobody.
    eru = area("eru", series(0.0), [slot("ERU", 4.0, 4.0, locked=[1 if h in day else 0 for h in range(24)])])
    main = area("main", series(2.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    r = solve(inst([main, eru], budget=16, locked_hours=8))
    assert hours_by_area(r) == {"main": 8}
    assert r.objective["deficitPphHours"] == 0
    assert r.modeledCapacity["main"][0][10] == pytest.approx(2.0)


# 6
def test_locked_coverage_consumes_budget():
    locked = [1 if 0 <= h < 8 else 0 for h in range(24)]
    a = area("main", series(2.0), [slot("Green", 2.0, 1.0, extenders=series(1.0), locked=locked)])
    i = inst([a], budget=16, locked_hours=8)
    r = solve(i)
    assert r.hours.locked == 8 and r.hours.optimized == 8 and r.hours.total == 16
    assert r.objective["deficitPphHours"] == pytest.approx(16.0)   # one 8h block still uncovered
    assert_within_budget(r, i)


def test_locked_hours_over_budget_is_a_clear_infeasibility():
    locked = [1] * 24
    a = area("main", series(2.0), [slot("Green", 2.0, 1.0, extenders=series(1.0), locked=locked)])
    r = solve(inst([a], budget=20, locked_hours=24))
    assert r.status == "infeasible"
    assert "exceeds" in r.message and r.shifts == []


def test_minimum_coverage_beyond_budget_reports_hours_needed():
    a = area("eru", series(0.0), [slot("ERU", 1.0, 1.0)], min_cov=[1] * 24)
    r = solve(inst([a], budget=16))
    assert r.status == "infeasible"
    assert r.diagnosis["requiredHours"] == 24
    assert "at least 24" in r.message


def test_minimum_coverage_is_honoured_even_without_demand():
    a = area("eru", series(0.0), [slot("ERU", 1.0, 1.0)], min_cov=[1 if 8 <= h < 16 else 0 for h in range(24)])
    r = solve(inst([a], budget=40))
    assert [(s.start, s.length) for s in r.shifts] == [(8, 8)]


# 7
def test_overnight_shift_covers_across_midnight():
    night = [23, 0, 1, 2, 3, 4, 5, 6]
    a = area("main", series(2.0, night), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    patterns = [{"start": 7, "length": 8}, {"start": 15, "length": 8}, {"start": 23, "length": 8}]
    r = solve(inst([a], budget=8, patterns=patterns))
    assert [(s.start, s.length) for s in r.shifts] == [(23, 8)]
    assert r.objective["deficitPphHours"] == 0


# 8
def test_resident_supervision_raises_attending_value():
    day = range(8, 16)
    # Same ceiling (2.0), but only Green has residents to supervise; Red's
    # attending alone manages own throughput (1.0).
    green = slot("Green", 2.0, 1.0, extenders=series(1.5))
    red = slot("Red", 2.0, 1.0)
    a = area("main", series(2.0, day), [green, red])
    r = solve(inst([a], budget=8))
    assert [(s.slot, s.start) for s in r.shifts] == [("Green", 8)]
    assert r.objective["deficitPphHours"] == 0


# 9
def test_fasttrack_solo_pa_capacity_needs_no_attending():
    day = range(8, 16)
    ft = slot("FastTrack", 3.5, 2.2, solo=series(1.5, day))
    a = area("fasttrack", series(1.5, day), [ft])
    r = solve(inst([a], budget=24))
    assert r.shifts == [] and r.objective["deficitPphHours"] == 0


def test_fasttrack_attending_added_on_top_of_solo_pa():
    day = range(8, 16)
    ft = slot("FastTrack", 3.5, 2.2, solo=series(1.5, day))
    a = area("fasttrack", series(3.5, day), [ft])
    r = solve(inst([a], budget=24))
    assert [(s.start, s.length) for s in r.shifts] == [(8, 8)]
    assert r.modeledCapacity["fasttrack"][0][9] == pytest.approx(1.5 + 2.2)


def test_existing_team_preferred_over_new_team_when_equivalent():
    # Validation S09 regression: FastTrack PA's with-attending rate is 0, so an
    # attending adds the same 2.2/hr on the FastTrack team or on a new team.
    # The existing team must win the tie.
    day = range(8, 16)
    ft = slot("FastTrack", 3.5, 2.2, solo=series(1.5, day))
    flex = slot("fasttrack:flex", 3.5, 2.2, max_att=3, flex=True)
    a = area("fasttrack", series(3.7, day), [ft, flex])
    r = solve(inst([a], budget=24))
    assert [(s.slot, s.start) for s in r.shifts] == [("FastTrack", 8)]


def test_new_team_kept_when_existing_team_is_not_an_exact_tie():
    # Green is busy (locked attending all day), so the second attending must
    # stay on a new team; the post-pass may only move pure ties.
    day = range(8, 16)
    green = slot("Green", 2.0, 1.0, extenders=series(1.0), locked=[1] * 24)
    flex = slot("main:flex", 2.0, 1.0, max_att=3, flex=True)
    a = area("main", series(3.0, day), [green, flex])
    r = solve(inst([a], budget=48, locked_hours=24))
    assert [(s.slot, s.start) for s in r.shifts] == [("main:flex", 8)]
    assert r.modeledCapacity["main"][0][9] == pytest.approx(3.0)


def test_severe_deficits_are_prioritised_over_mild_ones():
    day = range(8, 16)
    # One 8h shift, two areas. Each attending adds 1.0 PPH either way, but
    # "b" is 4.0 short (severe) while "a" is 1.0 short (mild/moderate).
    a = area("main", series(1.0, day), [slot("Green", 1.0, 1.0)])
    b = area("eru", series(4.0, day), [slot("ERU", 1.0, 1.0)])
    r = solve(inst([a, b], budget=8))
    assert hours_by_area(r) == {"eru": 8}


# 10
def test_combined_main_eru():
    day = range(8, 16)
    main = area("main", series(2.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0)), slot("Red", 2.0, 1.0)])
    eru = area("eru", series(0.8, day), [slot("ERU", 0.8, 0.6, extenders=series(0.5))])
    i = inst([main, eru], budget=16)
    r = solve(i)
    assert hours_by_area(r) == {"main": 8, "eru": 8}
    assert r.objective["deficitPphHours"] == 0
    assert_within_budget(r, i)


def test_flex_pool_adds_new_teams_when_named_teams_are_full():
    day = range(8, 16)
    green = slot("Green", 2.0, 1.0, extenders=series(1.0))
    flex = slot("main:flex", 2.0, 1.0, max_att=3, flex=True)
    a = area("main", series(3.0, day), [green, flex])
    r = solve(inst([a], budget=16))
    assert sorted((s.slot, s.start) for s in r.shifts) == [("Green", 8), ("main:flex", 8)]
    assert r.modeledCapacity["main"][0][9] == pytest.approx(3.0)   # 2.0 + own 1.0


# 11 + performance
def whole_ed_week(budget, workers=8):
    """Realistic-shape whole-ED week: 3 areas, 7 teams incl. flex pools,
    any-start 8/10/12h patterns, demand with a daytime peak."""
    import math
    nd = 7
    def curve(peak, trough):
        return [trough + (peak - trough) * max(0.0, math.sin(math.pi * (h - 6) / 18)) for h in range(24)]
    week = lambda peak, trough, weekend=1.0: [[v * (weekend if d >= 5 else 1.0) for v in curve(peak, trough)] for d in range(nd)]
    main = area("main", week(14, 4, 0.9), [
        slot("Green", 2.1, 1.3, extenders=series(1.6), ndays=nd),
        slot("Red", 2.1, 1.3, extenders=series(1.9), ndays=nd),
        slot("Blue", 2.1, 1.3, extenders=series(0.8), ndays=nd),
        slot("main:flex", 2.1, 1.3, max_att=3, flex=True, ndays=nd),
    ], ndays=nd, min_cov=[1] * 24)
    ft = area("fasttrack", week(6, 0, 1.1), [
        slot("FastTrack", 3.5, 2.2, solo=series(1.2, range(8, 23)), ndays=nd),
        slot("fasttrack:flex", 3.5, 2.2, max_att=3, flex=True, ndays=nd),
    ], ndays=nd)
    eru = area("eru", week(1.2, 0.4), [
        slot("ERU", 0.8, 0.6, extenders=series(0.5), ndays=nd),
        slot("eru:flex", 0.8, 0.6, max_att=3, flex=True, ndays=nd),
    ], ndays=nd, min_cov=[1 if 8 <= h < 20 else 0 for h in range(24)])
    patterns = [{"start": s, "length": L} for L in (8, 10, 12) for s in range(24)]
    return inst([main, ft, eru], budget=budget, patterns=patterns, days=DAYS7, workers=workers)


def test_whole_ed_week_respects_budget_and_rules():
    i = whole_ed_week(600)
    t0 = time.perf_counter()
    r = solve(i)
    elapsed = time.perf_counter() - t0
    print(f"\nwhole-ED week: status={r.status} solve={r.stats['solveSeconds']}s wall={elapsed:.2f}s "
          f"vars={r.stats['variables']} cons={r.stats['constraints']} gap={r.stats['relativeGap']} "
          f"hours={r.hours.total} deficit={r.objective['deficitPphHours']}")
    assert r.status in ("optimal", "feasible")
    assert_within_budget(r, i)
    by = hours_by_area(r)
    assert set(by) <= {"main", "fasttrack", "eru"} and by.get("main", 0) > by.get("eru", 0)
    # min coverage: Main always has an attending; ERU 08-20.
    for d in range(7):
        for h in range(24):
            n_main = sum(1 for s in r.shifts if s.area == "main" and s.day == DAYS7[d]
                         and h in [(s.start + k) % 24 for k in range(s.length)])
            assert n_main >= 1
    assert elapsed < 30


def test_whole_ed_minimum_rules_beyond_annual_budget_are_diagnosed():
    # 10,000 h/yr = 192.3 h/week, but Main 24/7 (168 h) + ERU 08-20 (84 h)
    # already need 252 h/week.
    r = solve(whole_ed_week(10_000 / 52))
    assert r.status == "infeasible"
    assert r.diagnosis["requiredHours"] == 252


def test_budget_never_exceeded_across_budgets():
    for b in (0, 7.5, 8, 23.9, 24, 31, 1000):
        i = main_flat(b)
        r = solve(i)
        assert r.status == "optimal"
        assert r.hours.total <= b + 1e-9


# 12
def test_same_inputs_give_the_same_plan():
    # Parallel (8 workers) and feasible, so this exercises deterministic
    # search rather than two identical empty results.
    i = whole_ed_week(600)
    a, b = solve(i), solve(i)
    # The point is reproducibility, not proving optimality within the search
    # budget; the plan must still be demonstrably close to the best possible.
    assert a.status in ("optimal", "feasible") and a.shifts
    assert a.stats["relativeGap"] < 0.01
    assert a.objective == b.objective
    key = lambda r: sorted((s.area, s.slot, s.day, s.start, s.length) for s in r.shifts)
    assert key(a) == key(b)


# Mode B
def test_requirement_mode_finds_minimum_hours_for_zero_deficit():
    r = solve(main_flat(None, mode="requirement"))
    assert r.status == "optimal"
    assert r.hours.total == 24 and r.hours.unallocated is None
    assert r.objective["deficitPphHours"] == 0


def test_requirement_mode_allows_a_residual_deficit():
    # 2.0 demand, 1 attending = 2.0; allowing 2.0 PPH short means no hours needed.
    r = solve(main_flat(None, mode="requirement", allowedDeficitPph=2.0))
    assert r.hours.total == 0


def test_invalid_shapes_are_rejected():
    with pytest.raises(ValueError):
        Instance(mode="budget", days=["Monday"], patterns=PATTERNS_3x8, budgetHours=8,
                 areas=[{"key": "main", "demand": [[0] * 23], "excessTolerance": [[0] * 24],
                         "minCoverage": [[0] * 24], "slots": []}])
