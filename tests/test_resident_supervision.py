"""
Resident supervision (confirmed operational rule, HARD): a team with a
resident on duty must have its own attending on. The frontend builds this as
each team slot's `minAttendings[d][h]` (after staff routing); the solver must
treat it as a hard lower bound in every mode, and report — never break — it
when it can't be met.

Synthetic known-answer instances (same helpers as test_staffing_optimizer.py).
"""

import pytest

from staffing.service import solve
from test_staffing_optimizer import PATTERNS_3x8, area, inst, series, slot


def supervised(sl, hours):
    """Slot dict with a resident on duty at `hours` (minAttendings = 1)."""
    sl["minAttendings"] = [[1 if h in hours else 0 for h in range(24)]]
    return sl


def on(result, slot_id, h):
    return sum(1 for s in result.shifts if s.slot == slot_id and h in [(s.start + i) % 24 for i in range(s.length)])


DAY = set(range(8, 16))       # residents on Green 08:00–16:00
EVENING = range(16, 24)       # where the demand is


def green_residents_evening_demand(**kw):
    """Demand only 16:00–24:00; Green's residents work 08:00–16:00."""
    g = supervised(slot("Green", 2.0, 1.0, extenders=series(1.0, DAY)), DAY)
    return area("main", series(2.0, EVENING), [g], **kw)


# 1: a resident shift forces supervising attending coverage on that team.
def test_resident_forces_an_attending_even_with_no_demand():
    g = supervised(slot("Green", 2.0, 1.0, extenders=series(1.0, DAY)), DAY)
    r = solve(inst([area("main", series(0.0), [g])], budget=24))
    assert r.status in ("optimal", "feasible")
    assert all(on(r, "Green", h) >= 1 for h in DAY)
    assert r.hours.total == 8          # only the supervision hours: no demand to meet


# 2: the allocator can't re-time attending coverage in a way that strands residents.
def test_budget_goes_to_supervision_before_demand_elsewhere_in_the_day():
    r = solve(inst([green_residents_evening_demand()], budget=8))
    assert r.status in ("optimal", "feasible")
    # Without the rule the one 8-hour shift would go to 16:00-24:00 (all the demand).
    assert all(on(r, "Green", h) >= 1 for h in DAY)
    assert all(on(r, "Green", h) == 0 for h in EVENING)


# 4: a resident on one team is not supervised by another team's attending
#    (nor by a new-team attending the planner adds).
def test_other_team_or_new_team_attending_does_not_supervise():
    green = slot("Green", 2.0, 1.0, extenders=series(1.0))                      # demand is here
    blue = supervised(slot("Blue", 2.0, 1.0, extenders=series(1.0, DAY)), DAY)  # residents here
    flex = slot("main:flex", 2.0, 1.0, max_att=3, flex=True)
    r = solve(inst([area("main", series(4.0, DAY), [green, blue, flex])], budget=8))
    assert r.status in ("optimal", "feasible")
    assert all(on(r, "Blue", h) >= 1 for h in DAY)


# 6: every planning mode keeps the rule.
@pytest.mark.parametrize("kw", [
    {"mode": "budget", "budget": 16},
    {"mode": "target", "targetCoverage": 0.5},
    {"mode": "target", "maxUnmetPph": 8.0},
    {"mode": "min_practical"},
    {"mode": "requirement", "allowedDeficitPph": 1.0},
])
def test_every_mode_keeps_resident_supervision(kw):
    r = solve(inst([green_residents_evening_demand()], **kw))
    assert r.status in ("optimal", "feasible"), r.message
    assert all(on(r, "Green", h) >= 1 for h in DAY)


def test_target_mode_is_still_the_minimum_hours_with_supervision():
    # 50% of 16 patient-h needs 8 h in the evening; supervision needs 8 h in the day.
    r = solve(inst([green_residents_evening_demand()], mode="target", targetCoverage=0.5))
    assert r.hours.total == 16 and r.planning["hoursProven"]


# 7: a budget too small for supervision is reported infeasible, never broken.
def test_budget_below_supervision_requirement_is_infeasible_with_the_numbers():
    a = green_residents_evening_demand()
    a["requirementLabels"] = ["Resident supervision: Green needs its own attending whenever its residents work (8 team-hours/week)"]
    r = solve(inst([a], budget=4))
    assert r.status == "infeasible" and r.shifts == []
    assert "at least 8" in r.message and "Resident supervision" in r.message
    assert r.diagnosis["requiredHours"] == 8


def test_residents_where_no_attending_may_be_placed_are_reported():
    # Green may take no attending 08:00-16:00 (e.g. a closed area), but residents work then.
    g = supervised(slot("Green", 2.0, 1.0, extenders=series(1.0, DAY)), DAY)
    g["maxAttendings"] = [[0 if h in DAY else 1 for h in range(24)]]
    r = solve(inst([area("main", series(2.0), [g])], budget=24))
    assert r.status == "infeasible"
    assert "residents on duty need a supervising Green attending" in r.message
    assert r.diagnosis["unreachable"][0]["kind"] == "resident supervision"


def test_locked_attending_counts_toward_supervision():
    lock = [1 if h in DAY else 0 for h in range(24)]
    g = supervised(slot("Green", 2.0, 1.0, extenders=series(1.0, DAY), locked=lock), DAY)
    r = solve(inst([area("main", series(0.0), [g])], budget=8, locked_hours=8))
    assert r.status in ("optimal", "feasible")
    assert r.hours.optimized == 0     # the locked shift already supervises


def test_instances_without_min_attendings_solve_as_before():
    g = slot("Green", 2.0, 1.0, extenders=series(1.0, DAY))
    r = solve(inst([area("main", series(2.0, EVENING), [g])], budget=8))
    assert all(on(r, "Green", h) >= 1 for h in EVENING)
    assert PATTERNS_3x8  # same menu as the rest of the suite


# Flexible hours with a covering area: the team's own attending OR no attending
# in the area at all (then the covering area supervises under cross-coverage).
def flexible_eru(**kw):
    eru = slot("ERU", 0.8, 0.6, extenders=series(0.8, DAY))
    eru["supervisedUnlessUncovered"] = [[1 if h in DAY else 0 for h in range(24)]]
    flex = slot("eru:flex", 0.8, 0.6, max_att=1, flex=True)
    return area("eru", series(0.5, DAY), [eru, flex], **kw)


def test_flexible_cross_covered_residents_allow_no_attending_at_all():
    r = solve(inst([flexible_eru()], budget=0))
    assert r.status in ("optimal", "feasible") and r.hours.total == 0


def test_flexible_cross_covered_residents_forbid_an_attending_on_another_team_only():
    # With budget the planner may add ERU coverage, but only on the residents' own team:
    # an attending on a new ERU team would end cross-coverage without supervising them.
    r = solve(inst([flexible_eru()], budget=8))
    for h in DAY:
        assert on(r, "eru:flex", h) == 0 or on(r, "ERU", h) >= 1
