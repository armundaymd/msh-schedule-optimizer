"""
Command-line entry: solve one instance read as JSON from stdin, write the
result JSON to stdout. Used by the frontend validation suite
(frontend/validation/) to run the real solver end to end without the web
server:

    python -m staffing < instance.json
    python -m staffing --describe      # model constants as JSON (for reports)
"""

import json
import sys

from . import model
from .model import Instance
from .service import solve


def describe() -> dict:
    """The objective's scaling, penalties and search settings, straight from
    model.py, so reports quote what the solver actually uses."""
    return {
        "pphScale": model.PPH_SCALE,
        "timeUnitsPerHour": model.TIME_UNITS_PER_HOUR,
        "deficitTierBoundsPph": [b / model.PPH_SCALE for b in model.DEFICIT_TIER_BOUNDS],
        "deficitTierWeights": list(model.DEFICIT_TIER_WEIGHTS),
        "excessWeight": model.EXCESS_WEIGHT,
        "hourWeight": model.HOUR_WEIGHT,
        "optimalityGap": model.OPTIMALITY_GAP,
        "effortDeterministicSeconds": model.EFFORT_DETERMINISTIC_SECONDS,
    }


def main() -> int:
    if "--describe" in sys.argv[1:]:
        json.dump(describe(), sys.stdout)
        return 0
    instance = Instance(**json.load(sys.stdin))
    json.dump(solve(instance).model_dump(), sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
