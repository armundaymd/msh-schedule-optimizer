import { describe, it, expect } from 'vitest'
import { SENSITIVITY_PARAMETERS, planStructure, compareStructures, robustness, crossEvaluate, MATERIAL_CHANGE_SHARE } from './sensitivity'
import { analyzeWeek } from './weekCoverage'
import { DEFAULT_PPH } from './pph'

const DAYS = ['Monday']
const att = (team, startH, endH) => ({ team, role_type: 'Attending', startMins: startH * 60, endMins: endH * 60 })
const structure = shifts => planStructure({ days: DAYS, shiftsForDay: () => shifts, scope: 'mainEru' })
const flat = v => Array(24).fill(v)

describe('SENSITIVITY_PARAMETERS', () => {
  const inputs = { pph: DEFAULT_PPH, target: 'mean' }

  it('the Main sweep is 1.9-2.3 around the configured 2.1, without mutating the defaults', () => {
    const p = SENSITIVITY_PARAMETERS.mainCeiling
    expect(p.values).toEqual([1.9, 2.0, 2.1, 2.2, 2.3])
    expect(p.baseline(inputs)).toBe(2.1)
    const v = p.apply(inputs, 1.9)
    expect(v.pph.main).toBe(1.9)
    expect(v.pph.eru).toBe(DEFAULT_PPH.eru)
    expect(DEFAULT_PPH.main).toBe(2.1)
  })

  it('a ceiling is never set below solo throughput', () => {
    const v = SENSITIVITY_PARAMETERS.eruCeiling.apply(inputs, 0.5)
    expect(v.pph.eruOwn).toBeLessThanOrEqual(v.pph.eru)
  })

  it('productivity multipliers scale only their own keys', () => {
    const r = SENSITIVITY_PARAMETERS.residentProductivity.apply(inputs, 1.2)
    expect(r.pph.pgy4).toBeCloseTo(DEFAULT_PPH.pgy4 * 1.2, 10)
    expect(r.pph.pa).toBe(DEFAULT_PPH.pa)
    const p = SENSITIVITY_PARAMETERS.paProductivity.apply(inputs, 0.8)
    expect(p.pph.pa).toBeCloseTo(DEFAULT_PPH.pa * 0.8, 10)
    expect(p.pph.pgy2).toBe(DEFAULT_PPH.pgy2)
  })

  it('demand target changes only the target', () => {
    expect(SENSITIVITY_PARAMETERS.demandTarget.apply(inputs, 'p90')).toEqual({ pph: DEFAULT_PPH, target: 'p90' })
  })
})

describe('compareStructures', () => {
  it('identical plans with different team names are the same structure', () => {
    const a = structure([att('Green', 8, 16), att('ERU', 9, 17)])
    const b = structure([att('Red', 8, 16), att('ERU', 9, 17)])
    expect(compareStructures(a, b)).toMatchObject({ shiftJaccard: 1, movedHours: 0, material: false })
  })

  it('counts attending-hours placed differently once', () => {
    const a = structure([att('Green', 8, 16)])
    const b = structure([att('Green', 10, 18)]) // 2 h moved (08-10 -> 16-18)
    const c = compareStructures(a, b)
    expect(c.movedHours).toBe(2)
    expect(c.movedShare).toBeCloseTo(2 / 8, 10)
    expect(c.material).toBe(2 / 8 > MATERIAL_CHANGE_SHARE)
    expect(c.shiftJaccard).toBe(0)
  })
})

describe('robustness', () => {
  const demand = { Main: { overall: flat(2) }, ERU: { overall: flat(0) } }
  const pphs = [1.9, 2.1, 2.3].map(v => ({ ...DEFAULT_PPH, main: v, mainOwn: v }))
  const currentShifts = [att('Green', 0, 8), att('ERU', 0, 24)]
  const week = (shifts, pph) => analyzeWeek({ days: DAYS, shiftsForDay: () => shifts, demand, pph, scope: 'mainEru' })

  // Every plan adds Main 08:00-16:00; only some add 16:00-24:00.
  const plans = [
    [att('Green', 0, 8), att('Red', 8, 16)],
    [att('Green', 0, 8), att('Red', 8, 16), att('Blue', 16, 24)],
    [att('Green', 0, 8), att('Red', 8, 16), att('Blue', 16, 24)],
  ]
  const r = robustness({
    variants: plans.map((p, i) => ({ value: i, structure: structure(p), week: week(p, pphs[i]) })),
    current: { structure: structure(currentShifts), weeks: pphs.map(pph => week(currentShifts, pph)) },
  })

  it('finds periods where every plan adds coverage', () => {
    expect(r.alwaysAdds).toEqual([{ area: 'main', day: 'Monday', hours: [8, 9, 10, 11, 12, 13, 14, 15] }])
  })

  it('finds where the current schedule is short / has excess under every assumption', () => {
    expect(r.currentShortEverywhere.find(x => x.area === 'main').hours).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])
    // ERU attending (0.8/hr) against zero demand is below the 1/hr excess tolerance: not excess.
    expect(r.currentExcessEverywhere).toEqual([])
  })

  it('separates shifts in every plan from shifts in most plans', () => {
    const key = s => `${s.area} ${s.start}+${s.length} x${s.copies}`
    expect(r.stableShifts.map(key).sort()).toEqual(['main 0+8 x1', 'main 8+8 x1'])
    expect(r.commonShifts).toEqual([]) // 16:00 is in 2 of 3 (< 80%)
    expect(r.areaHourRange.main).toEqual({ min: 16, max: 24, current: 8 })
  })
})

describe('crossEvaluate', () => {
  it('scores every schedule under every assumption (a plan is only as good as the assumption it is tested against)', () => {
    const demand = { Main: { overall: flat(2) } }
    const oneAttending = [att('Green', 0, 24)] // no residents: 1 attending delivers mainOwn
    const assumptions = [1.5, 2].map(v => ({ pph: { ...DEFAULT_PPH, main: v, mainOwn: v }, target: 'mean' }))
    const [[low, high]] = crossEvaluate({ days: DAYS, demand, scope: 'main', schedules: [{ shiftsForDay: () => oneAttending }], assumptions })
    expect(low.unmet).toBeCloseTo(24 * 0.5, 10)
    expect(high.unmet).toBe(0)
    expect(high.coveragePct).toBe(100)
  })
})
