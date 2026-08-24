import { useEffect, useState } from 'react'
import { fetchSchedule, fetchDemand, fetchSummary, postRefresh, fetchScenarios, createScenario, deleteScenario } from '../shared/api'
import { useScheduleState } from '../shared/hooks/useScheduleState'
import { buildScenarioPayload, scenarioPayloadToSnapshot } from '../shared/scenarioPayload'
import { STATIC_MAIN, shiftCoversHour } from '../shared/capacity'
import { getDemandSeries, hasPercentiles } from '../shared/demandSeries'
import TopBar from './components/TopBar'
import DowTabs from '../shared/components/DowTabs'
import ScheduleEditor from './components/ScheduleEditor'
import PphChart from './components/PphChart'
import SummaryStatsBar from './components/SummaryStatsBar'
import OptimizeModal from './components/OptimizeModal'
import ConstraintsPanel from './components/Generator/ConstraintsPanel'
import GeneratorResult from './components/Generator/GeneratorResult'
import { getOverflowHours, runOptimizer } from './utils/optimizer'
import { exportScheduleAs } from './utils/exportSchedule'
import { generateSchedule, assignTeams } from './utils/generator'
import { computeShiftCost } from '../shared/cost'
import { DEFAULT_PPH } from '../shared/pph'

const DEFAULT_COST_RATES = { attending: 250, pa: 90 }
const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']
const AREA_KEY = { Main: 'main', FastTrack: 'fasttrack', ERU: 'eru' }
const AREA_LABEL = { main: 'Main', fasttrack: 'FastTrack', eru: 'ERU' }
const AREA_BASE_TEAMS = { main: STATIC_MAIN, fasttrack: ['FastTrack'], eru: ['ERU'] }

// Scenarios saved here are listed only here — see PHASE 3, 3.1.
const SCENARIO_VERSION = 'v2'

function teamsInArea(area, customTeams) {
  return [...AREA_BASE_TEAMS[area], ...customTeams.filter(t => t.area === AREA_LABEL[area]).map(t => t.name)]
}

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

