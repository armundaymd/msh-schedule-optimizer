"""
Operational coverage in the staffing solver (staffing/): required dedicated
coverage, blocked (cross-covered / closed) hours, cross-coverage credit, and
the infeasibility diagnosis. Instances are built by hand with the same
capacity rule as frontend/src/shared/capacity.js; the frontend half (config
-> instance) is tested in frontend/src/shared/operationalCoverage.test.js and
end to end in frontend/validation/operationalCoverage.validation.js.
"""

import math

import pytest

from staffing.model import Instance
from staffing.service import solve

PATTERNS_3x8 = [{"start": 0, "length": 8}, {"start": 8, "length": 8}, {"start": 16, "length": 8}]
PATTERNS_OVERNIGHT = [{"start": 7, "length": 8}, {"start": 15, "length": 8}, {"start": 23, "length": 8}]


def series(value=0.0, hours=range(24)):
    s = [0.0] * 24
    for h in hours:
        s[h % 24] = value
    return s


def slot(sid, ceiling, own, *, extenders=None, locked=None, max_att=1, flex=False, blocked=()):
    """One slot; `blocked` hours take no attendings beyond locked ones."""
    ext = extenders or series(0)
    lock = locked or [0] * 24
    top = max(max_att, max(lock))

    def cap(h, n):
        return min(ceiling * n, own * n + ext[h]) if n > 0 else 0

    return {
        "id": sid, "flex": flex,
        "locked": [list(lock)],
        "maxAttendings": [[lock[h] if h in blocked else max(max_att, lock[h]) for h in range(24)]],
        "capacity": [[[cap(h, n) for n in range(top + 1)] for h in range(24)]],
    }


def area(key, demand, slots, *, min_cov=None, ceiling=None, modes=None, labels=()):
    a = {
        "key": key,
        "demand": [demand],
        "excessTolerance": [[max(1.0, 0.25 * d) for d in demand]],
        "minCoverage": [list(min_cov or [0] * 24)],
        "slots": slots,
        "requirementLabels": list(labels),
    }
    if ceiling is not None:
        a["supervisionCeilingPph"] = ceiling
    if modes is not None:
        a["coverageMode"] = [modes]
    return a


def inst(areas, *, budget=None, mode="budget", patterns=PATTERNS_3x8, locked_hours=0, **kw):
    return Instance(mode=mode, days=["Monday"], patterns=patterns, areas=areas,
                    budgetHours=budget, lockedHours=locked_hours, **kw)


def area_hours(result, key):
    return sum(s.length for s in result.shifts if s.area == key)


def covered(result, key, h):
    return sum(1 for s in result.shifts if s.area == key and h in [(s.start + i) % 24 for i in range(s.length)])


def req(hours):
    return [1 if h in hours else 0 for h in range(24)]


DAY = range(8, 16)


def main_busy():
    # Main short all day: every attending-hour there removes up to 2 PPH of deficit.
    return area("main", series(6.0), [slot("Main:flex", 2.0, 2.0, max_att=3, flex=True)], ceiling=2.0)


def eru_quiet(min_cov=None):
    # ERU: 0.3 PPH, far less throughput value per attending-hour than Main.
    return area("eru", series(0.3), [slot("ERU", 0.8, 0.6, extenders=series(0.8))],
                min_cov=min_cov, ceiling=0.8, labels=["ERU core 08:00-16:00"] if min_cov else [])


# 2 — the optimizer moves ERU hours to Main unless ERU's core hours are required
def test_unconstrained_optimizer_strips_quiet_eru():
    r = solve(inst([main_busy(), eru_quiet()], budget=24))
    assert r.status in ("optimal", "feasible")
    assert area_hours(r, "eru") == 0


def test_required_dedicated_eru_cannot_be_removed():
    r = solve(inst([main_busy(), eru_quiet(req(DAY))], budget=24))
    assert r.status in ("optimal", "feasible")
    for h in DAY:
        assert covered(r, "eru", h) >= 1
    assert r.hours.total <= 24


