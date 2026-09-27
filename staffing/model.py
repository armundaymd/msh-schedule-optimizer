"""
Staffing resource-allocation problem: instance/result schema and scaling.

Solver-agnostic. Nothing here imports OR-Tools; cpsat.py is the only module
that does, so the engine can be swapped behind service.solve().

The instance is built by the frontend (frontend/src/shared/staffingPlan.js),
which owns every clinical rule. In particular each slot's capacity TABLE —
patients/hr the slot can handle with n attendings on at that hour — is
computed there by shared/capacity.js (supervision ceiling, solo throughput,
the slot's own residents/PAs, FastTrack solo PAs). The solver never
re-implements that maths; it only chooses attending counts.

Terminology
  area  — a clinical area in the selected scope ('main', 'fasttrack', 'eru')
  slot  — somewhere attendings can be placed within an area: an existing team
          (with the residents/PAs already scheduled on it) or the area's flex
          pool (new teams, no extenders)
  day   — a circular 24-hour day template: a pattern starting at 23:00 for
          8 hours covers 23:00-06:59 of the SAME day, matching
          shared/capacity.js shiftCoversHour and the rest of the app.

Operational coverage (frontend/src/shared/operationalCoverage.js) reaches the
solver as plain structure, so the solver stays rule-agnostic:
  REQUIRED_DEDICATED -> Area.minCoverage (hard)
  CROSS_COVERED / CLOSED -> slot maxAttendings == locked (no new attendings)
  cross-coverage -> Instance.crossCover: a covered area's residents/PAs are
      credited through the covering area's supervision HEADROOM
          headroom = max(0, sum(n) * ceiling - covering area's expected demand)
          credit   = min(creditable resident/PA capacity,
                         headroomFactor * headroom remaining)
      headroomFactor (covered-area patients/hr per unit of covering headroom)
      is an explicit, UNVALIDATED analysis assumption chosen by the frontend;
      an area whose assumption credits nothing has no entry at all.
  Area.maxCoverage -> sum of the area's attendings <= max at every hour
      (ERU: 1 — structural, applies in every scenario).
      only in hours the covered area has no attending of its own. Entries are
      in the order covered areas draw on a shared headroom. Demand is never
      moved between areas.
  Area.coverageMode is informational (checked for consistency, used in
  messages); requirementLabels name the hard rules in infeasibility messages.
"""

from __future__ import annotations

import math
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

HOURS = 24

# ── Scaling (integer representation for the solver) ──────────────────────────
# Capacity, demand and tolerance are in units of 0.01 patients/hr, rounded to
# nearest: each scaled term is within 0.005 PPH of the input.
PPH_SCALE = 100
# The staffing-hour budget is enforced in half-hours, the app's shift-time
# granularity (locked shifts can start/end on :30). Pattern starts are whole
# hours because demand is hourly.
TIME_UNITS_PER_HOUR = 2

# ── Objective weights (integers; per scaled unit per hour) ───────────────────
# Budget mode minimises, in effectively lexicographic order:
#   tiered deficit  >>  excess beyond tolerance  >>  hours used.
# Deficit is split into tiers so severe shortfalls cost more than mild ones
# (convex, so the solver fills the cheap tier first):
DEFICIT_TIER_BOUNDS = (50, 200)          # 0.5 PPH, 2.0 PPH (scaled)
DEFICIT_TIER_WEIGHTS = (100, 200, 400)   # mild, moderate, severe
EXCESS_WEIGHT = 5                        # per 0.01 PPH-hour beyond tolerance
HOUR_WEIGHT = 1                          # per half-hour allocated (tie-break)
# One 0.01 PPH-hour of mild deficit (100) outweighs 100 half-hours of use,
# and 20 excess units — so hours are only left unused when they can't reduce
# a deficit, and excess only shapes WHERE hours go.
#
# Requirement mode minimises hours first, excess second. The hour weight
# must exceed any achievable total excess for a strict ordering:
REQUIREMENT_HOUR_WEIGHT = 10_000_000

