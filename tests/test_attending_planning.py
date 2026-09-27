"""
Attending staffing planning modes (staffing/service.py): fixed budget,
coverage / unmet targets (overall and per area), minimum practical
requirement, warm starts, and the structural rules each mode must keep.

Synthetic known-answer instances, built with the same per-team capacity rule
as frontend/src/shared/capacity.js (see test_staffing_optimizer.py).
"""

import pytest

from staffing.model import Instance
from staffing.service import TARGET_INFEASIBLE, solve
from test_staffing_optimizer import PATTERNS_3x8, area, inst, series, slot

ANY_8 = [{"start": h, "length": 8} for h in range(24)]


def main_flat(**kw):
    """Main, flat 2.0 PPH all day (48 patient-h); one attending on Green
    covers exactly 2.0 (ceiling 2, solo 1, residents 1)."""
    a = area("main", series(2.0), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    return inst([a], **kw)


def on_duty(result, key, h):
    return sum(1 for s in result.shifts if s.area == key and h in [(s.start + i) % 24 for i in range(s.length)])


# ── 1 / 20: more budget never makes the best achievable objective worse ──────

def test_objective_is_monotonic_in_budget_with_warm_starts():
    day = range(6, 22)
    main = area("main", series(3.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0)),
                                           slot("main:flex", 2.0, 1.0, max_att=3, flex=True)])
    ft = area("fasttrack", series(2.0, range(10, 20)), [slot("FastTrack", 3.5, 2.2)])
    prev_obj, prev_unmet, hint = None, None, []
    for budget in (0, 8, 16, 24, 32, 40, 48, 64):
        r = solve(inst([main, ft], budget=budget, hint=hint))
        assert r.status == "optimal"
        assert r.hours.total <= budget + 1e-9
        if prev_obj is not None:
            assert r.stats["objectiveValue"] <= prev_obj + 1e-6
            assert r.objective["unmetPphHours"] <= prev_unmet + 1e-6
        prev_obj, prev_unmet = r.stats["objectiveValue"], r.objective["unmetPphHours"]
        hint = [{"area": s.area, "slot": s.slot, "day": s.day, "start": s.start, "length": s.length} for s in r.shifts]


# ── 2: fixed budget is a maximum, reported exactly ───────────────────────────

def test_fixed_budget_mode_respects_and_reports_the_budget():
    r = solve(main_flat(budget=20))
    assert r.hours.budget == 20 and r.hours.total <= 20
    assert r.hours.total == 16 and r.hours.unallocated == pytest.approx(4)
    assert r.objective["unmetPphHours"] == pytest.approx(16.0)
    assert r.objective["coverage"] == pytest.approx(32 / 48)


# ── 3: coverage target -> least discrete staffing reaching it ────────────────

@pytest.mark.parametrize("target, hours", [(0.30, 8), (0.60, 16), (2 / 3, 16), (0.67, 24), (1.0, 24)])
def test_target_coverage_finds_minimum_discrete_hours(target, hours):
    r = solve(main_flat(mode="target", targetCoverage=target))
    assert r.status == "optimal"
    assert r.hours.total == hours
    assert r.planning["hoursRequired"] == hours and r.planning["hoursProven"]
    assert r.objective["coverage"] >= target - 1e-9
    assert r.hours.budget is None and r.hours.unallocated is None


# ── 4: impossible target reported, never met by breaking a rule ──────────────

def test_impossible_target_is_reported_infeasible():
    # ERU: one attending at most, who covers 1.0 against 3.0 demand -> 33% best.
    eru = area("eru", series(3.0), [slot("ERU", 1.0, 1.0), slot("eru:flex", 1.0, 1.0, max_att=3, flex=True)])
    eru["maxCoverage"] = [[1] * 24]
    r = solve(inst([eru], mode="target", targetCoverage=0.5))
    assert r.status == "infeasible" and r.shifts == []
    assert r.message.startswith(TARGET_INFEASIBLE)
    best = r.planning["bestAchievable"]
    assert best["coverage"] == pytest.approx(1 / 3)
    assert best["proven"]
    assert r.planning["infeasibleReasons"]


# ── 5: unmet cap -> least staffing satisfying it ─────────────────────────────

