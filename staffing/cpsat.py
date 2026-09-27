"""
CP-SAT formulation of the staffing allocation problem (the ONLY module that
imports OR-Tools). See model.py for the instance schema, scaling and weights.

Per area a, slot k, day d, pattern p, hour h:
  x[k,d,p]   int >= 0       attending shifts of pattern p on slot k, day d
  n[k,d,h]   = locked + sum_{p covers h} x[k,d,p]      in [locked, maxAttendings]
  cap[k,d,h] = capacity[k][d][h][n]                    (the table comes from
               shared/capacity.js; encoded as an exact linear expression when
               it is affine over n's domain, else as an exact AddElement)
  C[a,d,h]   = sum_k cap[k,d,h]
Budget objective ('budget'):
  u1+u2+u3 >= D - C,  0<=u1<=0.5 PPH, 0<=u2<=1.5 PPH, u3>=0   (per AREA-hour)
  e >= C - D - tolerance, e >= 0
  sum x*len <= budget - locked           (half-hour units)
  sum_k n[k,d,h] >= minCoverage[a,d,h]
  min  W1 u1 + W2 u2 + W3 u3 + We e + Wh * units_used
Requirement objective ('requirement'):
  C >= D - allowedDeficit  (hard, per area-hour), min  Wreq*units + e
Hard-constraints-only ('min_hours'): no coverage terms; min units. Used to
  diagnose an infeasible budget (how many hours the rules alone need).
Least achievable unmet ('min_unmet'): min sum(u) with no hour limit — the
  best coverage the structure (rules, team limits, shift menu) allows.
Planning stages (service.py) add, on any objective:
  unmet_caps  {area | '*': cap}:  sum of that area's (or every area's) u <= cap
  units_cap:  units <= cap (replaces the budget)
  so 'min_hours' + caps = fewest hours meeting a coverage/unmet target.

Cross-coverage (inst.crossCover, in order), per day d, hour h where eligible:
  N[b]    = sum_k n[k,d,h] over the covering area b's slots
  H[b]    = max(0, N[b]*ceiling_b - D_b)      (b in the instance; convex in N)
          = max(0, ceiling - load)             (b outside: constants)
  Hc      = floor(H * headroomFactor)           (headroom in covered-area patients;
                                               factor = an explicit assumption)
  credit  = min(supervised, Hc remaining) if the covered area has no own
            attending (N[a] == 0, a boolean when N[a] can vary), else 0
  H remaining -= ceil(credit / headroomFactor);  C[a] = Cnative[a] + credit
All exact (min/max equalities, reified on the attending count), so the
solver's capacity equals shared/operationalCoverage.js crossCoverHour.

Deficits exist only per component area-hour; the scope aggregate never
enters the model, so one area's surplus cannot offset another's deficit.
"""

from __future__ import annotations

import time
from fractions import Fraction
from dataclasses import dataclass, field
from typing import Literal

from ortools.sat.python import cp_model

from .model import (
    HOURS, OPTIMALITY_GAP, EFFORT_DETERMINISTIC_SECONDS, DEFICIT_TIER_BOUNDS, DEFICIT_TIER_WEIGHTS, EXCESS_WEIGHT, HOUR_WEIGHT,
    REQUIREMENT_HOUR_WEIGHT, PPH_SCALE, TIME_UNITS_PER_HOUR, Instance,
    budget_units, hours_to_units, scale_pph,
)

Objective = Literal["budget", "requirement", "min_hours", "min_unmet"]

_STATUS = {
    cp_model.OPTIMAL: "optimal",
    cp_model.FEASIBLE: "feasible",
    cp_model.INFEASIBLE: "infeasible",
    cp_model.MODEL_INVALID: "invalid",
    cp_model.UNKNOWN: "timeout",
}


@dataclass
class Solution:
    status: str
    # (area, slot_id, flex, day_index, start, length) per planned shift
    shifts: list[tuple[str, str, bool, int, int, int]] = field(default_factory=list)
    units_used: int = 0
    modeled_capacity: dict[str, list[list[float]]] = field(default_factory=dict)
    cross_cover_credit: dict[str, list[list[float]]] = field(default_factory=dict)
    deficit_units: int = 0          # sum over area-hours, scaled PPH-hours
    severe_units: int = 0
    excess_units: int = 0
    unmet_by_area: dict[str, int] = field(default_factory=dict)   # scaled PPH-hours
    objective: float = 0
    best_bound: float = 0
    wall_seconds: float = 0
    num_variables: int = 0
    num_constraints: int = 0