# ── Search ────────────────────────────────────────────────────────────────────
# CP-SAT stops once the plan is proven within this fraction of the optimum,
# or when its DETERMINISTIC time budget runs out (a work counter, not the
# wall clock), whichever comes first. With interleaved (deterministic)
# parallel search, the same inputs always give the same plan, on any
# machine speed. Measured on the real whole-ED week (18 patterns): effort
# 'standard' ~6 s wall, within ~4% of the proven bound.
OPTIMALITY_GAP = 0.001
EFFORT_DETERMINISTIC_SECONDS = {"quick": 5, "standard": 15, "thorough": 45}


class Pattern(BaseModel):
    start: int = Field(ge=0, lt=HOURS)
    length: int = Field(ge=1, le=HOURS)

    def hours(self) -> list[int]:
        return [(self.start + i) % HOURS for i in range(self.length)]


class Slot(BaseModel):
    id: str
    flex: bool = False
    # [day][hour] — attending shifts that are fixed and already counted.
    locked: list[list[int]]
    # [day][hour] — upper bound on attendings on this slot, INCLUDING locked.
    maxAttendings: list[list[int]]
    # [day][hour][n] — capacity (patients/hr) with n attendings on, for
    # n = 0..len-1. Must cover n up to maxAttendings.
    capacity: list[list[list[float]]]


COVERAGE_MODES = ("REQUIRED_DEDICATED", "CROSS_COVERED", "CLOSED", "FLEXIBLE")
NO_PLACEMENT_MODES = ("CROSS_COVERED", "CLOSED")


class Area(BaseModel):
    key: str
    demand: list[list[float]]           # [day][hour], patients/hr
    excessTolerance: list[list[float]]  # [day][hour], surplus that isn't "excess"
    minCoverage: list[list[int]]        # [day][hour], min attendings in the area
    slots: list[Slot]
    # Patients/hr one attending in this area can be responsible for,
    # supervision included (pph[area]). Needed when the area cross-covers.
    supervisionCeilingPph: Optional[float] = Field(default=None, ge=0)
    requirementLabels: list[str] = []
    maxCoverage: Optional[list[list[int]]] = None     # [day][hour], most attendings in the area at once
    coverageMode: Optional[list[list[str]]] = None   # [day][hour], COVERAGE_MODES


class CrossCover(BaseModel):
    area: str
    coveredBy: str
    # [day][hour] 1 where the covering area is responsible when `area` has no
    # own attending (in-scope area; the solver checks the attending count),
    # or where cross-coverage is active (out-of-scope area, fixed schedule).
    eligible: list[list[int]]
    # [day][hour] the area's CREDITABLE resident/PA capacity (patients/hr).
    supervised: list[list[float]]
    # Covered-area patients/hr credited per 1 patient/hr of covering headroom.
    headroomFactor: float = Field(ge=0)


class CoveringArea(BaseModel):
    """A covering area OUTSIDE the instance: its schedule is fixed, so its
    supervision ceiling and expected load are constants."""
    ceiling: list[list[float]]   # [day][hour] sum of attendings x ceiling
    load: list[list[float]]      # [day][hour] the area's own expected demand


class HintShift(BaseModel):
    """One planned shift from an earlier solve, used as a warm start."""
    area: str
    slot: str
    day: str
    start: int
    length: int


# Planning modes (the attending staffing question each answers):
#   budget        — "Where should at most X attending-h/week go?"
#   requirement   — fewest hours with no area-hour short by more than
#                   allowedDeficitPph (per-hour cap; kept for existing use)
#   target        — fewest hours reaching a modeled coverage target and/or a
#                   cap on unmet patient-h/week, overall and/or per area
#   min_practical — "What would this model ask for without a budget?":
#                   (1) least achievable unmet demand, (2) fewest hours within
#                   practicalTolerancePct of it, (3) best placement of those hours
# Coverage = 1 - unmet / demand, unmet summed per AREA-hour (never pooled).
PLANNING_MODES = ("budget", "requirement", "target", "min_practical")


