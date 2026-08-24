// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

// main/fasttrack/eru = attending supervision ceiling PPH (existing key, existing number).
// *Own = attending solo throughput PPH. These are assumptions, not measurements:
// across the whole current schedule there are only 10 team-hours with an attending
// and no extender coverage (all Blue, hours 23 and 00, at the tail of a 17:00-01:00
// shift), so solo throughput cannot be estimated from this dataset. Do not present
// these numbers in the UI as empirical.
// pa/pgy1-4/offService = Resident & PA max PPH, single value app-wide.
export const DEFAULT_PPH = {
  main: 2.1,  mainOwn: 1.3,
  fasttrack: 3.5, fasttrackOwn: 2.2,
  eru: 0.8,   eruOwn: 0.6,
  pa: 1.2, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}
