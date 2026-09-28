import { useCallback, useEffect, useState } from 'react'
import { fetchSchedule, fetchDemand, fetchSummary, postRefresh, fetchRefreshStatus, fetchScenarios, createScenario, deleteScenario } from '../shared/api'
import { useScheduleState } from '../shared/hooks/useScheduleState'
import { useCommandStack } from './hooks/useCommandStack'
import { buildScenarioPayload, scenarioOperationalCoverage, scenarioPayloadToSnapshot } from '../shared/scenarioPayload'
import { serializePlannerSettings } from '../shared/attendingPlanner'
import { COVERAGE_MODE, DEFAULT_OPERATIONAL_COVERAGE, cloneCoverageConfig, effectiveMaxAttendings, resolveCoverage } from '../shared/operationalCoverage'
import { shiftCoversHour, scopeCapacity } from '../shared/capacity'
import { getDemandSeries, getScopeDemandSeries, hasPercentiles } from '../shared/demandSeries'
import { AREA_LABEL, SCOPE_LABEL, scopeAreas, teamsInArea } from '../shared/areas'
import TopBar from './components/TopBar'
import DowTabs from '../shared/components/DowTabs'
import Timeline from './components/Timeline'
import PphChart from './components/PphChart'
import SummaryStatsBar from './components/SummaryStatsBar'
import WeekHeatmap from './components/WeekHeatmap'
import StaffingPlan from './components/StaffingPlan'
import HelpPanel from './components/Help/HelpPanel'
import { HelpContext } from './help/HelpContext'
import OptimizeModal from './components/OptimizeModal'
import ConstraintsPanel from './components/Generator/ConstraintsPanel'
import GeneratorResult from './components/Generator/GeneratorResult'
import ScenariosPanel from './components/Scenarios/ScenariosPanel'
import ConfirmDialog from '../shared/components/ConfirmDialog'
import { getOverflowHours, runOptimizer } from './utils/optimizer'
import { exportScheduleAs } from './utils/exportSchedule'
import { generateSchedule, assignTeams, applyGeneratedAttendings, attendingHoursAndCost } from './utils/generator'
import { computeShiftCost } from '../shared/cost'
import { DEFAULT_PPH } from '../shared/pph'

const DEFAULT_COST_RATES = { attending: 250, pa: 90 }
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

// V3 shares V2's scenario list: the backend (server.py VALID_VERSIONS and
// the scenarios table's CHECK constraint) only accepts 'legacy' and 'v2',
// and the payloads are compatible (V3 only adds an optional staffingPlan
// field, which V2 ignores). A separate 'v3' list needs a DB migration.
const SCENARIO_VERSION = 'v2'
// Same cap the TopBar's Save scenario button enforces.
const MAX_SCENARIOS = 5

// Scope groups: [{ label, anchorDay (used to compute the schedule),
// days (which concrete days get that same generated schedule applied) }]
// Default (templates) mirrors the current baseline, which is effectively
// three templates already — generating seven independent days produces
// noise that reads as signal (PHASE 4 brief, 4.4).
function resolveScopeGroups(scope, activeDow) {
  if (scope === 'day') return [{ label: activeDow, anchorDay: activeDow, days: [activeDow] }]
  if (scope === 'week') return DAYS.map(d => ({ label: d, anchorDay: d, days: [d] }))
  return [
    { label: 'Weekday', anchorDay: 'Monday', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] },
    { label: 'Saturday', anchorDay: 'Saturday', days: ['Saturday'] },
    { label: 'Sunday', anchorDay: 'Sunday', days: ['Sunday'] },
  ]
}

function attendingHrs(list) {
  return list.filter(s => s.role_type === 'Attending')
    .reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
}

function capacitySeries(shifts, pph, customTeams, scope) {
  return Array.from({ length: 24 }, (_, h) => scopeCapacity(shifts, pph, customTeams, scope, h))
}