class Instance(BaseModel):
    mode: Literal["budget", "requirement", "target", "min_practical"] = "budget"
    days: list[str]
    patterns: list[Pattern]
    areas: list[Area]
    budgetHours: Optional[float] = Field(default=None, ge=0)   # weekly; budget mode
    lockedHours: float = Field(default=0, ge=0)                # weekly, already in slots' locked
    allowedDeficitPph: float = Field(default=0, ge=0)          # requirement mode
    # target mode: any combination; the tightest resulting cap applies.
    targetCoverage: Optional[float] = Field(default=None, ge=0, le=1)       # whole scope, fraction
    maxUnmetPph: Optional[float] = Field(default=None, ge=0)                # whole scope, patient-h/week
    areaTargetCoverage: dict[str, float] = {}                               # area -> fraction
    areaMaxUnmetPph: dict[str, float] = {}                                  # area -> patient-h/week
    # min_practical mode: unmet within this many coverage points of the least
    # achievable counts as "effectively equivalent" (so tiny modeled gains
    # never justify large hour increases).
    practicalTolerancePct: float = Field(default=0.5, ge=0, le=100)
    # Optional warm start (e.g. the neighbouring point of a resource frontier).
    hint: list[HintShift] = []
    effort: Literal["quick", "standard", "thorough"] = "standard"
    crossCover: list[CrossCover] = []
    coveringAreas: dict[str, CoveringArea] = {}
    # Wall-clock safety net only; the deterministic budget normally ends the
    # search first. Hitting this makes results timing-dependent.
    timeLimitSeconds: float = Field(default=120, gt=0, le=300)
    workers: int = Field(default=8, ge=1, le=32)

    @model_validator(mode="after")
    def _check_shapes(self):
        nd = len(self.days)
        if nd == 0:
            raise ValueError("at least one day is required")
        if not self.patterns:
            raise ValueError("at least one shift pattern is required")
        if not self.areas:
            raise ValueError("at least one area is required")
        if self.mode == "budget" and self.budgetHours is None:
            raise ValueError("budgetHours is required in budget mode")
        if self.mode == "target" and self.targetCoverage is None and self.maxUnmetPph is None \
                and not self.areaTargetCoverage and not self.areaMaxUnmetPph:
            raise ValueError("target mode needs targetCoverage, maxUnmetPph, or a per-area target")
        area_keys = {a.key for a in self.areas}
        for name, d in (("areaTargetCoverage", self.areaTargetCoverage), ("areaMaxUnmetPph", self.areaMaxUnmetPph)):
            for k, v in d.items():
                if k not in area_keys:
                    raise ValueError(f"{name}: area {k!r} is not in the instance")
                if v < 0 or (name == "areaTargetCoverage" and v > 1):
                    raise ValueError(f"{name}[{k}] out of range")

        def grid(name, g):
            if len(g) != nd or any(len(row) != HOURS for row in g):
                raise ValueError(f"{name} must be [{nd} days][24 hours]")

        for a in self.areas:
            grid(f"{a.key}.demand", a.demand)
            grid(f"{a.key}.excessTolerance", a.excessTolerance)
            grid(f"{a.key}.minCoverage", a.minCoverage)
            if not a.slots:
                raise ValueError(f"area {a.key} has no slots")
            for s in a.slots:
                grid(f"{a.key}/{s.id}.locked", s.locked)
                grid(f"{a.key}/{s.id}.maxAttendings", s.maxAttendings)
                if len(s.capacity) != nd or any(len(row) != HOURS for row in s.capacity):
                    raise ValueError(f"{a.key}/{s.id}.capacity must be [{nd}][24][n]")
                for d in range(nd):
                    for h in range(HOURS):
                        lo, hi = s.locked[d][h], s.maxAttendings[d][h]
                        if lo < 0 or hi < lo:
                            raise ValueError(
                                f"{a.key}/{s.id} {self.days[d]} {h:02d}:00: "
                                f"maxAttendings {hi} is below locked {lo}")
                        if len(s.capacity[d][h]) < hi + 1:
                            raise ValueError(
                                f"{a.key}/{s.id} {self.days[d]} {h:02d}:00: "
                                f"capacity table needs {hi + 1} entries")
            if a.maxCoverage is not None:
                grid(f"{a.key}.maxCoverage", a.maxCoverage)
                for d in range(nd):
                    for h in range(HOURS):
                        if a.maxCoverage[d][h] < a.minCoverage[d][h]:
                            raise ValueError(
                                f"{a.key} {self.days[d]} {h:02d}:00: minimum {a.minCoverage[d][h]} attendings "
                                f"exceeds the area maximum {a.maxCoverage[d][h]}")
            if a.coverageMode is not None:
                grid(f"{a.key}.coverageMode", a.coverageMode)
                for d in range(nd):
                    for h in range(HOURS):
                        mode = a.coverageMode[d][h]
                        if mode not in COVERAGE_MODES:
                            raise ValueError(f"{a.key}.coverageMode: unknown mode {mode!r}")
                        if mode in NO_PLACEMENT_MODES and any(
                                s.maxAttendings[d][h] != s.locked[d][h] for s in a.slots):
                            raise ValueError(
                                f"{a.key} {self.days[d]} {h:02d}:00 is {mode}: no slot may take "
                                f"attendings beyond its locked ones (maxAttendings must equal locked)")

        keys = [a.key for a in self.areas]
        if len(set(keys)) != len(keys):
            raise ValueError("area keys must be unique")
        seen = set()
        for c in self.crossCover:
            if c.area == c.coveredBy:
                raise ValueError(f"crossCover: {c.area} cannot cover itself")
            if c.area in seen:
                raise ValueError(f"crossCover: {c.area} listed twice")
            seen.add(c.area)
            grid(f"crossCover[{c.area}].eligible", c.eligible)
            grid(f"crossCover[{c.area}].supervised", c.supervised)
            if c.coveredBy in keys:
                cover = next(a for a in self.areas if a.key == c.coveredBy)
                if cover.supervisionCeilingPph is None:
                    raise ValueError(f"area {c.coveredBy} cross-covers {c.area} but has no supervisionCeilingPph")
            elif c.coveredBy in self.coveringAreas:
                grid(f"coveringAreas[{c.coveredBy}].ceiling", self.coveringAreas[c.coveredBy].ceiling)
                grid(f"coveringAreas[{c.coveredBy}].load", self.coveringAreas[c.coveredBy].load)
            else:
                raise ValueError(f"crossCover: covering area {c.coveredBy} is neither in the instance nor in coveringAreas")
        return self