# 10 — budget below the requirement: explicit infeasible, nothing dropped
def test_required_coverage_above_budget_is_infeasible_with_details():
    main = area("main", series(6.0), [slot("Main:flex", 2.0, 2.0, max_att=3, flex=True)],
                min_cov=[1] * 24, ceiling=2.0, labels=["Main 24/7"])
    r = solve(inst([main, eru_quiet(req(DAY))], budget=20))
    assert r.status == "infeasible"
    assert r.shifts == []
    d = r.diagnosis
    assert d["requiredHours"] == pytest.approx(32)       # Main 24 + ERU 8
    assert d["availableHours"] == pytest.approx(20)
    assert d["shortfallHours"] == pytest.approx(12)
    assert d["byArea"]["main"]["requiredHours"] == pytest.approx(24)
    assert d["byArea"]["eru"]["requiredHours"] == pytest.approx(8)
    assert "Main 24/7" in r.message and "ERU core 08:00-16:00" in r.message
    assert "32" in r.message and "20" in r.message


def test_requirement_in_blocked_hours_is_reported_unreachable():
    # A required hour that is also closed: no amount of hours can satisfy it.
    eru = area("eru", series(0.3), [slot("ERU", 0.8, 0.6, blocked=range(0, 8))], min_cov=req(range(4, 12)), ceiling=0.8,
               labels=["ERU 04:00-12:00"])
    r = solve(inst([eru], budget=200))
    assert r.status == "infeasible"
    assert r.diagnosis["unreachable"][0]["hours"] == [4, 5, 6, 7]
    assert "04:00-08:00" in r.message and "ERU 04:00-12:00" in r.message


# 7 / blocked hours — no shift may reach into cross-covered or closed hours
def test_blocked_hours_get_no_attendings():
    ft = area("fasttrack", series(4.0), [slot("FastTrack", 3.5, 2.2, blocked=range(0, 8)),
                                        slot("FastTrack:flex", 3.5, 2.2, max_att=3, flex=True, blocked=range(0, 8))],
              modes=["CLOSED"] * 8 + ["FLEXIBLE"] * 16)
    r = solve(inst([ft], budget=200))
    assert r.status in ("optimal", "feasible")
    for h in range(8):
        assert covered(r, "fasttrack", h) == 0
    # Demand in closed hours is still counted: 8 h x 4.0 PPH unmet.
    assert r.objective["deficitPphHours"] >= 32 - 1e-6


def test_closed_mode_with_placement_allowed_is_rejected():
    ft = area("fasttrack", series(4.0), [slot("FastTrack", 3.5, 2.2)], modes=["CLOSED"] * 8 + ["FLEXIBLE"] * 16)
    with pytest.raises(ValueError, match="maxAttendings must equal locked"):
        inst([ft], budget=10)


# 11 — locked shifts still count and are kept, including inside required hours
def test_locked_shift_satisfies_requirement_and_counts_toward_budget():
    lock = [1 if h in DAY else 0 for h in range(24)]
    eru = area("eru", series(0.3), [slot("ERU", 0.8, 0.6, locked=lock)], min_cov=req(DAY), ceiling=0.8)
    r = solve(inst([main_busy(), eru], budget=24, locked_hours=8))
    assert r.status in ("optimal", "feasible")
    assert r.hours.locked == 8 and r.hours.total <= 24
    assert area_hours(r, "eru") == 0          # nothing new needed; the locked shift covers it
    assert r.modeledCapacity["eru"][0][10] == pytest.approx(0.6)   # own throughput, no residents


# 14 — overnight windows across midnight
def test_overnight_requirement_across_midnight():
    night = [h for h in range(24) if h >= 23 or h < 7]
    eru = area("eru", series(0.3), [slot("ERU", 0.8, 0.6)], min_cov=req(night), ceiling=0.8)
    r = solve(inst([main_busy(), eru], budget=16, patterns=PATTERNS_OVERNIGHT))
    assert r.status in ("optimal", "feasible")
    assert all(covered(r, "eru", h) >= 1 for h in night)
    assert any(s.area == "eru" and s.start == 23 for s in r.shifts)


# ── Cross-coverage ────────────────────────────────────────────────────────────

# The CURRENT_RATIO analysis assumption (ERU ceiling / Main ceiling). The
# solver only sees an explicit headroomFactor; nothing here validates it.
CURRENT_RATIO = 0.8 / 2.1


def cc_credit(headroom, supervised=0.8, factor=CURRENT_RATIO):
    """Expected credit: headroom x factor (floored to 0.01 PPH, as the solver
    does), capped by the creditable resident/PA capacity."""
    from fractions import Fraction
    fr = Fraction(factor).limit_denominator(10_000)
    h = round(max(0.0, headroom) * 100)
    return min(supervised, math.floor(h * fr.numerator / fr.denominator) / 100)


