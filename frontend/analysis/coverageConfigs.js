// Coverage-config variants shared by the analysis runs.
import { COVERAGE_MODE, cloneCoverageConfig } from '../src/shared/operationalCoverage'

// The operational configuration with the REQUIRED_DEDICATED rules of
// `areas` turned into FLEXIBLE, falling back to the area default's covering
// area (ERU -> Main cross-cover). Used (1) as the common THROUGHPUT scoring
// model — whenever ERU has no attending of its own, Main covers it — and
// (2) as a diagnostic plan isolating what keeping the current ERU dedicated
// coverage as a hard rule costs.
export function relaxRequirements(config, areas) {
  const c = cloneCoverageConfig(config)
  for (const area of areas) {
    const ac = c.areas[area]
    if (!ac) continue
    const relax = r => (r.mode === COVERAGE_MODE.REQUIRED_DEDICATED
      ? { ...r, mode: COVERAGE_MODE.FLEXIBLE, minAttendings: undefined, coveredBy: ac.default.coveredBy, label: r.label ? `${r.label} (relaxed)` : undefined }
      : r)
    ac.default = relax(ac.default)
    ac.rules = ac.rules.map(relax)
  }
  return JSON.parse(JSON.stringify(c))
}

