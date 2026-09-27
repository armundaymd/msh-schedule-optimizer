"""
Staffing-plan service: validation, pre-checks, solve, infeasibility diagnosis.

The only entry point the rest of the backend uses. Engine-specific code lives
in cpsat.py; swapping engines means replacing the `engine.solve` calls here.
"""

from __future__ import annotations

import math
from collections import Counter

from . import cpsat as engine
from .model import (
    HOURS, OPTIMALITY_GAP, TIME_UNITS_PER_HOUR, PPH_SCALE, HoursSummary, Instance, PlannedShift, Result,
    budget_units, hours_to_units, scale_pph,
)

TARGET_INFEASIBLE = "TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS"


def _fmt(h: float) -> str:
    return f"{h:,.2f}".rstrip("0").rstrip(".")


def _hours(inst: Instance, units_used: int) -> HoursSummary:
    optimized = units_used / TIME_UNITS_PER_HOUR
    total = inst.lockedHours + optimized
    if inst.mode == "budget" and inst.budgetHours is not None:
        usable = budget_units(inst.budgetHours) / TIME_UNITS_PER_HOUR
        return HoursSummary(budget=inst.budgetHours, usableBudget=usable, locked=inst.lockedHours,
                            optimized=optimized, total=total, unallocated=inst.budgetHours - total)
    return HoursSummary(budget=None, usableBudget=None, locked=inst.lockedHours,
                        optimized=optimized, total=total, unallocated=None)


def _gap(sol: engine.Solution) -> float:
    if not sol.objective:
        return 0.0
    return abs(sol.objective - sol.best_bound) / max(1.0, abs(sol.objective))


def _stats(sol: engine.Solution) -> dict:
    gap = _gap(sol)
    return {
        "solveSeconds": round(sol.wall_seconds, 3),
        "variables": sol.num_variables,
        "constraints": sol.num_constraints,
        "objectiveValue": sol.objective,
        "bestBound": sol.best_bound,
        "relativeGap": round(gap, 6),
    }


def prefer_existing_teams(inst: Instance, shifts: list) -> list:
    """Move new-team (flex) shifts onto existing teams when that is a pure tie.

    When an existing team is free for a flex shift's whole span and adding an
    attending there adds EXACTLY the capacity the flex slot provided at every
    hour, the move changes nothing the objective measures (coverage, deficit,
    excess, hours) — so staff the existing team instead of inventing one.
    A post-solve pass rather than an objective term: an objective tie-break
    was tried and measurably weakened the search on real data (validation
    S09 follow-up: unmet demand 107.5 -> 112.6 patient-hours/week).

    shifts: [(area, slot_id, flex, day_index, start, length)], deterministic order.
    """
    slots = {(a.key, s.id): s for a in inst.areas for s in a.slots}
    n = {}  # (area, slot, day) -> attendings per hour, locked + planned

    def counts(area, slot, d):
        key = (area, slot, d)
        if key not in n:
            n[key] = list(slots[(area, slot)].locked[d])
        return n[key]

    def hours(start, length):
        return [(start + i) % 24 for i in range(length)]

    for a, sid, flex, d, st, ln in shifts:
        c = counts(a, sid, d)
        for h in hours(st, ln):
            c[h] += 1

    out = []
    for a, sid, flex, d, st, ln in sorted(shifts, key=lambda t: (t[3], t[0], t[4], t[5], t[1])):
        if flex:
            hs = hours(st, ln)
            fc, flex_slot = counts(a, sid, d), slots[(a, sid)]
            for area in inst.areas:
                if area.key != a:
                    continue
                for s in area.slots:
                    if s.flex:
                        continue
                    nc = counts(a, s.id, d)
                    fits = all(nc[h] + 1 <= s.maxAttendings[d][h] for h in hs)
                    same = fits and all(
                        round((s.capacity[d][h][nc[h] + 1] - s.capacity[d][h][nc[h]]) * PPH_SCALE)
                        == round((flex_slot.capacity[d][h][fc[h]] - flex_slot.capacity[d][h][fc[h] - 1]) * PPH_SCALE)
                        for h in hs)
                    if same:
                        for h in hs:
                            nc[h] += 1
                            fc[h] -= 1
                        sid, flex = s.id, False
                        break
                break
        out.append((a, sid, flex, d, st, ln))
    return out


