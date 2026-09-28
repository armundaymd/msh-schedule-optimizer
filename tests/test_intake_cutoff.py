"""
Intake cutoffs in the solver. Fixed clock windows are zero rows in a slot's
capacity table (built by the frontend); the relative rule for tool-added
teams is `intakeLookahead`: a slot takes no new patients in the last L hours
of its continuous coverage, so its capacity at h counts min(n[h..h+L]).
"""

from staffing.service import solve
from test_staffing_optimizer import PATTERNS_3x8, area, inst, series, slot

EVENING = range(20, 24)          # demand only 20:00-24:00


def flex_pool(look):
    sl = slot("main:flex", 2.0, 2.0, max_att=2, flex=True)
    if look:
        sl["intakeLookahead"] = look
    return sl


def test_lookahead_drops_intake_in_the_last_hours_of_a_shift():
    # One 16:00-24:00 shift: with a 3 h look-ahead it takes no new patients 21:00-23:59.
    a = area("main", series(2.0, EVENING), [flex_pool(3)])
    r = solve(inst([a], budget=8))
    assert r.status in ("optimal", "feasible")
    cap = r.modeledCapacity["main"][0]
    assert cap[20] == 2.0 and cap[21] == 0 and cap[22] == 0 and cap[23] == 0
    assert r.objective["unmetPphHours"] == 6.0


def test_a_continuing_attending_keeps_intake_open():
    # With budget for a following 00:00-08:00 shift, coverage continues past midnight,
    # so the 16:00-24:00 attending takes patients until 23:59.
    a = area("main", series(2.0, EVENING), [flex_pool(3)])
    r = solve(inst([a], budget=16))
    assert r.objective["unmetPphHours"] == 0.0
    assert {(s.start, s.length) for s in r.shifts} >= {(16, 8), (0, 8)}


def test_without_lookahead_nothing_changes():
    a = area("main", series(2.0, EVENING), [flex_pool(0)])
    r = solve(inst([a], budget=8))
    assert r.objective["unmetPphHours"] == 0.0


def test_fixed_window_is_a_zero_capacity_row():
    # Blue-style: no new patients 20:00-23:59 even with an attending on.
    blue = slot("Blue", 2.0, 2.0)
    for h in EVENING:
        blue["capacity"][0][h] = [0.0, 0.0]
    a = area("main", series(2.0, EVENING), [blue])
    r = solve(inst([a], budget=8))
    assert r.objective["unmetPphHours"] == 8.0
    assert PATTERNS_3x8