def cc_instance(main_demand, eru_supervised, *, eru_flexible=False, budget=24, eru_demand=1.0, main_max=1,
                factor=CURRENT_RATIO):
    """Main (1 attending all day via minCoverage + small budget) cross-covers ERU."""
    main = area("main", series(main_demand), [slot("Green", 2.1, 1.3, extenders=series(0.8), max_att=main_max)],
                min_cov=[1] * 24, ceiling=2.1)
    blocked = () if eru_flexible else range(24)
    eru = area("eru", series(eru_demand), [slot("ERU", 0.8, 0.6, extenders=series(eru_supervised), blocked=blocked)],
               ceiling=0.8, modes=["FLEXIBLE" if eru_flexible else "CROSS_COVERED"] * 24)
    return inst([main, eru], budget=budget, crossCover=[{
        "area": "eru", "coveredBy": "main", "eligible": [[1] * 24], "supervised": [series(eru_supervised)],
        "headroomFactor": factor,
    }])


@pytest.mark.parametrize("main_demand,expected", [
    (0.0, 0.8),    # idle Main attending: 2.1 x 0.8/2.1 = 0.8 ERU-patients of headroom -> full resident capacity
    (1.0, 0.41),   # headroom 1.1 Main-patients = 1.1 x 0.8/2.1 = 0.419 ERU-patients (floored to 0.41)
    (1.8, 0.11),   # headroom 0.3 -> 0.114
    (5.0, 0.0),    # Main expects more than its ceiling: no headroom left for ERU
])
def test_cross_cover_credit_is_capped_by_covering_headroom(main_demand, expected):
    assert cc_credit(2.1 - main_demand) == pytest.approx(expected)
    r = solve(cc_instance(main_demand, 0.8))
    assert r.status in ("optimal", "feasible")
    assert area_hours(r, "eru") == 0
    assert r.crossCoverCredit["eru"][0][12] == pytest.approx(expected)
    assert r.modeledCapacity["eru"][0][12] == pytest.approx(expected)
    # Main's own capacity is untouched by covering ERU.
    assert r.modeledCapacity["main"][0][12] == pytest.approx(2.1)


def test_cross_cover_is_never_cheaper_than_a_dedicated_attending():
    # A whole idle Main attending's headroom buys exactly one ERU attending's
    # worth of supervision (the ERU ceiling), never more.
    assert cc_credit(2.1, supervised=3.0) == pytest.approx(0.8)


def test_second_main_attending_creates_headroom_for_eru():
    # Busy Main (3.0 expected) with room for two attendings on Green and
    # budget for 48 h: credit follows the Main attending count hour by hour
    # (headroom 0 with one attending, 1.2 x 0.8/2.1 with two).
    r = solve(cc_instance(3.0, 0.8, main_max=2, budget=48))
    assert r.status in ("optimal", "feasible")
    for h in range(24):
        n_main = covered(r, "main", h)
        assert r.crossCoverCredit["eru"][0][h] == pytest.approx(cc_credit(n_main * 2.1 - 3.0))


def test_cross_cover_keeps_eru_demand_as_eru():
    r = solve(cc_instance(1.0, 0.8, eru_demand=1.0))
    # ERU demand 1.0 vs credited 0.41: 0.59 PPH x 24 h of ERU deficit, counted as ERU's.
    assert r.objective["deficitPphHours"] == pytest.approx(0.59 * 24, abs=0.02)


def test_flexible_eru_with_fallback_gets_credit_only_without_own_attending():
    # ERU FLEXIBLE + Main fallback, busy ERU: an own attending wins where placed.
    r = solve(cc_instance(1.0, 0.8, eru_flexible=True, budget=32, eru_demand=1.5))
    assert r.status in ("optimal", "feasible")
    for h in range(24):
        own = covered(r, "eru", h)
        credit = r.crossCoverCredit["eru"][0][h]
        if own:
            assert credit == 0
            assert r.modeledCapacity["eru"][0][h] == pytest.approx(min(0.8, 0.6 + 0.8))
        else:
            assert credit == pytest.approx(cc_credit(2.1 - 1.0))


def test_external_covering_area_uses_constant_headroom():
    eru = area("eru", series(1.0), [slot("ERU", 0.8, 0.6, extenders=series(0.8), blocked=range(24))],
               ceiling=0.8, modes=["CROSS_COVERED"] * 24)
    i = inst([eru], budget=10, crossCover=[{
        "area": "eru", "coveredBy": "main", "eligible": [[1] * 24], "supervised": [series(0.8)], "headroomFactor": CURRENT_RATIO,
    }], coveringAreas={"main": {"ceiling": [series(4.2)], "load": [series(3.0)]}})
    r = solve(i)
    assert r.crossCoverCredit["eru"][0][0] == pytest.approx(cc_credit(1.2))   # 1.2 x 0.8/2.1 = 0.457