def _runs(hours: list[int]) -> list[str]:
    """[9, 10, 11, 20] -> ['09:00-12:00', '20:00-21:00'] (end exclusive)."""
    out, start, prev = [], None, None
    for h in hours + [None]:
        if start is None:
            start = prev = h
        elif h is not None and h == prev + 1:
            prev = h
        else:
            out.append(f"{start:02d}:00-{(prev + 1) % 24:02d}:00")
            start = prev = h
    return [r for r in out if r]


def unreachable_requirements(inst: Instance) -> list[dict]:
    """Area-hours whose minimum-coverage rule can't be met with ANY number
    of hours: the most attendings the shift menu, the slot limits and the
    blocked (cross-covered / closed) hours allow is below the requirement.
    [{area, day, hours: [..], need, reachable}] grouped per area-day."""
    covers = [set(p.hours()) for p in inst.patterns]
    found = []
    for a in inst.areas:
        for d, day in enumerate(inst.days):
            reach = [0] * HOURS
            for s in a.slots:
                free = [0] * HOURS
                for pi in range(len(inst.patterns)):
                    ub = min(s.maxAttendings[d][h] - s.locked[d][h] for h in covers[pi])
                    if ub > 0:
                        for h in covers[pi]:
                            free[h] += ub
                for h in range(HOURS):
                    reach[h] += min(s.maxAttendings[d][h], s.locked[d][h] + free[h])
            if a.maxCoverage is not None:
                reach = [min(reach[h], a.maxCoverage[d][h]) for h in range(HOURS)]
            bad = [h for h in range(HOURS) if a.minCoverage[d][h] > reach[h]]
            if bad:
                found.append({"area": a.key, "day": day, "hours": bad,
                              "need": max(a.minCoverage[d][h] for h in bad),
                              "reachable": min(reach[h] for h in bad)})
    return found


def required_hours_by_area(inst: Instance) -> dict:
    """Least NEW attending hours/week each area's minimum-coverage rules need
    beyond its locked shifts. Areas are independent under these rules, so the
    per-area figures plus the locked hours add up to the total requirement."""
    out = {}
    for a in inst.areas:
        if not any(v > 0 for row in a.minCoverage for v in row):
            continue
        sub = inst.model_copy(update={"areas": [a], "crossCover": [], "coveringAreas": {}})
        sol = engine.solve(sub, "min_hours")
        if sol.status in ("optimal", "feasible"):
            out[a.key] = {"requiredHours": sol.units_used / TIME_UNITS_PER_HOUR, "rules": list(a.requirementLabels)}
    return out


# ── Warm starts ──────────────────────────────────────────────────────────────

def _hint_from_shifts(shifts) -> dict:
    """Solver shifts [(area, slot, flex, d, start, length)] -> hint counts."""
    return dict(Counter((a, s, d, st, ln) for a, s, _f, d, st, ln in shifts))


def _hint_from_instance(inst: Instance) -> dict | None:
    if not inst.hint:
        return None
    day = {name: i for i, name in enumerate(inst.days)}
    return dict(Counter((h.area, h.slot, day[h.day], h.start, h.length) for h in inst.hint if h.day in day))


# ── Coverage bookkeeping ─────────────────────────────────────────────────────

def demand_units(inst: Instance) -> dict:
    """Scaled demand PPH-hours per area and '*' (the solver's own rounding)."""
    out = {a.key: sum(scale_pph(v) for row in a.demand for v in row) for a in inst.areas}
    out["*"] = sum(out.values())
    return out


