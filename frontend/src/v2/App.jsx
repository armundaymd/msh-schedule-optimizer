import { useEffect, useState } from 'react'
import { fetchSchedule, fetchDemand, fetchSummary, postRefresh, fetchScenarios, createScenario, deleteScenario } from '../shared/api'
import { useScheduleState } from '../shared/hooks/useScheduleState'
import { useCommandStack } from './hooks/useCommandStack'
import { buildScenarioPayload, scenarioPayloadToSnapshot } from '../shared/scenarioPayload'
import { STATIC_MAIN, shiftCoversHour, teamCapacity } from '../shared/capacity'
import { getDemandSeries, hasPercentiles } from '../shared/demandSeries'
import TopBar from './components/TopBar'
import DowTabs from '../shared/components/DowTabs'
import Timeline from './components/Timeline'
import PphChart from './components/PphChart'
import SummaryStatsBar from './components/SummaryStatsBar'
import OptimizeModal from './components/OptimizeModal'
import ConstraintsPanel from './components/Generator/ConstraintsPanel'
import GeneratorResult from './components/Generator/GeneratorResult'
import ScenariosPanel from './components/Scenarios/ScenariosPanel'
import ConfirmDialog from '../shared/components/ConfirmDialog'
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

function capacitySeries(shifts, pph, customTeams, area) {
  return Array.from({ length: 24 }, (_, h) => teamCapacity(shifts, pph, customTeams, area, h))
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
  const [hiddenTeams, setHiddenTeams] = useState(() => new Set())
  const [scenariosOpen, setScenariosOpen] = useState(false)
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

  const activeArea = AREA_KEY[activeTeam] ?? 'main'

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
    commandStack.pushCommand('global', DAYS, `Restore scenario ${sc.name}`)
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
    commandStack.pushCommand('day', [activeDow], `Auto-optimize ${activeTeam}`)
    schedState.applyDayShifts(activeDow, result.newShifts)
    setOptimizePreCustomTeams(customTeams)
    const afterCustomTeams = result.newTeams.length > 0 ? [...customTeams, ...result.newTeams] : customTeams
    if (result.newTeams.length > 0) setCustomTeams(prev => [...prev, ...result.newTeams])

    const demandSeriesForDay = getDemandSeries(demand, activeTeam, activeDow, target)
    setOptimizeResult({
      ...result,
      demandSeries: demandSeriesForDay,
      beforeCoverage: capacitySeries(shifts, pph, customTeams, activeArea),
      afterCoverage: capacitySeries(result.newShifts, pph, afterCustomTeams, activeArea),
    })
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

    commandStack.pushCommand('week', DAYS, `Auto-optimize ${activeTeam} (week)`)
    setOptimizePreCustomTeams(customTeams)

    let accumulatedCustomTeams = [...customTeams]
    const perDay = {}
    let totalResolved = 0
    let totalOverflow = 0
    const allNewTeams = []

    DAYS.forEach(day => {
      const dayShifts = schedState.getShiftsForDay(day)
      const beforeCoverage = capacitySeries(dayShifts, pph, customTeams, activeArea)
      const result = runOptimizer(dayShifts, demand, pph, day, accumulatedCustomTeams, activeArea, target)
      schedState.applyDayShifts(day, result.newShifts)
      if (result.newTeams.length > 0) {
        accumulatedCustomTeams = [...accumulatedCustomTeams, ...result.newTeams]
        allNewTeams.push(...result.newTeams)
      }
      perDay[day] = {
        ...result,
        demandSeries: getDemandSeries(demand, activeTeam, day, target),
        beforeCoverage,
        afterCoverage: capacitySeries(result.newShifts, pph, accumulatedCustomTeams, activeArea),
      }
      totalResolved += result.resolvedCount
      totalOverflow += result.totalOverflow
    })

    if (allNewTeams.length > 0) setCustomTeams(accumulatedCustomTeams)

    setOptimizeResult({ isWeek: true, perDay, resolvedCount: totalResolved, totalOverflow, changes: [] })
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

    for (const group of groups) {
      const runConstraints = { ...constraints, hourBudget: remainingBudget }
      const genResult = generateSchedule({ demand, target: genTarget, day: group.anchorDay, area, patterns, constraints: runConstraints, pph })
      const { shifts: assigned, newTeams } = assignTeams(genResult.shifts, area, reusableAreaTeams, accumulatedCustomTeams.map(t => t.name))
      if (newTeams.length > 0) {
        accumulatedCustomTeams = [...accumulatedCustomTeams, ...newTeams]
        reusableAreaTeams = [...reusableAreaTeams, ...newTeams]
      }

      const groupHours = assigned.reduce((s, sh) => s + (sh.endMins - sh.startMins) / 60, 0)
      const groupCost = groupHours * costPerHour
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

      const areaTeamNames = teamsInArea(area, accumulatedCustomTeams)
      for (const day of group.days) {
        const existing = schedState.getShiftsForDay(day)
        const keep = existing.filter(s => !areaTeamNames.includes(s.team))
        const dayShifts = assigned.map(s => ({ ...s, day, id: `${s.id}-${day}` }))
        const merged = [...keep, ...dayShifts]
        preShiftsByDay[day] = existing
        postShiftsByDay[day] = merged
        schedState.applyDayShifts(day, merged)

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

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await postRefresh()
      const [sched, dem, summ] = await Promise.all([fetchSchedule(), fetchDemand(), fetchSummary()])
      schedState.loadBaseline(sched)
      setDemand(dem)
      setSummary(summ)
      commandStack.clear()
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen text-[var(--c-text-muted)] text-lg">
        Loading…
      </div>
    )
  }

  const shifts = schedState.getShiftsForDay(activeDow)
  const baselineShifts = schedState.baseline?.filter(s => s.day === activeDow) ?? []
  const demandSeries = getDemandSeries(demand, activeTeam, activeDow, target)

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
    <div data-theme={theme}>
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--c-bg-app)]">
      <TopBar
        summary={summary}
        onRefresh={handleRefresh}
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
        activeTeam={activeTeam}
        onOpenGenerator={() => setGeneratorOpen(true)}
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
        <div className="w-full lg:w-3/5 overflow-hidden border-b lg:border-b-0 lg:border-r border-[var(--c-border)] min-h-0">
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
            demandSeries={demandSeries}
            pph={pph}
            area={activeArea}
            hoverHour={hoverHour}
            onHoverHour={setHoverHour}
            hiddenTeams={hiddenTeams}
            onToggleTeamHidden={handleToggleTeamHidden}
            onCopyDayTo={handleCopyDayTo}
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
            activeTeam={activeTeam}
            onActiveTeamChange={setActiveTeam}
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
    </div>
  )
}

export default App