function App() {
  const [activeDow, setActiveDow] = useState('Monday')
  // Analysis/optimization scope: an area key or a combined scope key (shared/areas.js).
  const [activeScope, setActiveScope] = useState('main')
  const [target, setTarget] = useState('mean')
  const [demand, setDemand] = useState(null)
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [pph, setPph] = useState(DEFAULT_PPH)
  const [scenarios, setScenarios] = useState([])
  const [comparisonScenarioId, setComparisonScenarioId] = useState(null)
  const [customTeams, setCustomTeams] = useState([])
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeResult, setOptimizeResult] = useState(null)
  const [optimizePreCustomTeams, setOptimizePreCustomTeams] = useState(null)
  const [toast, setToast] = useState(null)
  const [costRates, setCostRates] = useState(DEFAULT_COST_RATES)
  const [costModeEnabled, setCostModeEnabled] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatorResult, setGeneratorResult] = useState(null)
  const [generatorPreCustomTeams, setGeneratorPreCustomTeams] = useState(null)
  const [generatorPreview, setGeneratorPreview] = useState('generated') // 'generated' | 'current'
  const [hoverHour, setHoverHour] = useState(null)
  const [timelineFocus, setTimelineFocus] = useState(null) // { hour } — a new object per request
  const [hiddenTeams, setHiddenTeams] = useState(() => new Set())
  const [scenariosOpen, setScenariosOpen] = useState(false)
  const [helpSection, setHelpSection] = useState(null) // help/helpContent.js section id | null
  const openHelp = useCallback(section => setHelpSection(section ?? 'start'), [])
  const closeHelp = useCallback(() => setHelpSection(null), [])
  const [staffingPlanOpen, setStaffingPlanOpen] = useState(false)
  // Planner settings (mode + inputs) from the last restored scenario, if it had any.
  const [plannerRestore, setPlannerRestore] = useState(null)
  // Operational attending coverage rules (shared/operationalCoverage.js):
  // edited in the staffing planner, saved with and restored from scenarios.
  const [operationalCoverage, setOperationalCoverage] = useState(() => cloneCoverageConfig(DEFAULT_OPERATIONAL_COVERAGE))
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('v2-theme') ?? 'dark' } catch { return 'dark' }
  })

  useEffect(() => {
    try { localStorage.setItem('v2-theme', theme) } catch { /* private browsing, storage disabled */ }
    // Also mirrored onto document.body: ShiftTooltip portals to
    // document.body to escape Timeline's clipping scroll container, which
    // means it renders outside this component's data-theme div and can't
    // inherit the CSS variables from it. Legacy has no CSS keyed off
    // data-theme, so this is a no-op there.
    document.body.dataset.theme = theme
    return () => { delete document.body.dataset.theme }
  }, [theme])
  const [removeTeamConfirm, setRemoveTeamConfirm] = useState(null) // team name | null

  const scopeLabel = SCOPE_LABEL[activeScope]
  // The generator builds one area's schedule at a time; a combined scope
  // opens it on that scope's first area.
  const generatorArea = scopeAreas(activeScope)[0]

  const schedState = useScheduleState()
  // One command stack for all of v2's shift edits (PHASE 5, 5.4) — day
  // edits, drags, auto-optimize, and schedule generation all push through
  // this instead of schedState's own per-day undo stacks (which legacy
  // keeps using unchanged) or a bespoke preOptimizeSnapshot mechanism.
  const commandStack = useCommandStack(schedState)

  function handlePphChange(key, val) {
    setPph(prev => ({ ...prev, [key]: val }))
  }

  function handleCostRateChange(key, val) {
    setCostRates(prev => ({ ...prev, [key]: val }))
  }

  function handleExport(format) {
    exportScheduleAs(schedState, format)
  }

  async function handleSaveScenario(name) {
    const payload = buildScenarioPayload({ schedState, pph, costRates, customTeams, target, operationalCoverage })
    try {
      const saved = await createScenario(SCENARIO_VERSION, name, payload)
      setScenarios(prev => [saved, ...prev])
    } catch (e) {
      console.error(e)
      showToast('✗ Failed to save scenario')
    }
  }

  async function handleDeleteScenario(id) {
    try {
      await deleteScenario(id)
      setScenarios(prev => prev.filter(s => s.id !== id))
      if (comparisonScenarioId === id) setComparisonScenarioId(null)
    } catch (e) {
      console.error(e)
      showToast('✗ Failed to delete scenario')
    }
  }

  function handleResetToScenario(id) {
    const sc = scenarios.find(s => s.id === id)
    if (!sc) return
    commandStack.pushCommand('global', DAYS, `Restore scenario ${sc.name}`)
    schedState.loadSnapshot(scenarioPayloadToSnapshot(sc.payload))
    if (sc.payload.pph) setPph({ ...sc.payload.pph })
    if (sc.payload.customTeams) setCustomTeams([...sc.payload.customTeams])
    if (sc.payload.target) setTarget(sc.payload.target)
    if (sc.payload.costRates) setCostRates({ ...sc.payload.costRates })
    const coverage = scenarioOperationalCoverage(sc.payload)
    if (coverage) setOperationalCoverage(coverage)
    setPlannerRestore(sc.payload.staffingPlan?.settings ?? null)
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleAutoOptimize() {
    const overflow = getOverflowHours(shifts, demand, pph, activeDow, customTeams, activeScope, target)
    if (overflow.length === 0) {
      showToast(`✓ No overflow — ${scopeLabel} already meets demand`)
      return
    }
    setOptimizing(true)
    await new Promise(r => setTimeout(r, 280))
    const result = runOptimizer(shifts, demand, pph, activeDow, customTeams, activeScope, target, { coverage: operationalCoverage })
    commandStack.pushCommand('day', [activeDow], `Auto-optimize ${scopeLabel}`)
    schedState.applyDayShifts(activeDow, result.newShifts)
    setOptimizePreCustomTeams(customTeams)
    const afterCustomTeams = result.newTeams.length > 0 ? [...customTeams, ...result.newTeams] : customTeams
    if (result.newTeams.length > 0) setCustomTeams(prev => [...prev, ...result.newTeams])

    const demandSeriesForDay = getScopeDemandSeries(demand, activeScope, activeDow, target)
    setOptimizeResult({
      ...result,
      demandSeries: demandSeriesForDay,
      beforeCoverage: capacitySeries(shifts, pph, customTeams, activeScope),
      afterCoverage: capacitySeries(result.newShifts, pph, afterCustomTeams, activeScope),
    })
    setOptimizing(false)
  }

  async function handleAutoOptimizeWeek() {
    const anyOverflow = DAYS.some(day =>
      getOverflowHours(schedState.getShiftsForDay(day), demand, pph, day, customTeams, activeScope, target).length > 0
    )
    if (!anyOverflow) {
      showToast(`✓ No overflow — ${scopeLabel} already meets demand all week`)
      return
    }
    setOptimizing(true)
    await new Promise(r => setTimeout(r, 280))

    commandStack.pushCommand('week', DAYS, `Auto-optimize ${scopeLabel} (week)`)
    setOptimizePreCustomTeams(customTeams)

    let accumulatedCustomTeams = [...customTeams]
    const perDay = {}
    let totalResolved = 0
    let totalOverflow = 0
    const allNewTeams = []

    DAYS.forEach(day => {
      const dayShifts = schedState.getShiftsForDay(day)
      const beforeCoverage = capacitySeries(dayShifts, pph, customTeams, activeScope)
      const result = runOptimizer(dayShifts, demand, pph, day, accumulatedCustomTeams, activeScope, target, { coverage: operationalCoverage })
      schedState.applyDayShifts(day, result.newShifts)
      if (result.newTeams.length > 0) {
        accumulatedCustomTeams = [...accumulatedCustomTeams, ...result.newTeams]
        allNewTeams.push(...result.newTeams)
      }
      perDay[day] = {
        ...result,
        demandSeries: getScopeDemandSeries(demand, activeScope, day, target),
        beforeCoverage,
        afterCoverage: capacitySeries(result.newShifts, pph, accumulatedCustomTeams, activeScope),
      }
      totalResolved += result.resolvedCount
      totalOverflow += result.totalOverflow
    })

    if (allNewTeams.length > 0) setCustomTeams(accumulatedCustomTeams)

    setOptimizeResult({ isWeek: true, perDay, resolvedCount: totalResolved, totalOverflow, changes: [], blocked: [] })
    setOptimizing(false)
  }

  function handleAcceptOptimize() {
    setOptimizeResult(null)
    setOptimizePreCustomTeams(null)
  }

  function handleDiscardOptimize() {
    commandStack.undo()
    if (optimizePreCustomTeams) setCustomTeams(optimizePreCustomTeams)
    setOptimizeResult(null)
    setOptimizePreCustomTeams(null)
  }

  function handleAddCustomTeam(team) {
    setCustomTeams(prev => [...prev, team])
  }

  function handleRemoveCustomTeam(name) {
    commandStack.pushCommand('global', DAYS, `Remove team ${name}`)
    setCustomTeams(prev => prev.filter(t => t.name !== name))
    const snap = {}
    DAYS.forEach(day => {
      snap[day] = schedState.getShiftsForDay(day).filter(s => s.team !== name)
    })
    schedState.loadSnapshot(snap)
  }

  // 4.1-4.6: build one shift set covering per scope group, assign to teams,
  // merge into each day's schedule (preserving other areas' shifts), and
  // show the aggregate result for accept/discard.
  async function handleGenerate(config) {
    setGeneratorOpen(false)
    setGenerating(true)
    await new Promise(r => setTimeout(r, 200))

    const { area, target: genTarget, patterns, scope, constraints } = config
    const groups = resolveScopeGroups(scope, activeDow)
    const affectedDays = [...new Set(groups.flatMap(g => g.days))]

    commandStack.pushCommand(affectedDays.length > 1 ? 'week' : 'day', affectedDays, `Generate ${AREA_LABEL[area]} schedule`)
    setGeneratorPreCustomTeams(customTeams)

    let accumulatedCustomTeams = [...customTeams]
    // Overflow teams ("Generated Team N") minted for one scope group are
    // reused by the next group/day in this same run instead of each group
    // minting its own fresh set -- otherwise a 3-group (or 7-day) generate
    // multiplies the same handful of needed overflow teams by the group
    // count.
    let reusableAreaTeams = []
    let remainingBudget = constraints.objective === 'maximize-coverage' ? constraints.weeklyHourBudget : null
    const costPerHour = constraints.costPerHour ?? 250

    const resultGroups = []
    const patternCounts = {}
    const preShiftsByDay = {}
    const postShiftsByDay = {}
    let totalHours = 0, totalShiftCount = 0, totalCost = 0, totalUncovered = 0, baselineHours = 0, baselineCost = 0

    // Hard structural rules the Generator may not break (operational config):
    // the area's maximum simultaneous attendings (ERU: one, whatever the
    // panel says) and the hours the area is closed on any day of the group.
    const hardMaxConcurrent = effectiveMaxAttendings(operationalCoverage, area) ?? undefined
    const closedHoursFor = days => (operationalCoverage
      ? Array.from({ length: 24 }, (_, h) => h).filter(h => days.some(d => resolveCoverage(operationalCoverage, area, d, h).mode === COVERAGE_MODE.CLOSED))
      : [])
    const rulesApplied = []
    if (hardMaxConcurrent != null) rulesApplied.push(`${AREA_LABEL[area]}: at most ${hardMaxConcurrent} attending${hardMaxConcurrent === 1 ? '' : 's'} at once (hard rule)`)

    for (const group of groups) {
      const closedHours = closedHoursFor(group.days)
      if (closedHours.length) rulesApplied.push(`${group.label}: no attending during closed hours ${closedHours.map(h => `${String(h).padStart(2, '0')}:00`).join(', ')}`)
      const runConstraints = { ...constraints, hourBudget: remainingBudget, hardMaxConcurrent, closedHours }
      const genResult = generateSchedule({ demand, target: genTarget, day: group.anchorDay, area, patterns, constraints: runConstraints, pph })
      const { shifts: assigned, newTeams } = assignTeams(genResult.shifts, area, reusableAreaTeams, accumulatedCustomTeams.map(t => t.name))
      if (newTeams.length > 0) {
        accumulatedCustomTeams = [...accumulatedCustomTeams, ...newTeams]
        reusableAreaTeams = [...reusableAreaTeams, ...newTeams]
      }

      const areaTeamNames = teamsInArea(area, accumulatedCustomTeams)
      const { hours: groupHours, cost: groupCost } = attendingHoursAndCost(assigned, areaTeamNames, costPerHour)
      if (remainingBudget != null) remainingBudget = Math.max(0, remainingBudget - groupHours)

      for (const p of Object.values(genResult.patternCounts)) {
        const key = `${p.start}-${p.end}`
        patternCounts[key] = { start: p.start, end: p.end, count: (patternCounts[key]?.count ?? 0) + p.count }
      }

      const c = pph[area] ?? 0
      const coverageSeries = Array.from({ length: 24 }, (_, h) =>
        assigned.filter(s => shiftCoversHour(s, h)).length * c
      )
      const demandSeriesForGroup = getDemandSeries(demand, AREA_LABEL[area], group.anchorDay, genTarget)

      resultGroups.push({ label: group.label, days: group.days, demandSeries: demandSeriesForGroup, coverageSeries })

      for (const day of group.days) {
        const existing = schedState.getShiftsForDay(day)
        const dayShifts = assigned.map(s => ({ ...s, day, id: `${s.id}-${day}` }))
        const merged = applyGeneratedAttendings(existing, dayShifts, areaTeamNames)
        preShiftsByDay[day] = existing
        postShiftsByDay[day] = merged
        schedState.applyDayShifts(day, merged)

        const baselineDay = attendingHoursAndCost(schedState.baseline?.filter(s => s.day === day) ?? [], areaTeamNames, costPerHour)
        baselineHours += baselineDay.hours
        baselineCost += baselineDay.cost

        totalHours += groupHours
        totalShiftCount += assigned.length
        totalCost += groupCost
      }
      totalUncovered += genResult.uncovered.reduce((a, b) => a + b, 0) * group.days.length
    }

    if (accumulatedCustomTeams.length > customTeams.length) setCustomTeams(accumulatedCustomTeams)

    setGeneratorResult({
      area: AREA_LABEL[area],
      groups: resultGroups,
      totals: { hours: totalHours, shiftCount: totalShiftCount, cost: totalCost, baselineHours, baselineCost, uncoveredHours: totalUncovered, patternCounts },
      rulesApplied,
      preShiftsByDay,
      postShiftsByDay,
    })
    setGeneratorPreview('generated')
    setGenerating(false)
  }

  // Pure view swap -- lets the panel flip the live Timeline between the
  // pre-generate and generated shifts without touching the undo stack
  // (the single command already pushed at the start of handleGenerate still
  // owns the real undo/redo snapshot regardless of which view is showing).
  function handleToggleGeneratorPreview(mode) {
    if (!generatorResult) return
    setGeneratorPreview(mode)
    const source = mode === 'current' ? generatorResult.preShiftsByDay : generatorResult.postShiftsByDay
    Object.entries(source).forEach(([day, dayShifts]) => schedState.applyDayShifts(day, dayShifts))
  }

  function handleAcceptGenerate() {
    // Accept always finalizes the generated result, even if the panel was
    // left on the "Current" preview when clicked.
    Object.entries(generatorResult.postShiftsByDay).forEach(([day, dayShifts]) => schedState.applyDayShifts(day, dayShifts))
    setGeneratorResult(null)
    setGeneratorPreCustomTeams(null)
    setGeneratorPreview('generated')
  }

  function handleDiscardGenerate() {
    commandStack.undo()
    if (generatorPreCustomTeams) setCustomTeams(generatorPreCustomTeams)
    setGeneratorResult(null)
    setGeneratorPreCustomTeams(null)
    setGeneratorPreview('generated')
  }

  // 5.5: copy the active day's shifts onto other days.
  function handleCopyDayTo(targetDays) {
    if (!targetDays.length) return
    commandStack.pushCommand('week', targetDays, `Copy ${activeDow} to ${targetDays.join(', ')}`)
    const source = schedState.getShiftsForDay(activeDow)
    for (const day of targetDays) {
      const copied = source.map((s, i) => ({ ...s, day, id: `copy-${day}-${Date.now()}-${i}` }))
      schedState.applyDayShifts(day, copied)
    }
    showToast(`✓ Copied ${activeDow} to ${targetDays.length} day${targetDays.length === 1 ? '' : 's'}`)
  }

  // Staffing plan: the proposed week replaces every day in one undoable
  // command. New "Plan ..." teams are added alongside.
  function handleApplyStaffingPlan(plan) {
    // Undo/redo also remove/restore the plan's new teams (only those, so
    // teams added afterwards survive an undo).
    const names = new Set(plan.newTeams.map(t => t.name))
    // Once applied, each new team is an ordinary team (the planner's pooled
    // intake-cutoff scoring applies only while it is the plan being scored).
    const applied = plan.newTeams.map(t => { const c = { ...t }; delete c.plannerPool; return c })
    const addTeams = () => setCustomTeams(prev => [...prev, ...applied.filter(t => !prev.some(p => p.name === t.name))])
    commandStack.pushCommand('week', DAYS, `Apply staffing plan (${SCOPE_LABEL[plan.settings.scope]})`, names.size ? {
      undo: () => setCustomTeams(prev => prev.filter(t => !names.has(t.name))),
      redo: addTeams,
    } : null)
    DAYS.forEach(day => schedState.applyDayShifts(day, plan.proposedByDay[day]))
    if (names.size) addTeams()
    setStaffingPlanOpen(false)
    showToast('✓ Staffing plan applied — undo to revert')
  }

  // Saves the proposed week as a scenario WITHOUT touching the live
  // schedule, and selects it as the chart's comparison line.
  async function handleSaveStaffingPlan(name, plan) {
    if (scenarios.length >= MAX_SCENARIOS) {
      showToast(`✗ Scenario limit reached (${MAX_SCENARIOS}) — delete one first`)
      return
    }
    const payload = buildScenarioPayload({
      schedState: { getShiftsForDay: day => plan.proposedByDay[day] },
      pph, costRates, customTeams: [...customTeams, ...plan.newTeams], target: plan.settings.target,
      operationalCoverage: plan.settings.useCoverage ? plan.settings.coverage : null,
    })
    payload.staffingPlan = {
      settings: serializePlannerSettings(plan.settings), hours: plan.result.hours,
      ...(plan.result.planning && Object.keys(plan.result.planning).length
        ? { planning: { hoursRequired: plan.result.planning.hoursRequired, hoursLowerBound: plan.result.planning.hoursLowerBound, bestAchievable: plan.result.planning.bestAchievable } }
        : {}),
    }
    try {
      const saved = await createScenario(SCENARIO_VERSION, name, payload)
      setScenarios(prev => [saved, ...prev])
      setComparisonScenarioId(saved.id)
      showToast('✓ Saved — shown as the comparison line in the chart')
    } catch (e) {
      console.error(e)
      showToast('✗ Failed to save scenario')
    }
  }

  // Week heatmap click: select the day and focus the hour in the timeline
  // (highlighted via the shared hover hour, scrolled into view if needed).
  // A day-label click (hour null) just selects the day.
  function handleHeatmapSelect(day, hour) {
    setActiveDow(day)
    if (hour == null) return
    setHoverHour(hour)
    setTimelineFocus({ hour })
  }

  // A viewing preference, not schedule data -- doesn't touch schedState or
  // the undo stack, and persists across day-tab switches.
  function handleToggleTeamHidden(team) {
    setHiddenTeams(prev => {
      const next = new Set(prev)
      if (next.has(team)) next.delete(team)
      else next.add(team)
      return next
    })
  }

  useEffect(() => {
    Promise.all([fetchSchedule(), fetchDemand(), fetchSummary()])
      .then(([sched, dem, summ]) => {
        schedState.loadBaseline(sched)
        setDemand(dem)
        setSummary(summ)
        setLoading(false)
      })
      .catch(err => {
        console.error(err)
        setLoading(false)
      })
    fetchScenarios(SCENARIO_VERSION).then(setScenarios).catch(err => console.error(err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // "Refresh data" is shown only where the server allows it (ADMIN_TOKEN set).
  const [refreshEnabled, setRefreshEnabled] = useState(false)
  useEffect(() => { fetchRefreshStatus().then(st => setRefreshEnabled(!!st.enabled)) }, [])

  async function handleRefresh(token = null) {
    setRefreshing(true)
    try {
      await postRefresh(typeof token === 'string' ? token : null)
      const [sched, dem, summ] = await Promise.all([fetchSchedule(), fetchDemand(), fetchSummary()])
      schedState.loadBaseline(sched)
      setDemand(dem)
      setSummary(summ)
      commandStack.clear()
    } catch (e) {
      console.error(e)
      window.alert(e.message)
    }
    setRefreshing(false)
  }

  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        commandStack.undo()
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault()
        commandStack.redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandStack.undo, commandStack.redo])

  // "?" opens Help (ignored while typing in a field).
  useEffect(() => {
    function onKey(e) {
      if (e.key !== '?' || e.metaKey || e.ctrlKey || e.altKey) return
      const el = document.activeElement
      if (el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable)) return
      e.preventDefault()
      openHelp('start')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openHelp])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-[var(--c-text-muted)] text-lg">
        Loading…
      </div>
    )
  }

  const shifts = schedState.getShiftsForDay(activeDow)
  const baselineShifts = schedState.baseline?.filter(s => s.day === activeDow) ?? []

  const weekBreakdown = DAYS.map(d => {
    const dayShifts = schedState.getShiftsForDay(d)
    const baselineDayShifts = schedState.baseline?.filter(s => s.day === d) ?? []
    const proposed = attendingHrs(dayShifts)
    const baseline = attendingHrs(baselineDayShifts)
    const attendingShifts = dayShifts.filter(s => s.role_type === 'Attending').length
    return {
      day: d, proposed, delta: proposed - baseline, attendingShifts,
      cost: computeShiftCost(dayShifts, costRates),
      costBaseline: computeShiftCost(baselineDayShifts, costRates),
    }
  })

  return (
    <HelpContext.Provider value={openHelp}>
    <div data-theme={theme}>
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--c-bg-app)]">
      <TopBar
        summary={summary}
        onRefresh={handleRefresh}
        refreshEnabled={refreshEnabled}
        refreshing={refreshing}
        onResetDay={() => {
          commandStack.pushCommand('day', [activeDow], 'Reset day')
          schedState.resetDay(activeDow)
        }}
        onClearDay={() => {
          commandStack.pushCommand('day', [activeDow], 'Clear day')
          schedState.applyDayShifts(activeDow, [])
        }}
        onClearWeek={() => {
          commandStack.pushCommand('week', DAYS, 'Clear week')
          DAYS.forEach(day => schedState.applyDayShifts(day, []))
        }}
        onSaveScenario={handleSaveScenario}
        scenarioCount={scenarios.length}
        onUndo={commandStack.undo}
        onRedo={commandStack.redo}
        canUndo={commandStack.canUndo()}
        canRedo={commandStack.canRedo()}
        onAutoOptimize={handleAutoOptimize}
        onAutoOptimizeWeek={handleAutoOptimizeWeek}
        optimizing={optimizing}
        onExport={handleExport}
        activeScopeLabel={scopeLabel}
        onOpenGenerator={() => setGeneratorOpen(true)}
        onOpenStaffingPlan={() => setStaffingPlanOpen(true)}
        onOpenScenarios={() => setScenariosOpen(true)}
        theme={theme}
        onThemeChange={setTheme}
        costModeEnabled={costModeEnabled}
        onToggleCostMode={setCostModeEnabled}
      />
      <DowTabs days={DAYS} active={activeDow} onChange={setActiveDow} />
      <SummaryStatsBar
        shifts={shifts}
        baselineShifts={baselineShifts}
        demand={demand}
        day={activeDow}
        pph={pph}
        customTeams={customTeams}
        weekBreakdown={weekBreakdown}
        activeDow={activeDow}
        costRates={costRates}
        costModeEnabled={costModeEnabled}
        target={target}
      />
      <div className="flex flex-col lg:flex-row flex-1 overflow-hidden min-h-0">
        <div className="w-full lg:w-3/5 overflow-hidden border-b lg:border-b-0 lg:border-r border-[var(--c-border)] min-h-0 flex flex-col">
          <div className="flex-1 min-h-0">
          <Timeline
            day={activeDow}
            shifts={shifts}
            onAdd={(team, roleType, level) => {
              commandStack.pushCommand('day', [activeDow], 'Add shift')
              schedState.addShift(activeDow, team, roleType, level)
            }}
            onDelete={(id) => {
              commandStack.pushCommand('day', [activeDow], 'Delete shift')
              schedState.deleteShift(activeDow, id)
            }}
            onUpdate={(id, patch) => {
              commandStack.pushCommand('day', [activeDow], 'Edit shift')
              schedState.updateShift(activeDow, id, patch)
            }}
            customTeams={customTeams}
            onAddCustomTeam={handleAddCustomTeam}
            onRemoveCustomTeam={setRemoveTeamConfirm}
            demand={demand}
            target={target}
            pph={pph}
            scope={activeScope}
            hoverHour={hoverHour}
            onHoverHour={setHoverHour}
            hiddenTeams={hiddenTeams}
            onToggleTeamHidden={handleToggleTeamHidden}
            onCopyDayTo={handleCopyDayTo}
            focusRequest={timelineFocus}
          />
          </div>
          <WeekHeatmap
            days={DAYS}
            activeDow={activeDow}
            shiftsForDay={schedState.getShiftsForDay}
            demand={demand}
            pph={pph}
            customTeams={customTeams}
            scope={activeScope}
            target={target}
            hoverHour={hoverHour}
            onSelectCell={handleHeatmapSelect}
          />
        </div>
        <div className="w-full lg:w-2/5 overflow-y-auto min-h-0">
          <PphChart
            day={activeDow}
            demand={demand}
            shifts={shifts}
            baselineShifts={baselineShifts}
            pph={pph}
            onPphChange={handlePphChange}
            scenarios={scenarios}
            comparisonScenarioId={comparisonScenarioId}
            onSelectComparison={setComparisonScenarioId}
            onDeleteScenario={handleDeleteScenario}
            onResetToScenario={handleResetToScenario}
            customTeams={customTeams}
            costRates={costRates}
            costModeEnabled={costModeEnabled}
            onCostRateChange={handleCostRateChange}
            activeScope={activeScope}
            onActiveScopeChange={setActiveScope}
            target={target}
            onTargetChange={setTarget}
            hoverHour={hoverHour}
            onHoverHour={setHoverHour}
            theme={theme}
          />
        </div>
      </div>
    </div>

    <OptimizeModal
      theme={theme}
      result={optimizeResult}
      onAccept={handleAcceptOptimize}
      onDiscard={handleDiscardOptimize}
    />

    <ScenariosPanel
      open={scenariosOpen}
      onClose={() => setScenariosOpen(false)}
      scenarios={scenarios}
      comparisonScenarioId={comparisonScenarioId}
      onSelectComparison={setComparisonScenarioId}
      onDeleteScenario={handleDeleteScenario}
      onResetToScenario={handleResetToScenario}
      currentShiftsByDay={Object.fromEntries(DAYS.map(d => [d, schedState.getShiftsForDay(d)]))}
      costRates={costRates}
      costModeEnabled={costModeEnabled}
    />

    {generatorOpen && (
      <ConstraintsPanel
        initialArea={generatorArea}
        target={target}
        percentilesAvailable={hasPercentiles(demand)}
        defaultCostPerHour={costRates.attending}
        onGenerate={handleGenerate}
        onClose={() => setGeneratorOpen(false)}
      />
    )}

    {generating && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="text-[var(--c-text-secondary)] text-sm">✦ Generating…</div>
      </div>
    )}

    <GeneratorResult
      result={generatorResult}
      onAccept={handleAcceptGenerate}
      onDiscard={handleDiscardGenerate}
      costModeEnabled={costModeEnabled}
      theme={theme}
      previewMode={generatorPreview}
      onPreviewModeChange={handleToggleGeneratorPreview}
    />

    <StaffingPlan
      open={staffingPlanOpen}
      onClose={() => setStaffingPlanOpen(false)}
      days={DAYS}
      initialScope={activeScope}
      initialTarget={target}
      percentilesAvailable={hasPercentiles(demand)}
      shiftsForDay={schedState.getShiftsForDay}
      customTeams={customTeams}
      pph={pph}
      demand={demand}
      onApply={handleApplyStaffingPlan}
      onSaveScenario={handleSaveStaffingPlan}
      operationalCoverage={operationalCoverage}
      onCoverageChange={setOperationalCoverage}
      restoredSettings={plannerRestore}
    />

    {removeTeamConfirm && (
      <ConfirmDialog
        title="Remove team?"
        message={`${removeTeamConfirm} and all its shifts will be removed from every day.`}
        confirmLabel="Remove"
        onCancel={() => setRemoveTeamConfirm(null)}
        onConfirm={() => { handleRemoveCustomTeam(removeTeamConfirm); setRemoveTeamConfirm(null) }}
      />
    )}

    {toast && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-[var(--c-bg-surface)] border border-green-600 rounded-lg px-4 py-2 text-sm text-green-300 shadow-xl z-50 pointer-events-none whitespace-nowrap">
        {toast}
      </div>
    )}

    <HelpPanel section={helpSection} onClose={closeHelp} onNavigate={setHelpSection} />
    </div>
    </HelpContext.Provider>
  )
}

export default App