def unmet_caps(inst: Instance) -> dict:
    """Target mode's caps on unmet demand, scaled, keyed by area or '*'.
    A coverage target t allows (1 - t) x demand unmet, rounded DOWN so the
    solver never accepts less than the target; the tightest of a coverage
    target and an unmet cap applies."""
    dem = demand_units(inst)
    caps = {}

    def cap(key, coverage, unmet_pph):
        vals = []
        if coverage is not None:
            vals.append(math.floor((1 - coverage) * dem[key] + 1e-9))
        if unmet_pph is not None:
            vals.append(math.floor(unmet_pph * PPH_SCALE + 1e-9))
        if vals:
            caps[key] = max(0, min(vals))

    cap("*", inst.targetCoverage, inst.maxUnmetPph)
    for a in inst.areas:
        cap(a.key, inst.areaTargetCoverage.get(a.key), inst.areaMaxUnmetPph.get(a.key))
    return caps


def _coverage_view(inst: Instance, unmet_by_area: dict) -> dict:
    """Solver-side unmet and coverage, overall and per area (patient-h/week)."""
    dem = demand_units(inst)
    total = sum(unmet_by_area.get(a.key, 0) for a in inst.areas)

    def cov(u, d):
        return 1.0 if d <= 0 else 1 - u / d

    return {
        "unmetPph": total / PPH_SCALE,
        "demandPph": dem["*"] / PPH_SCALE,
        "coverage": cov(total, dem["*"]),
        "byArea": {a.key: {"unmetPph": unmet_by_area.get(a.key, 0) / PPH_SCALE,
                           "demandPph": dem[a.key] / PPH_SCALE,
                           "coverage": cov(unmet_by_area.get(a.key, 0), dem[a.key])} for a in inst.areas},
    }


def _stage(name: str, sol: engine.Solution, **extra) -> dict:
    return {"stage": name, "status": sol.status, "seconds": round(sol.wall_seconds, 3),
            "objective": sol.objective, "bestBound": sol.best_bound, "relativeGap": round(_gap(sol), 6), **extra}


def best_achievable(inst: Instance) -> tuple[engine.Solution, dict]:
    """Least modeled unmet demand with UNLIMITED attending hours, under every
    hard rule, team/area maximum and the shift menu. Its bound proves which
    targets can never be reached."""
    sol = engine.solve(inst, "min_unmet")
    info = {"status": sol.status}
    if sol.status in ("optimal", "feasible"):
        info.update(_coverage_view(inst, _unmet_from_capacity(inst, sol)))
        info["attendingHours"] = inst.lockedHours + sol.units_used / TIME_UNITS_PER_HOUR
        # Lower bound on unmet (proof): the objective IS scaled unmet.
        info["unmetLowerBoundPph"] = math.floor(sol.best_bound + 1e-9) / PPH_SCALE
        info["proven"] = sol.status == "optimal"
    return sol, info


def _explain_target(inst: Instance, caps: dict, best: dict) -> list[str]:
    """Which requested caps sit below what the model can achieve at all."""
    dem = demand_units(inst)
    out = []
    for key, cap in caps.items():
        view = best if key == "*" else best["byArea"][key]
        name = "overall" if key == "*" else key
        if cap < round(view["unmetPph"] * PPH_SCALE):
            reach = 100 * view["coverage"]
            want = 100 * (1 - cap / dem[key]) if dem[key] else 100
            out.append(f"{name}: requested at most {cap / PPH_SCALE:,.1f} unmet patient-h/week "
                       f"(≥ {want:.1f}% modeled coverage); the least achievable with unlimited attending hours is "
                       f"{view['unmetPph']:,.1f} ({reach:.1f}%)")
    return out


def _planned(inst: Instance, sol: engine.Solution) -> list[PlannedShift]:
    return [PlannedShift(area=a, slot=s, flex=f, day=inst.days[d], start=st, length=ln)
            for a, s, f, d, st, ln in prefer_existing_teams(inst, sol.shifts)]


