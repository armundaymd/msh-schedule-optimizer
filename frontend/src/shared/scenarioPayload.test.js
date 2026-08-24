import { describe, it, expect } from 'vitest'
import { buildScenarioPayload, scenarioPayloadToSnapshot } from './scenarioPayload'

function fakeSchedState(byDay) {
  return { getShiftsForDay: day => byDay[day] ?? [] }
}

describe('buildScenarioPayload', () => {
  it('converts internal shifts to export-row format, never leaking id/startMins/endMins', () => {
    const schedState = fakeSchedState({
      Monday: [{
        id: 'internal-id-1', day: 'Monday', team: 'Green',
        role_type: 'Attending', role_detail: 'Attending', resident_level: null,
        start_time: '07:00', end_time: '15:00', startMins: 420, endMins: 900,
      }],
    })
    const payload = buildScenarioPayload({
      schedState, pph: { main: 2.1 }, costRates: { attending: 250 }, customTeams: [], target: 'mean',
    })

    expect(payload.shifts.Monday).toEqual([{
      day_type: 'Monday', team: 'Green', role_type: 'Attending',
      role_detail: 'Attending', resident_level: '', start_time: '07:00', end_time: '15:00',
    }])
    expect(payload.shifts.Tuesday).toEqual([])
    expect(payload.pph).toEqual({ main: 2.1 })
    expect(payload.target).toBe('mean')
    expect(payload.generatorSettings).toBeUndefined()
  })

  it('includes generatorSettings only when provided', () => {
    const schedState = fakeSchedState({})
    const payload = buildScenarioPayload({
      schedState, pph: {}, costRates: {}, customTeams: [], target: 'mean',
      generatorSettings: { area: 'main' },
    })
    expect(payload.generatorSettings).toEqual({ area: 'main' })
  })
})

describe('scenarioPayloadToSnapshot', () => {
  it('round-trips a saved payload back into normalized shifts with startMins/endMins', () => {
    const payload = {
      shifts: {
        Monday: [{
          day_type: 'Monday', team: 'Green', role_type: 'Attending',
          role_detail: 'Attending', resident_level: '', start_time: '07:00', end_time: '15:00',
        }],
      },
    }
    const snap = scenarioPayloadToSnapshot(payload)
    expect(snap.Monday).toHaveLength(1)
    expect(snap.Monday[0]).toMatchObject({ team: 'Green', startMins: 420, endMins: 900 })
    expect(snap.Monday[0].id).toBeTruthy()
  })

  it('handles overnight shifts (end <= start wraps past midnight)', () => {
    const payload = {
      shifts: {
        Monday: [{
          day_type: 'Monday', team: 'Blue', role_type: 'Attending',
          role_detail: 'Attending', resident_level: '', start_time: '23:00', end_time: '07:00',
        }],
      },
    }
    const snap = scenarioPayloadToSnapshot(payload)
    expect(snap.Monday[0].startMins).toBe(23 * 60)
    expect(snap.Monday[0].endMins).toBe(7 * 60 + 1440)
  })

  it('never throws on a payload with no shifts key', () => {
    expect(scenarioPayloadToSnapshot({})).toEqual({})
  })
})