@pytest.mark.parametrize("cap, hours", [(48, 0), (32, 8), (16, 16), (15.9, 24), (0, 24)])
def test_max_unmet_mode_finds_minimum_hours(cap, hours):
    r = solve(main_flat(mode="target", maxUnmetPph=cap))
    assert r.status == "optimal"
    assert r.hours.total == hours
    assert r.objective["unmetPphHours"] <= cap + 1e-9


# ── 6: ERU never exceeds one attending, whatever the target ──────────────────

def test_eru_max_one_holds_in_target_and_practical_modes():
    eru = area("eru", series(2.0, range(8, 20)), [slot("ERU", 1.0, 1.0), slot("eru:flex", 1.0, 1.0, max_att=3, flex=True)])
    eru["maxCoverage"] = [[1] * 24]
    main = area("main", series(2.0), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    for kw in ({"mode": "target", "areaTargetCoverage": {"main": 1.0}}, {"mode": "min_practical"}):
        r = solve(inst([main, eru], patterns=ANY_8, **kw))
        assert r.status in ("optimal", "feasible")
        assert all(on_duty(r, "eru", h) <= 1 for h in range(24))
        if kw["mode"] == "min_practical":
            assert on_duty(r, "eru", 12) == 1


# ── 11: minimum coverage rules stay hard in every mode ───────────────────────

def test_main_24h_minimum_holds_even_when_target_needs_less():
    a = area("main", series(2.0, range(8, 16)), [slot("Green", 2.0, 1.0, extenders=series(1.0))], min_cov=[1] * 24)
    for kw in ({"mode": "target", "targetCoverage": 0.1}, {"mode": "min_practical"},
               {"mode": "target", "maxUnmetPph": 100}):
        r = solve(inst([a], **kw))
        assert r.status == "optimal"
        assert all(on_duty(r, "main", h) >= 1 for h in range(24))
        assert r.hours.total == 24


# ── 12: closed hours take no attendings; their demand still counts ───────────

def test_fasttrack_closure_holds_and_its_demand_still_counts():
    closed = range(1, 7)
    ft_slot = slot("FastTrack", 3.5, 2.2)
    for d in range(1):
        for h in closed:
            ft_slot["maxAttendings"][d][h] = 0
    ft = area("fasttrack", series(1.0), [ft_slot])
    ft["coverageMode"] = [["CLOSED" if h in closed else "FLEXIBLE" for h in range(24)]]
    r = solve(inst([ft], patterns=ANY_8, mode="min_practical", practicalTolerancePct=0))
    assert r.status == "optimal"
    assert all(on_duty(r, "fasttrack", h) == 0 for h in closed)
    # 6 closed hours x 1.0 remain unmet, plus 2 more: one FastTrack attending
    # at a time and 8 h shifts that may not enter 01-07 can staff only 16 of
    # the 18 open hours (23:00-01:00 can't be reached) — best is 16/24.
    assert r.planning["bestAchievable"]["unmetPph"] == pytest.approx(8.0)
    assert r.objective["unmetPphHours"] == pytest.approx(8.0)
    r = solve(inst([ft], patterns=ANY_8, mode="target", targetCoverage=0.8))
    assert r.status == "infeasible" and r.message.startswith(TARGET_INFEASIBLE)


# ── 14: per-area targets ─────────────────────────────────────────────────────

def test_area_specific_targets():
    day = range(8, 16)
    main = area("main", series(2.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    ft = area("fasttrack", series(2.0, day), [slot("FastTrack", 2.0, 2.0)])
    # Main alone must be fully covered; FastTrack has no target.
    r = solve(inst([main, ft], mode="target", areaTargetCoverage={"main": 1.0}))
    assert r.status == "optimal" and r.hours.total == 8
    assert {s.area for s in r.shifts} == {"main"}
    # Overall 50% is met by either area; FastTrack >= 100% forces FastTrack.
    r = solve(inst([main, ft], mode="target", targetCoverage=0.5, areaTargetCoverage={"fasttrack": 1.0}))
    assert r.status == "optimal" and r.hours.total == 8
    assert {s.area for s in r.shifts} == {"fasttrack"}
    assert r.planning["capsPph"] == {"*": 16.0, "fasttrack": 0.0}
    # Both at 100%.
    r = solve(inst([main, ft], mode="target", areaTargetCoverage={"main": 1.0, "fasttrack": 1.0}))
    assert r.hours.total == 16
    with pytest.raises(ValueError):
        inst([main], mode="target", areaTargetCoverage={"eru": 0.9})


# ── 15 / 16: expanded shift structure ────────────────────────────────────────

def test_expanded_starts_cover_a_peak_the_current_menu_cannot_cover_efficiently():
    peak = range(12, 20)
    a = area("main", series(2.0, peak), [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    current = solve(inst([a], mode="target", targetCoverage=1.0, patterns=PATTERNS_3x8))
    expanded = solve(inst([a], mode="target", targetCoverage=1.0, patterns=ANY_8))
    assert current.hours.total == 16 and expanded.hours.total == 8
    assert [(s.start, s.length) for s in expanded.shifts] == [(12, 8)]
    # Same budget: the expanded menu covers more.
    c8 = solve(inst([a], budget=8, patterns=PATTERNS_3x8))
    e8 = solve(inst([a], budget=8, patterns=ANY_8))
    assert e8.objective["unmetPphHours"] < c8.objective["unmetPphHours"]


def test_expanded_structure_keeps_allowed_shift_lengths():
    menu = [{"start": h, "length": L} for h in range(24) for L in (8, 10, 12)]
    day = range(6, 23)
    a = area("main", series(3.0, day), [slot("Green", 2.0, 1.0, extenders=series(1.0)),
                                        slot("main:flex", 2.0, 1.0, max_att=3, flex=True)])
    for kw in ({"budget": 40}, {"mode": "target", "targetCoverage": 0.9}, {"mode": "min_practical"}):
        r = solve(inst([a], patterns=menu, **kw))
        assert r.status in ("optimal", "feasible") and r.shifts
        assert all(s.length in (8, 10, 12) and 0 <= s.start < 24 for s in r.shifts)


# ── Minimum practical requirement ────────────────────────────────────────────

def test_min_practical_stops_where_extra_hours_buy_only_tiny_gains():
    # 2.0 PPH 08-16 (16 patient-h) plus 0.1 PPH 16-24 (0.8 patient-h). Covering
    # the tail needs a whole extra 8 h shift for 0.8 patient-h (5% of demand).
    d = series(2.0, range(8, 16))
    for h in range(16, 24):
        d[h] = 0.1
    a = area("main", d, [slot("Green", 2.0, 1.0, extenders=series(1.0))])
    strict = solve(inst([a], mode="min_practical", practicalTolerancePct=0))
    loose = solve(inst([a], mode="min_practical", practicalTolerancePct=5))
    assert strict.hours.total == 16 and strict.objective["unmetPphHours"] == pytest.approx(0)
    assert loose.hours.total == 8 and loose.objective["unmetPphHours"] == pytest.approx(0.8)
    assert loose.planning["bestAchievable"]["unmetPph"] == pytest.approx(0)
    assert loose.planning["tolerancePph"] == pytest.approx(0.84)


def test_min_practical_does_not_assume_full_coverage_is_possible():
    # One attending at most, covering 1.0 of 3.0: best achievable is 1/3.
    eru = area("eru", series(3.0, range(8, 16)), [slot("ERU", 1.0, 1.0), slot("eru:flex", 1.0, 1.0, max_att=3, flex=True)])
    eru["maxCoverage"] = [[1] * 24]
    r = solve(inst([eru], mode="min_practical", practicalTolerancePct=0))
    assert r.status == "optimal" and r.hours.total == 8
    assert r.objective["coverage"] == pytest.approx(1 / 3)


# ── Instance validation ──────────────────────────────────────────────────────

def test_target_mode_needs_a_target():
    with pytest.raises(ValueError):
        main_flat(mode="target")


def test_hint_with_unknown_slot_is_ignored_safely():
    r = solve(main_flat(budget=8, hint=[{"area": "main", "slot": "Nope", "day": "Monday", "start": 0, "length": 8}]))
    assert r.status == "optimal" and r.hours.total == 8


def test_residents_are_inputs_only():
    # The instance carries residents only inside capacity tables; results
    # contain attending shifts only, and never alter the tables.
    i = main_flat(mode="target", targetCoverage=1.0)
    before = [s.capacity for a in i.areas for s in a.slots]
    r = solve(i)
    assert all(not hasattr(s, "role_type") for s in r.shifts)
    assert before == [s.capacity for a in i.areas for s in a.slots]
    assert isinstance(i, Instance)