def _unmet_from_capacity(inst: Instance, sol: engine.Solution) -> dict:
    """Scaled unmet per area from the plan's modeled capacity — the same
    quantity as the solver's deficit variables, available in every mode."""
    return {a.key: sum(max(0, scale_pph(a.demand[d][h]) - scale_pph(sol.modeled_capacity[a.key][d][h]))
                       for d in range(len(inst.days)) for h in range(HOURS)) for a in inst.areas}


def _plan_result(inst: Instance, sol: engine.Solution, message: str, planning: dict | None = None) -> Result:
    view = _coverage_view(inst, _unmet_from_capacity(inst, sol))
    return Result(
        status=sol.status,
        message=message,
        shifts=_planned(inst, sol),
        hours=_hours(inst, sol.units_used),
        modeledCapacity=sol.modeled_capacity,
        crossCoverCredit=sol.cross_cover_credit,
        objective={
            "deficitPphHours": sol.deficit_units / PPH_SCALE,
            "severeDeficitPphHours": sol.severe_units / PPH_SCALE,
            "excessPphHours": sol.excess_units / PPH_SCALE,
            "unmetPphHours": view["unmetPph"],
            "demandPphHours": view["demandPph"],
            "coverage": view["coverage"],
        },
        stats=_stats(sol),
        planning=planning or {},
    )


def _solve_capped(inst: Instance, caps: dict, planning: dict, label: str) -> Result:
    """Fewest attending hours meeting `caps`, then the best placement of
    exactly that many hours (tiered unmet, then excess) under the same caps."""
    hint = _hint_from_instance(inst)
    need = engine.solve(inst, "min_hours", hint=hint, unmet_caps=caps)
    planning["stages"].append(_stage("fewest hours meeting the target", need))
    why = "; ".join(planning.get("infeasibleReasons") or [])
    if need.status == "infeasible":
        return Result(status="infeasible", stats=_stats(need), planning=planning,
                      message=f"{TARGET_INFEASIBLE}: the solver proved no plan meets {label} under the rules, "
                              "team limits and shift menu." + (f" {why}." if why else "") + " No rule was relaxed.")
    if need.status not in ("optimal", "feasible"):
        return Result(status="timeout", stats=_stats(need), planning=planning,
                      message=f"No plan meeting {label} was found within the '{inst.effort}' search budget"
                              + (f" — probably out of reach ({why}), but not proven." if why else
                                 ". It may still be reachable: try Thorough search."))
    lower = math.ceil(need.best_bound - 1e-9)
    planning["hoursRequired"] = inst.lockedHours + need.units_used / TIME_UNITS_PER_HOUR
    planning["hoursLowerBound"] = inst.lockedHours + lower / TIME_UNITS_PER_HOUR
    planning["hoursProven"] = need.status == "optimal" and lower >= need.units_used
    place = engine.solve(inst, "budget", hint=_hint_from_shifts(need.shifts),
                         units_cap=need.units_used, unmet_caps=caps)
    planning["stages"].append(_stage("placement of those hours", place))
    sol = place if place.status in ("optimal", "feasible") else need
    hrs = planning["hoursRequired"]
    proof = ("proven minimum" if planning["hoursProven"] else
             f"best found; the minimum is proven to be at least {planning['hoursLowerBound']:,.1f} h/week")
    return _plan_result(inst, sol, f"{label}: {hrs:,.1f} attending h/week ({proof}).", planning)