def test_cross_cover_needs_a_known_covering_area():
    eru = area("eru", series(1.0), [slot("ERU", 0.8, 0.6, blocked=range(24))], ceiling=0.8)
    with pytest.raises(ValueError, match="neither in the instance"):
        inst([eru], budget=10, crossCover=[{"area": "eru", "coveredBy": "main", "headroomFactor": CURRENT_RATIO,
                                            "eligible": [[1] * 24], "supervised": [series(0.8)]}])


# 12 — combined Main + ERU: both requirements hold together
def test_main_and_eru_requirements_hold_together():
    main = area("main", series(6.0), [slot("Main:flex", 2.0, 2.0, max_att=3, flex=True)],
                min_cov=[1] * 24, ceiling=2.0)
    r = solve(inst([main, eru_quiet(req(DAY))], budget=40))
    assert r.status in ("optimal", "feasible")
    assert all(covered(r, "main", h) >= 1 for h in range(24))
    assert all(covered(r, "eru", h) >= 1 for h in DAY)
    assert r.hours.total <= 40


# ── Explicit throughput-credit assumption ─────────────────────────────────────

def test_custom_headroom_factor_is_used_as_given():
    # Idle-ish Main (demand 0.5): headroom 1.6; factor 0.25 -> 0.40 credited.
    r = solve(cc_instance(0.5, 0.8, factor=0.25))
    assert r.crossCoverCredit["eru"][0][3] == pytest.approx(0.40)
    assert cc_credit(1.6, factor=0.25) == pytest.approx(0.40)


def test_no_entry_means_no_credit_but_demand_stays_eru():
    # CONSERVATIVE: the frontend sends no crossCover entry. ERU is still its
    # own area with its own demand, now fully unmet in cross-covered hours.
    main = area("main", series(1.0), [slot("Green", 2.1, 1.3, extenders=series(0.8))], min_cov=[1] * 24, ceiling=2.1)
    eru = area("eru", series(0.5), [slot("ERU", 0.8, 0.6, extenders=series(0.8), blocked=range(24))],
               ceiling=0.8, modes=["CROSS_COVERED"] * 24)
    r = solve(inst([main, eru], budget=24))
    assert r.crossCoverCredit == {}
    assert all(v == 0 for v in r.modeledCapacity["eru"][0])
    assert r.objective["deficitPphHours"] == pytest.approx(0.5 * 24)


# ── Area maximum (ERU: one dedicated attending at a time) ─────────────────────

def eru_busy(max_cov=1, locked=None):
    # Very busy ERU and a flex pool that could otherwise stack 3 attendings.
    return area("eru", series(3.0), [slot("ERU", 0.8, 0.6, extenders=series(2.0), locked=locked),
                                    slot("ERU:flex", 0.8, 0.6, max_att=3, flex=True)],
                ceiling=0.8) | {"maxCoverage": [[max_cov] * 24]}


def test_area_maximum_prevents_stacked_eru_attendings():
    r = solve(inst([eru_busy()], budget=24 * 4))
    assert r.status in ("optimal", "feasible")
    assert max(covered(r, "eru", h) for h in range(24)) == 1
    # The residual ERU deficit is reported, not hidden by a second attending:
    # 3.0 demand vs 0.8 capacity, every hour.
    assert r.objective["deficitPphHours"] == pytest.approx((3.0 - 0.8) * 24)


def test_without_the_maximum_the_flex_pool_would_stack():
    # Guard that the test above is meaningful.
    a = eru_busy()
    del a["maxCoverage"]
    r = solve(inst([a], budget=24 * 4))
    assert max(covered(r, "eru", h) for h in range(24)) > 1


def test_locked_shifts_above_the_maximum_are_refused():
    two = [2 if 9 <= h < 17 else 0 for h in range(24)]
    a = eru_busy(locked=None)
    a["slots"][0] = slot("ERU", 0.8, 0.6, extenders=series(2.0), locked=two, max_att=2)
    r = solve(inst([a], budget=100, locked_hours=16))
    assert r.status == "infeasible"
    assert "09:00-17:00" in r.message and "eru" in r.message


def test_minimum_above_maximum_is_rejected():
    a = eru_busy()
    a["minCoverage"] = [[2] * 24]
    with pytest.raises(ValueError, match="exceeds the area maximum"):
        inst([a], budget=100)
