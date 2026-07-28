import { useEffect, useState, useCallback } from 'react'
import { fetchSchedule, fetchDemand, fetchSummary, postRefresh } from './api'
import { useScheduleState } from './hooks/useScheduleState'
import TopBar from './components/TopBar'
import DowTabs from './components/DowTabs'
import ScheduleEditor from './components/ScheduleEditor'
import PphChart from './components/PphChart'
import SummaryStatsBar from './components/SummaryStatsBar'
import OptimizeModal from './components/OptimizeModal'
import { getOverflowHours, runOptimizer } from './utils/optimizer'
import { exportScheduleAs } from './utils/exportSchedule'
import { computeShiftCost } from './utils/cost'

// main/fasttrack/eru = Attending max PPH per area (existing).
// pa/pgy1-4/offService = Resident & PA max PPH, single value app-wide.
// These extender values are placeholder starting points — tune via the sliders.
const DEFAULT_PPH = {
  main: 2.1, fasttrack: 3.5, eru: 0.8,
  pa: 1.2, pgy1: 0.5, pgy2: 0.8, pgy3: 1.1, pgy4: 1.4, offService: 0.8,
}

// Placeholder $/hr starting points — tune via the cost-modeling toggle in the PPH panel.
const DEFAULT_COST_RATES = { attending: 250, pa: 90 }

const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

function App() {
  const [activeDow, setActiveDow] = useState('Monday')
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

  function handlePphChange(key, val) {
    setPph(prev => ({ ...prev, [key]: val }))
  }

  function handleCostRateChange(key, val) {
    setCostRates(prev => ({ ...prev, [key]: val }))
  }

  function handleExport(format) {
    exportScheduleAs(schedState, format)
  }

  function handleSaveScenario(name) {
    const fullProposed = {}
    DAYS.forEach(day => { fullProposed[day] = schedState.getShiftsForDay(day) })
    setScenarios(prev => [
      ...prev,
      { id: `sc-${Date.now()}`, name, proposed: fullProposed, pph: { ...pph }, customTeams: [...customTeams] },
    ])
  }

  function handleDeleteScenario(id) {
    setScenarios(prev => prev.filter(s => s.id !== id))
    if (comparisonScenarioId === id) setComparisonScenarioId(null)
  }

  function handleResetToScenario(id) {
    const sc = scenarios.find(s => s.id === id)
    if (!sc) return
    schedState.loadSnapshot(sc.proposed)
    setPph({ ...sc.pph })
    if (sc.customTeams) setCustomTeams([...sc.customTeams])
  }

  function showToast(msg) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleAutoOptimize() {
    const overflow = getOverflowHours(shifts, demand, pph, activeDow, customTeams)
    if (overflow.length === 0) {
      showToast('✓ No overflow — schedule already meets demand')
      return
    }
    setOptimizing(true)
    // Brief loading flash so the state change is visible
    await new Promise(r => setTimeout(r, 280))
    const result = runOptimizer(shifts, demand, pph, activeDow, customTeams)
    // Push single undo entry for the whole optimization before applying
    schedState.pushUndoForDay(activeDow, shifts)
    schedState.applyDayShifts(activeDow, result.newShifts)
    if (result.newTeams.length > 0) setCustomTeams(prev => [...prev, ...result.newTeams])
    setOptimizeResult({ ...result, preOptCustomTeams: customTeams })
    setOptimizing(false)
  }

  async function handleAutoOptimizeWeek() {
    const anyOverflow = DAYS.some(day =>
      getOverflowHours(schedState.getShiftsForDay(day), demand, pph, day, customTeams).length > 0
    )
    if (!anyOverflow) {
      showToast('✓ No overflow — schedule already meets demand')
      return
    }
    setOptimizing(true)
    await new Promise(r => setTimeout(r, 280))

    // Snapshot the whole week + custom teams for a clean batch discard
    const preOptimizeSnapshot = {}
    DAYS.forEach(day => { preOptimizeSnapshot[day] = schedState.getShiftsForDay(day) })
    const preOptCustomTeams = customTeams

    // Accumulate custom teams across days so "Optimized Team N" numbering
    // stays consistent instead of colliding day to day
    let accumulatedCustomTeams = [...customTeams]
    const perDay = {}
    let totalResolved = 0
    let totalOverflow = 0
    const allNewTeams = []

    DAYS.forEach(day => {
      const dayShifts = schedState.getShiftsForDay(day)
      const result = runOptimizer(dayShifts, demand, pph, day, accumulatedCustomTeams)
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
      // Whole-week batch — restore the pre-optimize snapshot directly
      schedState.loadSnapshot(optimizeResult.preOptimizeSnapshot)
    } else {
      // Single day — undo reverts the active DOW
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
    // Remove shifts for this team from all days
    const snap = {}
    DAYS.forEach(day => {
      snap[day] = schedState.getShiftsForDay(day).filter(s => s.team !== name)
    })
    schedState.loadSnapshot(snap)
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

  // Keyboard undo/redo — must be before early return to satisfy Rules of Hooks
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

  function attendingHrs(list) {
    return list.filter(s => s.role_type === 'Attending')
      .reduce((sum, s) => sum + (s.endMins - s.startMins) / 60, 0)
  }
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
          />
        </div>
      </div>
    </div>

    {/* Auto-optimize results modal */}
    <OptimizeModal
      result={optimizeResult}
      onAccept={handleAcceptOptimize}
      onDiscard={handleDiscardOptimize}
    />

    {/* Toast notification */}
    {toast && (
      <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-800 border border-green-600 rounded-lg px-4 py-2 text-sm text-green-300 shadow-xl z-50 pointer-events-none whitespace-nowrap">
        {toast}
      </div>
    )}
    </>
  )
}

export default App