def _solve_target(inst: Instance) -> Result:
    caps = unmet_caps(inst)
    best_sol, best = best_achievable(inst)
    planning = {"mode": "target", "capsPph": {k: v / PPH_SCALE for k, v in caps.items()},
                "requested": {"targetCoverage": inst.targetCoverage, "maxUnmetPph": inst.maxUnmetPph,
                              "areaTargetCoverage": inst.areaTargetCoverage, "areaMaxUnmetPph": inst.areaMaxUnmetPph},
                "bestAchievable": best, "stages": [_stage("least achievable unmet (unlimited hours)", best_sol)]}
    if best_sol.status not in ("optimal", "feasible"):
        return Result(status="infeasible" if best_sol.status == "infeasible" else best_sol.status,
                      stats=_stats(best_sol), planning=planning,
                      message="The hard coverage rules can't be met even with unlimited hours.")
    planning["bestAchievablePlan"] = [s.model_dump() for s in _planned(inst, best_sol)]
    # Proven out of reach up front: the overall cap is below the solver's
    # proven lower bound on unmet demand. Any other shortfall is left to the
    # capped solve, which either proves infeasibility or finds a plan.
    bound_units = math.floor(best_sol.best_bound + 1e-9)
    beyond = _explain_target(inst, caps, best)
    planning["infeasibleReasons"] = beyond
    if "*" in caps and caps["*"] < bound_units:
        return Result(status="infeasible", stats=_stats(best_sol), planning=planning,
                      message=f"{TARGET_INFEASIBLE}: " + "; ".join(beyond) + ". No rule was relaxed. "
                              "See the bottleneck diagnosis for what limits the residual deficit.")
    parts = []
    if inst.targetCoverage is not None:
        parts.append(f"≥ {100 * inst.targetCoverage:g}% modeled coverage")
    if inst.maxUnmetPph is not None:
        parts.append(f"≤ {inst.maxUnmetPph:g} unmet patient-h/week")
    parts += [f"{k} ≥ {100 * v:g}%" for k, v in inst.areaTargetCoverage.items()]
    parts += [f"{k} ≤ {v:g} unmet patient-h" for k, v in inst.areaMaxUnmetPph.items()]
    return _solve_capped(inst, caps, planning, "Target " + ", ".join(parts))


def _solve_practical(inst: Instance) -> Result:
    best_sol, best = best_achievable(inst)
    planning = {"mode": "min_practical", "tolerancePct": inst.practicalTolerancePct,
                "bestAchievable": best, "stages": [_stage("least achievable unmet (unlimited hours)", best_sol)]}
    if best_sol.status not in ("optimal", "feasible"):
        return Result(status="infeasible" if best_sol.status == "infeasible" else best_sol.status,
                      stats=_stats(best_sol), planning=planning,
                      message="The hard coverage rules can't be met even with unlimited hours.")
    planning["bestAchievablePlan"] = [s.model_dump() for s in _planned(inst, best_sol)]
    dem = demand_units(inst)["*"]
    tol = math.floor(inst.practicalTolerancePct / 100 * dem + 1e-9)
    cap = round(best["unmetPph"] * PPH_SCALE) + tol
    planning["capsPph"] = {"*": cap / PPH_SCALE}
    planning["tolerancePph"] = tol / PPH_SCALE
    return _solve_capped(inst, {"*": cap}, planning,
                         f"Minimum practical modeled requirement (within {inst.practicalTolerancePct:g} coverage points "
                         f"of the least achievable unmet demand)")