def solve(inst: Instance, objective: Objective, hint: dict | None = None,
          units_cap: int | None = None, unmet_caps: dict[str, int] | None = None,
          effort: str | None = None) -> Solution:
    """units_cap: most half-hour units beyond locked (replaces the budget).
    unmet_caps: {area key or '*': most scaled unmet PPH-hours}."""
    m = cp_model.CpModel()
    unmet_caps = unmet_caps or {}
    # Hard rules only: no coverage terms, no cross-coverage.
    hard_only = objective == "min_hours" and not unmet_caps
    nd = len(inst.days)
    patterns = inst.patterns
    covers = [set(p.hours()) for p in patterns]

    x_terms = []          # (var, area, slot, flex, d, pattern_index)
    units_expr = []       # sum x*len*2
    deficit_tiers = []    # (u1, u2, u3)
    excess_vars = []
    area_cap = {}         # area -> [day][hour] IntVar, total area capacity (scaled)
    native = {}           # area -> [day][hour] (IntVar, upper bound): capacity from the area's own teams
    n_total = {}          # area -> [day][hour] (linear expr, lo, hi) attendings in the area
    credit_terms = {}     # area -> [day][hour] cross-cover credit (IntVar or int)
    by_key = {a.key: a for a in inst.areas}
    cross = list(inst.crossCover) if not hard_only else []
    area_unmet = {}       # area -> [u1 + u2 + u3 per area-hour]
    # Areas whose capacity includes a cross-cover credit: their objective
    # terms wait until the credit exists. Every other area is built exactly
    # as before cross-coverage existed (same variables, same order), so
    # instances without it solve identically.
    covered = {c.area for c in cross if c.area in by_key}

    def objective_terms(area, d, h, C, hi):
        if hard_only:
            return
        D = scale_pph(area.demand[d][h])
        if objective in ("budget", "requirement"):
            tol = scale_pph(area.excessTolerance[d][h])
            e = m.NewIntVar(0, hi, f"e[{area.key},{d},{h}]")
            m.Add(e >= C - D - tol)
            excess_vars.append(e)
        if objective == "requirement":
            m.Add(C >= D - scale_pph(inst.allowedDeficitPph))
        if objective != "requirement" or unmet_caps:
            b1, b2 = DEFICIT_TIER_BOUNDS
            u1 = m.NewIntVar(0, b1, f"u1[{area.key},{d},{h}]")
            u2 = m.NewIntVar(0, b2 - b1, f"u2[{area.key},{d},{h}]")
            u3 = m.NewIntVar(0, max(0, D), f"u3[{area.key},{d},{h}]")
            m.Add(u1 + u2 + u3 >= D - C)
            deficit_tiers.append((u1, u2, u3))
            area_unmet.setdefault(area.key, []).append(u1 + u2 + u3)

    def build_area(area):
        cap_sum = [[[] for _ in range(HOURS)] for _ in range(nd)]   # per-slot cap terms
        n_sum = [[[] for _ in range(HOURS)] for _ in range(nd)]     # per-slot attending counts
        n_lo = [[0] * HOURS for _ in range(nd)]
        n_hi = [[0] * HOURS for _ in range(nd)]
        cap_hi = [[0] * HOURS for _ in range(nd)]
        for slot in area.slots:
            for d in range(nd):
                # x vars: bounded by the tightest free headroom over the hours
                # the pattern covers (never violates maxAttendings).
                xs_by_hour = [[] for _ in range(HOURS)]
                for pi, p in enumerate(patterns):
                    ub = min(slot.maxAttendings[d][h] - slot.locked[d][h] for h in covers[pi])
                    if ub <= 0:
                        continue
                    x = m.NewIntVar(0, ub, f"x[{area.key},{slot.id},{d},{p.start}+{p.length}]")
                    x_terms.append((x, area.key, slot.id, slot.flex, d, pi))
                    units_expr.append(x * (p.length * TIME_UNITS_PER_HOUR))
                    for h in covers[pi]:
                        xs_by_hour[h].append(x)

                for h in range(HOURS):
                    lo, hi = slot.locked[d][h], slot.maxAttendings[d][h]
                    table = [scale_pph(v) for v in slot.capacity[d][h][: hi + 1]]
                    if not xs_by_hour[h]:
                        # Nothing can change this slot-hour: constants.
                        n_sum[d][h].append(lo)
                        n_lo[d][h] += lo
                        n_hi[d][h] += lo
                        cap_sum[d][h].append(table[lo])
                        cap_hi[d][h] += table[lo]
                        continue
                    n = m.NewIntVar(lo, hi, f"n[{area.key},{slot.id},{d},{h}]")
                    m.Add(n == lo + sum(xs_by_hour[h]))
                    n_lo[d][h] += lo
                    n_hi[d][h] += hi
                    reachable = table[lo: hi + 1]
                    slope = reachable[1] - reachable[0] if len(reachable) > 1 else 0
                    if all(reachable[i] - reachable[i - 1] == slope for i in range(1, len(reachable))):
                        # Affine over n's domain (always true for 0/1 attendings, and
                        # for extender-free teams): the exact linear form keeps the LP
                        # relaxation tight. AddElement is equivalent but relaxes weakly.
                        cap = reachable[0] + slope * (n - lo)
                    else:
                        # Genuinely non-linear (e.g. the supervision min() bends
                        # between 1 and 2 attendings): exact table lookup.
                        cap = m.NewIntVar(min(table), max(table), f"cap[{area.key},{slot.id},{d},{h}]")
                        m.AddElement(n, table, cap)
                    n_sum[d][h].append(n)
                    cap_sum[d][h].append(cap)
                    cap_hi[d][h] += max(reachable)

        native[area.key] = [[None] * HOURS for _ in range(nd)]
        n_total[area.key] = [[None] * HOURS for _ in range(nd)]
        area_cap[area.key] = [[None] * HOURS for _ in range(nd)]
        for d in range(nd):
            for h in range(HOURS):
                need = area.minCoverage[d][h]
                if need > 0:
                    m.Add(sum(n_sum[d][h]) >= need)
                if area.maxCoverage is not None and n_hi[d][h] > area.maxCoverage[d][h]:
                    m.Add(sum(n_sum[d][h]) <= area.maxCoverage[d][h])
                    n_hi[d][h] = max(n_lo[d][h], area.maxCoverage[d][h])
                # Explicit variable so constant-only sums still give a
                # constraint (not a Python bool) and a readable value.
                name = "Cn" if area.key in covered else "C"
                C = m.NewIntVar(0, cap_hi[d][h], f"{name}[{area.key},{d},{h}]")
                m.Add(C == sum(cap_sum[d][h]))
                native[area.key][d][h] = (C, cap_hi[d][h])
                n_total[area.key][d][h] = (sum(n_sum[d][h]), n_lo[d][h], n_hi[d][h])
                if area.key not in covered:
                    area_cap[area.key][d][h] = C
                    objective_terms(area, d, h, C, cap_hi[d][h])

    # ── Cross-coverage credits ────────────────────────────────────────────────
    remaining = {}   # (covering area, d, h) -> (expr, upper bound) headroom left

    def headroom(b, d, h):
        key = (b, d, h)
        if key in remaining:
            return remaining[key]
        if b in by_key:
            area_b = by_key[b]
            nb, nb_lo, nb_hi = n_total[b][d][h]
            ceil_pph = scale_pph(area_b.supervisionCeilingPph or 0)
            D = scale_pph(area_b.demand[d][h])
            h_lo, h_hi = max(0, ceil_pph * nb_lo - D), max(0, ceil_pph * nb_hi - D)
            if nb_lo == nb_hi:
                remaining[key] = (h_lo, h_lo)
            else:
                H = m.NewIntVar(h_lo, h_hi, f"H[{b},{d},{h}]")
                m.AddMaxEquality(H, [ceil_pph * nb - D, 0])
                # max(0, affine in N) is convex, so its secant over N's range
                # is a valid upper bound; without it the LP puts H at its top.
                m.Add((nb_hi - nb_lo) * H <= (nb_hi - nb_lo) * h_lo + (h_hi - h_lo) * (nb - nb_lo))
                remaining[key] = (H, h_hi)
        else:
            ext = inst.coveringAreas[b]
            v = max(0, scale_pph(ext.ceiling[d][h]) - scale_pph(ext.load[d][h]))
            remaining[key] = (v, v)
        return remaining[key]

    # headroomFactor as an exact small fraction a/b (e.g. 0.8/2.1 -> 8/21).
    ratio = {}
    for c in cross:
        fr = Fraction(c.headroomFactor).limit_denominator(10_000)
        ratio[c.area] = (fr.numerator, max(1, fr.denominator))

    def cross_cover(cc):
        in_scope = cc.area in by_key
        if in_scope:
            credit_terms[cc.area] = [[0] * HOURS for _ in range(nd)]
        for d in range(nd):
            for h in range(HOURS):
                S = scale_pph(cc.supervised[d][h])
                if not cc.eligible[d][h] or S <= 0:
                    continue
                H, H_hi = headroom(cc.coveredBy, d, h)
                # Headroom is in covering-area patients/hr; headroomFactor = a/b
                # converts it to covered-area patients. Hc = floor(H * a / b).
                a, b = ratio[cc.area]
                if a == 0:
                    continue
                if isinstance(H, int):
                    Hc = (H * a) // b
                    raw, raw_hi = min(S, Hc), min(S, Hc)
                else:
                    Hc_hi = (H_hi * a) // b
                    Hc = m.NewIntVar(0, Hc_hi, f"Hc[{cc.coveredBy},{cc.area},{d},{h}]")
                    m.Add(b * Hc <= a * H)
                    m.Add(b * Hc >= a * H - b + 1)
                    # min(S, Hc): the covered area's supervised capacity, capped by headroom.
                    raw_hi = min(S, Hc_hi)
                    raw = m.NewIntVar(0, raw_hi, f"ccraw[{cc.area},{d},{h}]")
                    m.AddMinEquality(raw, [Hc, S])
                if in_scope:
                    na, na_lo, na_hi = n_total[cc.area][d][h]
                    if na_lo > 0:
                        continue                       # own attending always on: no cross-cover
                    if na_hi == 0:
                        credit = raw                   # never an own attending: always cross-covered
                    else:
                        z = m.NewBoolVar(f"cc_on[{cc.area},{d},{h}]")   # true <=> no own attending
                        # Linear (big-M) forms of the links, so the LP relaxation
                        # sees them; exact for integers, same as the reified ones.
                        m.Add(na <= na_hi * (1 - z))
                        m.Add(na >= 1 - z)
                        credit = m.NewIntVar(0, raw_hi, f"cc[{cc.area},{d},{h}]")
                        m.Add(credit <= raw)
                        m.Add(credit <= raw_hi * z)
                        m.Add(credit >= raw - raw_hi * (1 - z))
                    credit_terms[cc.area][d][h] = credit
                else:
                    credit = raw                       # out-of-scope area: eligible == active
                # Headroom used, back in covering units: ceil(credit * b / a).
                if isinstance(H, int) and isinstance(credit, int):
                    used = -((-credit * b) // a)
                    remaining[(cc.coveredBy, d, h)] = (max(0, H - used), max(0, H - used))
                else:
                    used = m.NewIntVar(0, H_hi, f"Hused[{cc.coveredBy},{cc.area},{d},{h}]")
                    m.Add(a * used >= b * credit)
                    m.Add(a * used <= b * credit + a - 1)
                    left = m.NewIntVar(0, H_hi, f"Hleft[{cc.coveredBy},{cc.area},{d},{h}]")
                    m.Add(left == H - used)
                    remaining[(cc.coveredBy, d, h)] = (left, H_hi)

    def finish_covered(area):
        """Capacity = own teams + credit, then the area's objective terms."""
        credits = credit_terms.get(area.key)
        entry = next(c for c in cross if c.area == area.key)
        for d in range(nd):
            for h in range(HOURS):
                Cn, hi = native[area.key][d][h]
                credit = credits[d][h] if credits else 0
                if isinstance(credit, int) and credit == 0:
                    C = Cn
                else:
                    hi += scale_pph(entry.supervised[d][h])
                    C = m.NewIntVar(0, hi, f"C[{area.key},{d},{h}]")
                    m.Add(C == Cn + credit)
                area_cap[area.key][d][h] = C
                objective_terms(area, d, h, C, hi)

    # Build areas in order; process each cross-cover entry (in its order) as
    # soon as the areas it touches exist, and finish a covered area once its
    # entry is done.
    built, pending, finished = set(), list(cross), set()

    def ready(cc):
        return all(k in built for k in (cc.area, cc.coveredBy) if k in by_key)

    def drain():
        while pending and ready(pending[0]):
            cross_cover(pending.pop(0))
        done = {c.area for c in cross} - {c.area for c in pending}
        for k in sorted(covered & done - finished, key=lambda k: [a.key for a in inst.areas].index(k)):
            finish_covered(by_key[k])
            finished.add(k)

    for area in inst.areas:
        build_area(area)
        built.add(area.key)
        drain()
    drain()

    max_units = nd * HOURS * TIME_UNITS_PER_HOUR * max(1, sum(
        max(max(row) for row in s.maxAttendings) for a in inst.areas for s in a.slots))
    units = m.NewIntVar(0, max_units * max(p.length for p in patterns), "units")
    m.Add(units == sum(units_expr))
    for key, cap in unmet_caps.items():
        terms = [t for k, ts in area_unmet.items() if key in ("*", k) for t in ts]
        m.Add(sum(terms) <= cap)
    if units_cap is not None:
        m.Add(units <= units_cap)
    if objective == "budget":
        if units_cap is None:
            free = budget_units(inst.budgetHours) - hours_to_units(inst.lockedHours)
            m.Add(units <= free)
        w1, w2, w3 = DEFICIT_TIER_WEIGHTS
        m.Minimize(
            sum(w1 * a + w2 * b + w3 * c for a, b, c in deficit_tiers)
            + EXCESS_WEIGHT * sum(excess_vars)
            + HOUR_WEIGHT * units
        )
    elif objective == "requirement":
        m.Minimize(REQUIREMENT_HOUR_WEIGHT * units + sum(excess_vars))
    elif objective == "min_unmet":
        m.Minimize(sum(u1 + u2 + u3 for u1, u2, u3 in deficit_tiers))
    else:
        m.Minimize(units)

    if hint:
        # Warm start: a known plan's shift counts (area, slot, day, start, length) -> count.
        for x, area_key, slot_id, _flex, d, pi in x_terms:
            p = patterns[pi]
            m.AddHint(x, hint.get((area_key, slot_id, d, p.start, p.length), 0))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = inst.timeLimitSeconds
    solver.parameters.max_deterministic_time = EFFORT_DETERMINISTIC_SECONDS[effort or inst.effort]
    solver.parameters.num_workers = inst.workers
    solver.parameters.random_seed = 0
    # Deterministic parallel search: the same instance gives the same plan
    # (not just the same objective) on every run — CP-SAT's default parallel
    # portfolio breaks ties between equally good plans nondeterministically.
    solver.parameters.interleave_search = True
    solver.parameters.relative_gap_limit = OPTIMALITY_GAP
    t0 = time.perf_counter()
    code = solver.Solve(m)
    wall = time.perf_counter() - t0

    proto = m.Proto()
    sol = Solution(
        status=_STATUS.get(code, "timeout"),
        wall_seconds=wall,
        num_variables=len(proto.variables),
        num_constraints=len(proto.constraints),
    )
    if code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return sol

    sol.objective = solver.ObjectiveValue()
    sol.best_bound = solver.BestObjectiveBound()
    for x, area_key, slot_id, flex, d, pi in x_terms:
        count = solver.Value(x)
        p = patterns[pi]
        for _ in range(count):
            sol.shifts.append((area_key, slot_id, flex, d, p.start, p.length))
        sol.units_used += count * p.length * TIME_UNITS_PER_HOUR
    for area in inst.areas:
        sol.modeled_capacity[area.key] = [
            [solver.Value(area_cap[area.key][d][h]) / PPH_SCALE for h in range(HOURS)]
            for d in range(nd)
        ]
    for key, grid in credit_terms.items():
        sol.cross_cover_credit[key] = [
            [(v if isinstance(v, int) else solver.Value(v)) / PPH_SCALE for v in grid[d]] for d in range(nd)
        ]
    for u1, u2, u3 in deficit_tiers:
        sol.deficit_units += solver.Value(u1) + solver.Value(u2) + solver.Value(u3)
        sol.severe_units += solver.Value(u3)
    for key, terms in area_unmet.items():
        sol.unmet_by_area[key] = sum(solver.Value(t) for t in terms)
    sol.excess_units = sum(solver.Value(e) for e in excess_vars)
    return sol