# ── Result ────────────────────────────────────────────────────────────────────

class PlannedShift(BaseModel):
    area: str
    slot: str
    flex: bool
    day: str
    start: int
    length: int


class HoursSummary(BaseModel):
    budget: Optional[float]      # weekly budget as given (None in requirement mode)
    usableBudget: Optional[float]  # budget rounded DOWN to the half-hour granularity
    locked: float
    optimized: float
    total: float
    unallocated: Optional[float]  # budget - total


class Result(BaseModel):
    status: Literal["optimal", "feasible", "infeasible", "invalid", "timeout"]
    message: str
    shifts: list[PlannedShift] = []
    hours: Optional[HoursSummary] = None
    # Solver's own view, for cross-checking against capacity.js:
    modeledCapacity: dict[str, list[list[float]]] = {}   # area -> [day][hour], incl. cross-cover credit
    crossCoverCredit: dict[str, list[list[float]]] = {}  # covered area -> [day][hour]
    objective: dict[str, float] = {}
    stats: dict[str, float] = {}
    diagnosis: dict[str, Any] = {}
    # target / min_practical: what was asked, what was achievable, the
    # hours found and their proven lower bound, and each solve stage.
    planning: dict[str, Any] = {}


def scale_pph(v: float) -> int:
    return int(round(v * PPH_SCALE))


def hours_to_units(h: float) -> int:
    """Hours -> half-hour units, rounding to nearest (inputs are :00/:30)."""
    return int(round(h * TIME_UNITS_PER_HOUR))


def budget_units(h: float) -> int:
    """Budget hours -> half-hour units, rounding DOWN: never exceed the budget."""
    return math.floor(h * TIME_UNITS_PER_HOUR + 1e-9)