function App() {
  const [activeDow, setActiveDow] = useState('Monday')
  const [activeTeam, setActiveTeam] = useState('Main')
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
  const [toast, setToast] = useState(null)
  const [costRates, setCostRates] = useState(DEFAULT_COST_RATES)
  const [costModeEnabled, setCostModeEnabled] = useState(false)
  const [generatorOpen, setGeneratorOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatorResult, setGeneratorResult] = useState(null)

  const activeArea = AREA_KEY[activeTeam] ?? 'main'

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
    const payload = buildScenarioPayload({ schedState, pph, costRates, customTeams, target })
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
    schedState.loadSnapshot(scenarioPayloadToSnapshot(sc.payload))
    if (sc.payload.pph) setPph({ ...sc.payload.pph })
    if (sc.payload.customTeams) setCustomTeams([...sc.payload.customTeams])
    if (sc.payload.target) setTarget(sc.payload.target)
    if (sc.payload.costRates) setCostRates({ ...sc.payload.costRates })
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleAutoOptimize() {
    const overflow = getOverflowHours(shifts, demand, pph, activeDow, customTeams, activeArea, target)
    if (overflow.length === 0) {
      showToast(`✓ No overflow — ${activeTeam} already meets demand`)
      return
    }
    setOptimizing(true)
    await new Promise(r => setTimeout(r, 280))
    const result = runOptimizer(shifts, demand, pph, activeDow, customTeams, activeArea, target)
    schedState.pushUndoForDay(activeDow, shifts)
    schedState.applyDayShifts(activeDow, result.newShifts)
    if (result.newTeams.length > 0) setCustomTeams(prev => [...prev, ...result.newTeams])
    setOptimizeResult({ ...result, preOptCustomTeams: customTeams })
    setOptimizing(false)
  }

  async function handleAutoOptimizeWeek() {
    const anyOverflow = DAYS.some(day =>
      getOverflowHours(schedState.getShiftsForDay(day), demand, pph, day, customTeams, activeArea, target).length > 0
    )
    if (!anyOverflow) {
      showToast(`✓ No overflow — ${activeTeam} already meets demand all week`)
      return
    }
    setOptimizing(true)
    await new Promise(r => setTimeout(r, 280))

    const preOptimizeSnapshot = {}
    DAYS.forEach(day => { preOptimizeSnapshot[day] = schedState.getShiftsForDay(day) })
    const preOptCustomTeams = customTeams

    let accumulatedCustomTeams = [...customTeams]
    const perDay = {}
    let totalResolved = 0
    let totalOverflow = 0
    const allNewTeams = []

    DAYS.forEach(day => {
      const dayShifts = schedState.getShiftsForDay(day)
      const result = runOptimizer(dayShifts, demand, pph, day, accumulatedCustomTeams, activeArea, target)
      schedState.applyDayShifts(day, result.newShifts)
      if (result.newTeams.length > 0) {
        accumulatedCustomTeams = [...accumulatedCustomTeams, ...result.newTeams]
        allNewTeams.push(...result.newTeams)
      }
      perDay[day] = result
      totalResolved += result.resolvedCount
      totalOverflow += result.totalOverflow
    })

    if (allNewTeams.length > 0) setCustomTeams(accumulatedCustomTeams)

    setOptimizeResult({
      isWeek: true,
      perDay,
      resolvedCount: totalResolved,
      totalOverflow,
      changes: [],
      preOptimizeSnapshot,
      preOptCustomTeams,
    })
    setOptimizing(false)
  }

  function handleAcceptOptimize() {
    setOptimizeResult(null)
  }

  function handleDiscardOptimize() {
    if (optimizeResult.isWeek) {
      schedState.loadSnapshot(optimizeResult.preOptimizeSnapshot)
    } else {
      schedState.undoForDay(activeDow)
    }
    setCustomTeams(optimizeResult.preOptCustomTeams)
    setOptimizeResult(null)
  }

  function handleAddCustomTeam(team) {
    setCustomTeams(prev => [...prev, team])
  }

  function handleRemoveCustomTeam(name) {
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

    const preGenSnapshot = {}
    DAYS.forEach(d => { preGenSnapshot[d] = schedState.getShiftsForDay(d) })
    const preGenCustomTeams = customTeams

    let accumulatedCustomTeams = [...customTeams]
    let remainingBudget = constraints.objective === 'maximize-coverage' ? constraints.weeklyHourBudget : null
    const costPerHour = constraints.costPerHour ?? 250

    const resultGroups = []
    const patternCounts = {}
    let totalHours = 0, totalShiftCount = 0, totalCost = 0, totalUncovered = 0, baselineHours = 0, baselineCost = 0

    for (const group of groups) {
      const runConstraints = { ...constraints, hourBudget: remainingBudget }
      const genResult = generateSchedule({ demand, target: genTarget, day: group.anchorDay, area, patterns, constraints: runConstraints, pph })
      const { shifts: assigned, newTeams } = assignTeams(genResult.shifts, area, accumulatedCustomTeams.map(t => t.name))
      if (newTeams.length > 0) accumulatedCustomTeams = [...accumulatedCustomTeams, ...newTeams]

      const groupHours = assigned.reduce((s, sh) => s + (sh.endMins - sh.startMins) / 60, 0)
      const groupCost = groupHours * costPerHour
      if (remainingBudget != null) remainingBudget = Math.max(0, remainingBudget - groupHours)

      for (const p of Object.values(genResult.patternCounts)) {
        const key = `${p.start}-${p.end}`
        patternCounts[key] = { start: p.start, end: p.end, count: (patternCounts[key]?.count ?? 0) + p.count }
      }

      const c = pph[`${area}Own`] ?? pph[area] ?? 0
      const coverageSeries = Array.from({ length: 24 }, (_, h) =>
        assigned.filter(s => shiftCoversHour(s, h)).length * c
      )
      const demandSeries = getDemandSeries(demand, AREA_LABEL[area], group.anchorDay, genTarget)

      resultGroups.push({ label: group.label, days: group.days, demandSeries, coverageSeries })

      const areaTeamNames = teamsInArea(area, accumulatedCustomTeams)
      for (const day of group.days) {
        const existing = preGenSnapshot[day]
        const keep = existing.filter(s => !areaTeamNames.includes(s.team))
        const dayShifts = assigned.map(s => ({ ...s, day, id: `${s.id}-${day}` }))
        schedState.applyDayShifts(day, [...keep, ...dayShifts])

        const baselineDay = (schedState.baseline?.filter(s => s.day === day) ?? []).filter(s => areaTeamNames.includes(s.team))
        baselineHours += attendingHrs(baselineDay)
        baselineCost += baselineDay.reduce((s2, sh) => s2 + (sh.endMins - sh.startMins) / 60 * costPerHour, 0)

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
      preGenSnapshot,
      preGenCustomTeams,
    })
    setGenerating(false)
  }

  function handleAcceptGenerate() {
    setGeneratorResult(null)
  }

  function handleDiscardGenerate() {
    schedState.loadSnapshot(generatorResult.preGenSnapshot)
    setCustomTeams(generatorResult.preGenCustomTeams)
    setGeneratorResult(null)
  }

  const schedState = useScheduleState()

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
  }, [])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await postRefresh()
      const [sched, dem, summ] = await Promise.all([fetchSchedule(), fetchDemand(), fetchSummary()])
      schedState.loadBaseline(sched)
      setDemand(dem)
      setSummary(summ)
    } catch (e) {
      console.error(e)
    }
    setRefreshing(false)
  }

  useEffect(() => {
    function onKey(e) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        schedState.undoForDay(activeDow)
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault()
        schedState.redoForDay(activeDow)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeDow, schedState.undoForDay, schedState.redoForDay])

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-slate-400 text-lg">
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
    <>
    <div className="flex flex-col h-screen overflow-hidden bg-[#0f1117]">
      <TopBar
        summary={summary}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        onResetDay={() => {
          schedState.pushUndoForDay(activeDow, shifts)
          schedState.resetDay(activeDow)
        }}
        onClearDay={() => schedState.clearDay(activeDow)}
        onClearWeek={() => schedState.clearWeek()}
        onSaveScenario={handleSaveScenario}
        scenarioCount={scenarios.length}
        onUndo={() => schedState.undoForDay(activeDow)}
        onRedo={() => schedState.redoForDay(activeDow)}
        canUndo={schedState.canUndo(activeDow)}
        canRedo={schedState.canRedo(activeDow)}
        onAutoOptimize={handleAutoOptimize}
        onAutoOptimizeWeek={handleAutoOptimizeWeek}
        optimizing={optimizing}
        onExport={handleExport}
        activeTeam={activeTeam}
        onOpenGenerator={() => setGeneratorOpen(true)}
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
      <div className="flex flex-1 overflow-hidden min-h-0">
        <div className="w-3/5 overflow-hidden border-r border-slate-700">
          <ScheduleEditor
            day={activeDow}
            shifts={shifts}
            onAdd={(team, roleType, level) => {
              schedState.pushUndoForDay(activeDow, shifts)
              schedState.addShift(activeDow, team, roleType, level)
            }}
            onDelete={(id) => {
              schedState.pushUndoForDay(activeDow, shifts)
              schedState.deleteShift(activeDow, id)
            }}
            onUpdate={(id, patch) => schedState.updateShift(activeDow, id, patch)}
            onBeforeDrag={() => schedState.pushUndoForDay(activeDow, shifts)}
            customTeams={customTeams}
            onAddCustomTeam={handleAddCustomTeam}
            onRemoveCustomTeam={handleRemoveCustomTeam}
          />
        </div>
        <div className="w-2/5 overflow-hidden">
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
            onToggleCostMode={setCostModeEnabled}
            activeTeam={activeTeam}
            onActiveTeamChange={setActiveTeam}
            target={target}
            onTargetChange={setTarget}
          />
        </div>
      </div>
    </div>

    <OptimizeModal
      result={optimizeResult}
      onAccept={handleAcceptOptimize}
      onDiscard={handleDiscardOptimize}
    />

    {generatorOpen && (
      <ConstraintsPanel
        initialArea={activeArea}
        target={target}
        percentilesAvailable={hasPercentiles(demand)}
        defaultCostPerHour={costRates.attending}
        onGenerate={handleGenerate}
        onClose={() => setGeneratorOpen(false)}
      />
    )}

    {generating && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="text-slate-300 text-sm">✦ Generating…</div>
      </div>
    )}

    <GeneratorResult
      result={generatorResult}
      onAccept={handleAcceptGenerate}
      onDiscard={handleDiscardGenerate}
    />

    {toast && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-green-600 rounded-lg px-4 py-2 text-sm text-green-300 shadow-xl z-50 pointer-events-none whitespace-nowrap">
        {toast}
      </div>
    )}
    </>
  )
}

export default App