def solve(inst: Instance) -> Result:
    # Locked shifts are fixed: if they alone exceed the budget no allocation
    # exists. Report it plainly instead of letting the solver say "infeasible".
    if inst.mode == "budget" and inst.lockedHours > inst.budgetHours + 1e-9:
        return Result(
            status="infeasible",
            message=(f"Locked shifts use {_fmt(inst.lockedHours)} h/week, which exceeds the "
                     f"{_fmt(inst.budgetHours)} h/week budget by "
                     f"{_fmt(inst.lockedHours - inst.budgetHours)} h. Unlock shifts or raise the budget."),
            diagnosis={"lockedHours": inst.lockedHours, "budgetHours": inst.budgetHours},
        )

    # Locked shifts alone above an area's maximum (e.g. two overlapping
    # locked ERU attendings): no plan can respect the limit.
    over = []
    for a in inst.areas:
        if a.maxCoverage is None:
            continue
        for d, day in enumerate(inst.days):
            hs = [h for h in range(HOURS) if sum(s.locked[d][h] for s in a.slots) > a.maxCoverage[d][h]]
            if hs:
                over.append(f"{a.key} {day} {', '.join(_runs(hs))}")
    if over:
        return Result(
            status="infeasible",
            message=("Locked shifts put more attendings on at once than the area allows: "
                     + "; ".join(over[:8]) + ". Unlock one of the overlapping shifts."),
            diagnosis={"lockedAboveMaximum": over},
        )

    # Requirements no number of hours can satisfy (shift menu, per-team
    # limits or blocked hours rule them out): name them, don't just fail.
    unreachable = unreachable_requirements(inst)
    if unreachable:
        labels = {a.key: a.requirementLabels for a in inst.areas}
        lines = [f"{u['area']} {u['day']} {', '.join(_runs(u['hours']))}: needs {u['need']} attending(s), "
                 f"at most {u['reachable']} possible" for u in unreachable[:8]]
        more = f" (+{len(unreachable) - 8} more)" if len(unreachable) > 8 else ""
        rules = sorted({r for u in unreachable for r in labels.get(u["area"], [])})
        return Result(
            status="infeasible",
            message=("Some required coverage can't be met with any number of hours — the shift menu, "
                     "per-team limits or cross-covered/closed hours leave too few attendings possible: "
                     + "; ".join(lines) + more + "."
                     + (f" Rules involved: {'; '.join(rules)}." if rules else "")),
            diagnosis={"unreachable": unreachable, "rules": rules},
        )

    if inst.mode == "target":
        return _solve_target(inst)
    if inst.mode == "min_practical":
        return _solve_practical(inst)

    sol = engine.solve(inst, inst.mode, hint=_hint_from_instance(inst))

    if sol.status in ("infeasible", "invalid", "timeout"):
        if sol.status == "infeasible" and inst.mode == "budget":
            # Budget too small for the hard rules (minimum coverage + locks):
            # find the least hours those rules need on their own.
            need = engine.solve(inst, "min_hours")
            if need.status in ("optimal", "feasible"):
                required = inst.lockedHours + need.units_used / TIME_UNITS_PER_HOUR
                by_area = required_hours_by_area(inst)
                parts = [f"{k} {_fmt(v['requiredHours'])} h" + (" beyond locked" if inst.lockedHours else "")
                         + (f" ({'; '.join(v['rules'])})" if v["rules"] else "")
                         for k, v in by_area.items()]
                return Result(
                    status="infeasible",
                    message=(f"The hard coverage rules need at least {_fmt(required)} attending h/week "
                             f"(including {_fmt(inst.lockedHours)} h locked) but only {_fmt(inst.budgetHours)} h/week "
                             f"are available — {_fmt(required - inst.budgetHours)} h short. No rule was dropped. "
                             + (f"Needed by: {'; '.join(parts)}. " if parts else "")
                             + "Raise the budget or relax a rule."),
                    stats=_stats(sol),
                    diagnosis={"requiredHours": required, "availableHours": inst.budgetHours,
                               "budgetHours": inst.budgetHours, "shortfallHours": required - inst.budgetHours,
                               "lockedHours": inst.lockedHours, "byArea": by_area},
                )
            return Result(status="infeasible", stats=_stats(sol),
                          message="The hard coverage rules can't be met even with unlimited hours: they ask for more "
                                  "attendings at once than the teams allow, or no combination of shifts from the menu "
                                  "fits a required window within an area's attending maximum (e.g. ERU: one at a time).")
        if sol.status == "infeasible":
            return Result(status="infeasible", stats=_stats(sol),
                          message="The demand target can't be met within the per-team attending limits. "
                                  "Allow more shift patterns or a small residual deficit.")
        if sol.status == "timeout":
            return Result(status="timeout", stats=_stats(sol),
                          message="No plan was found within the search budget. "
                                  "Try a longer search, fewer shift patterns, or a smaller scope.")
        return Result(status="invalid", stats=_stats(sol), message="The solver rejected the model as invalid.")

    note = f"Optimal (proven within {OPTIMALITY_GAP:.1%})." if sol.status == "optimal" else \
        f"Best plan found within the '{inst.effort}' search budget (not proven optimal; see relativeGap)."
    return _plan_result(inst, sol, note)
