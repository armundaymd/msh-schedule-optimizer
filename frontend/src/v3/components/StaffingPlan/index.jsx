import { useEffect, useMemo, useState } from 'react'
import { postStaffingPlan } from '../../../shared/api'
import { SCOPE_LABEL, scopeAreas } from '../../../shared/areas'
import { teamArea } from '../../../shared/capacity'
import { areaMaxAttendings, cloneCoverageConfig, dedicatedWindowFeasibility, eruScenarioConfig, validateCoverageConfig } from '../../../shared/operationalCoverage'
import { DEFAULT_MAX_FLEX, WEEKS_PER_YEAR, schedulePlanMetrics, weeklyBudget } from '../../../shared/staffingPlan'
import {
  DEFAULT_PLANNER_INPUTS, PLANNING_MODES, frontierBudgets, frontierRows, planAndScore, restorePlannerSettings, runFrontier,
} from '../../../shared/attendingPlanner'
import { hourlyPatterns } from '../../../shared/bottlenecks'
import { planPatterns } from '../../utils/patterns'
import PlanSetup from './PlanSetup'
import PlanResults from './PlanResults'
import FrontierResults from './FrontierResults'
import BottleneckPanel from './BottleneckPanel'
import AssumptionStrip from './AssumptionStrip'
import HelpButton from '../Help/HelpButton'

function currentAttendingHours(days, shiftsForDay, customTeams, scope) {
  const areas = scopeAreas(scope)
  return days.reduce((t, d) => t + shiftsForDay(d)
    .filter(s => s.role_type === 'Attending' && areas.includes(teamArea(s.team, customTeams)))
    .reduce((u, s) => u + (s.endMins - s.startMins) / 60, 0), 0)
}

// Staffing plan workflow: settings -> solve (server, CP-SAT) -> inspect
// current vs proposed -> apply (one undoable command) or save as scenario.
// Nothing touches the live schedule until Apply.
export default function StaffingPlan({
  open, onClose, days, initialScope, initialTarget, percentilesAvailable,
  shiftsForDay, customTeams, pph, demand, onApply, onSaveScenario,
  operationalCoverage, onCoverageChange, restoredSettings = null,
}) {
  const [settings, setSettings] = useState(null)
  const [step, setStep] = useState('setup') // 'setup' | 'results' | 'frontier' | 'infeasible'
  const [frontier, setFrontier] = useState(null) // { rows, points, settings, before }
  const [infeasible, setInfeasible] = useState(null) // failed target run with its best-achievable plan
  const [markers, setMarkers] = useState({}) // chart markers from this session's target / min-practical runs
  const [progress, setProgress] = useState(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null) // { message, detail? }
  const [plan, setPlan] = useState(null)
  const [scenarioName, setScenarioName] = useState('')

  // Fresh defaults each time the panel opens: today's scope and target, and
  // a budget equal to today's attending hours in that scope — so the first
  // run answers "same hours, better placed?".
  const [wasOpen, setWasOpen] = useState(false)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      const weekly = currentAttendingHours(days, shiftsForDay, customTeams, initialScope)
      const defaults = {
        mode: 'budget', amount: Math.round(weekly * WEEKS_PER_YEAR), period: 'annual', allowedDeficit: 0,
        scope: initialScope, target: initialTarget, startMode: 'current', lengths: [8, 10, 12],
        lockRules: [], minRules: [], effort: 'standard', amountEdited: false,
        coverage: cloneCoverageConfig(operationalCoverage), useCoverage: true,
        eruScenario: { preset: 'config' }, compareCurrentEru: true,
        ...structuredClone(DEFAULT_PLANNER_INPUTS), maxFlex: DEFAULT_MAX_FLEX,
      }
      // Planner settings saved with the last restored scenario, if any.
      setSettings(restoredSettings ? { ...restorePlannerSettings(restoredSettings, defaults), amountEdited: true } : defaults)
      setStep('setup'); setPlan(null); setError(null); setFrontier(null); setInfeasible(null)
    }
  }

  useEffect(() => {
    if (!running) return
    const t0 = Date.now()
    const id = setInterval(() => setElapsed((Date.now() - t0) / 1000), 250)
    return () => clearInterval(id)
  }, [running])

  const currentWeekly = useMemo(
    () => (settings ? currentAttendingHours(days, shiftsForDay, customTeams, settings.scope) : 0),
    [days, shiftsForDay, customTeams, settings],
  )

  if (!open || !settings) return null

  // Until the user types a budget, it tracks today's attending hours for
  // the selected scope and period, so switching scope never silently plans
  // Whole ED on Main's hours.
  function todayAmount(scope, period) {
    const weekly = currentAttendingHours(days, shiftsForDay, customTeams, scope)
    return Math.round(period === 'annual' ? weekly * WEEKS_PER_YEAR : weekly)
  }
  function change(patch) {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      if ('amount' in patch) next.amountEdited = true
      else if (!prev.amountEdited && ('scope' in patch || 'period' in patch)) next.amount = todayAmount(next.scope, next.period)
      return next
    })
    setError(null)
  }
  function useTodayAmount() {
    setSettings(prev => ({ ...prev, amount: todayAmount(prev.scope, prev.period), amountEdited: false }))
  }

  // Throws { message, status? } when the ERU window can't be represented
  // with the shift menu (reported, never silently violated).
  function checkEruWindow(s, coverage, patterns) {
    if (!coverage || !scopeAreas(s.scope).includes('eru')) return
    const fit = dedicatedWindowFeasibility(coverage, 'eru', days, patterns)
    if (fit && !fit.feasible) {
      const bad = fit.byDay.filter(d => !d.feasible)
      throw {
        status: 'infeasible',
        message: `The ERU dedicated window can't be staffed with the chosen shift times while ERU has at most one attending at a time `
          + `and no dedicated ERU shift outside the window: ${bad.map(d => `${d.day.slice(0, 3)} (${d.required} h)`).join(', ')} `
          + 'have no combination of non-overlapping shifts that fits exactly. Change the window, allow flexible ERU hours outside it, or change the shift menu.',
      }
    }
  }

  // One planning solve (shared/attendingPlanner.js planAndScore: the same
  // code the analysis runs use) for settings `s` under `coverage`.
  // Resolves to the scored plan — { ok: false, ... } when no plan exists.
  async function solveOnce(s, coverage, { planningMode = s.planningMode, weeklyHours = weeklyBudget(s.amount, s.period).weeklyHours, hint = [] } = {}) {
    const areas = scopeAreas(s.scope)
    const patterns = planPatterns(s.startMode, s.lengths)
    checkEruWindow(s, coverage, patterns)
    let plan
    try {
      plan = await planAndScore({
        days, shiftsForDay, customTeams, pph, demand, target: s.target, scope: s.scope, patterns, coverage,
        lockRules: s.lockRules.filter(r => areas.includes(r.area)),
        minCoverageRules: s.minRules.filter(r => areas.includes(r.area)),
        // Area maximums (ERU: one at a time) hold even with the rules off.
        maxAttendingsByArea: areaMaxAttendings(s.coverage), maxFlex: s.maxFlex ?? DEFAULT_MAX_FLEX,
        effort: s.effort, inputs: { ...s, planningMode }, weeklyBudgetHours: weeklyHours, allowedDeficitPph: s.allowedDeficit,
        hint, solve: postStaffingPlan, expandedPatterns: hourlyPatterns(patterns),
      })
    } catch (e) {
      throw { message: e.message }
    }
    return { ...plan, settings: s, coverage, weekly: weeklyHours }
  }

  function currentMetrics(s, coverage) {
    return schedulePlanMetrics({ days, demand, pph, scope: s.scope, target: s.target, coverage, shiftsForDay, customTeams })
  }

  async function run(overrides = {}) {
    const s = { ...settings, ...overrides }
    if (!s.lengths.length) { setError({ message: 'Choose at least one shift length.' }); return }
    const coverage = s.useCoverage ? s.coverage : null
    if (coverage) {
      const problems = validateCoverageConfig(coverage, customTeams)
      if (problems.length) { setError({ message: `Fix the operational coverage rules first: ${problems.join(' ')}` }); return }
      onCoverageChange?.(coverage)
    }
    setSettings(s); setRunning(true); setElapsed(0); setError(null); setProgress(null)
    try {
      const before = currentMetrics(s, coverage)
      if (s.planningMode === 'frontier') {
        const budgets = frontierBudgets({ ...s.frontier, include: [Math.round(currentWeekly)] })
        if (!budgets.length) throw { message: 'Set a budget range (minimum ≤ maximum, step > 0) or list budgets.' }
        const points = await runFrontier({
          budgets, onProgress: setProgress,
          solveAt: (budget, hint) => solveOnce(s, coverage, { planningMode: 'budget', weeklyHours: budget, hint }).then(p => ({ ...p, before })),
        })
        setFrontier({ points, rows: frontierRows(points), settings: s, before })
        setStep('frontier')
        return
      }
      const next = await solveOnce(s, coverage)
      if (!next.ok) {
        if (next.result.status === 'infeasible' && next.bestAchievable) {
          setInfeasible({ ...next, before }); setStep('infeasible'); return
        }
        throw { message: next.result.message, status: next.result.status, diagnosis: next.result.diagnosis }
      }
      next.before = before
      // Same budget, same rules, ERU at its CURRENT dedicated coverage — so
      // the scenario's opportunity cost can be read against it.
      const compare = s.planningMode === 'budget' && coverage && s.compareCurrentEru && s.eruScenario?.preset !== 'current' && scopeAreas(s.scope).includes('eru')
      if (compare) {
        const base = await solveOnce(s, eruScenarioConfig(coverage, 'current'))
        if (base.ok) next.eruBaseline = { ...base, after: base.after }
      }
      const mark = { hours: next.result.hours.total, unmet: next.summary.all.unmet, coverage: next.summary.all.coverage }
      if (s.planningMode === 'target') setMarkers(m => ({ ...m, target: { ...mark, label: `${s.targetCoveragePct}% target` } }))
      if (s.planningMode === 'maxUnmet') setMarkers(m => ({ ...m, target: { ...mark, label: `≤ ${s.maxUnmetPph} unmet` } }))
      if (s.planningMode === 'minPractical') setMarkers(m => ({ ...m, minPractical: mark }))
      setPlan(next)
      setScenarioName(`${SCOPE_LABEL[s.scope]} ${PLANNING_MODES[s.planningMode].label.toLowerCase()} — ${Math.round(next.result.hours.total)} h/wk`)
      setStep('results')
    } catch (e) {
      setError({ message: e.message || 'The optimizer could not be reached.', status: e.status, diagnosis: e.diagnosis })
      setStep('setup')
    } finally {
      setRunning(false); setProgress(null)
    }
  }

  function viewFrontierPoint(budget) {
    const pt = frontier.points.find(p => p.budget === budget)
    if (!pt?.plan?.ok) return
    const s = { ...frontier.settings, planningMode: 'budget', mode: 'budget', amount: budget, period: 'weekly' }
    setPlan({ ...pt.plan, settings: s, weekly: budget, before: frontier.before, fromFrontier: true })
    setScenarioName(`${SCOPE_LABEL[s.scope]} frontier point — ${Math.round(pt.plan.result.hours.total)} h/wk`)
    setStep('results')
  }

  function requireCoverage(area) {
    const minRules = [...settings.minRules.filter(r => r.area !== area), { area, fromHour: 0, toHour: 0, min: 1 }]
    run({ minRules })
  }

  const btn = 'text-xs px-4 py-1.5 rounded transition-colors disabled:opacity-50'
  const secondary = `${btn} bg-[var(--c-btn-bg)] hover:bg-[var(--c-btn-bg-hover)] text-[var(--c-text-secondary)]`
  const primary = `${btn} bg-indigo-700 hover:bg-indigo-600 text-white`

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Staffing plan">
      <div className="bg-[var(--c-bg-panel)] border border-[var(--c-border)] rounded-xl shadow-2xl w-full max-w-[920px] max-h-[92vh] flex flex-col">
        <div className="px-5 py-3 border-b border-[var(--c-border)] shrink-0 flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-[var(--c-text-strong)] flex items-center gap-2">▦ Staffing plan <HelpButton section="staffing-plan" label="How the staffing plan works" /></div>
            <div className="text-xs text-[var(--c-text-muted)] mt-0.5">
              {step === 'setup'
                ? `How much attending coverage does this ED need, and where? Today: ${Math.round(currentWeekly)} attending h/week in ${SCOPE_LABEL[settings.scope]}.`
                : `${SCOPE_LABEL[settings.scope]} · ${settings.target === 'mean' ? 'mean' : settings.target} demand · ${PLANNING_MODES[settings.planningMode]?.label ?? ''} · nothing changes until you apply.`}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--c-text-muted)] hover:text-[var(--c-text-strong)] px-1">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className={`mb-4 text-xs rounded px-3 py-2 border ${error.status === 'infeasible' ? 'border-amber-700/60 text-amber-200' : 'border-red-700/60 text-red-300'}`}>
              {error.status === 'infeasible' && <b>No plan fits these constraints. </b>}
              {error.message}
              {error.diagnosis?.requiredHours != null && (
                <div className="mt-1 tabular-nums">
                  Required {Math.round(error.diagnosis.requiredHours * 10) / 10} h/wk · available {Math.round(error.diagnosis.availableHours * 10) / 10} h/wk
                  {Object.entries(error.diagnosis.byArea ?? {}).map(([a, v]) => ` · ${a} ${Math.round(v.requiredHours * 10) / 10} h`).join('')}
                </div>
              )}
            </div>
          )}
          {step === 'setup' && (
            <PlanSetup settings={settings} onChange={change} percentilesAvailable={percentilesAvailable}
              todayWeekly={currentWeekly} onUseToday={useTodayAmount} days={days}
              shiftsForDay={shiftsForDay} customTeams={customTeams} />
          )}
          {step === 'results' && (
            <PlanResults plan={plan} days={days} demand={demand} pph={pph} todayWeekly={currentWeekly}
              currentShiftsForDay={shiftsForDay} customTeams={customTeams} onRequireCoverage={requireCoverage} />
          )}
          {step === 'frontier' && frontier && (
            <div className="space-y-4">
              <AssumptionStrip settings={frontier.settings} pph={pph}
                resultText={`${frontier.rows.filter(r => r.feasible).length} budgets solved, ${Math.min(...frontier.rows.map(r => r.budget))}–${Math.max(...frontier.rows.map(r => r.budget))} h/week`} />
              <FrontierResults rows={frontier.rows} units={frontier.settings.units} onViewPoint={viewFrontierPoint}
                markers={{ current: currentWeekly, selected: weeklyBudget(frontier.settings.amount, frontier.settings.period).weeklyHours, ...markers }} />
            </div>
          )}
          {step === 'infeasible' && infeasible && (
            <div className="space-y-4">
              <div className="text-xs rounded px-3 py-2 border border-amber-700/60 text-amber-200">
                <b>TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS.</b> {infeasible.result.message.replace(/^TARGET INFEASIBLE UNDER CURRENT CONSTRAINTS:\s*/, '')}
              </div>
              {infeasible.bestAchievable && (
                <div className="text-xs text-[var(--c-text-secondary)] space-y-1">
                  <div>
                    Best achievable with unlimited attending hours under these rules: <b>{(100 * infeasible.bestAchievable.summary.all.coverage).toFixed(1)}%</b> modeled
                    coverage, {infeasible.bestAchievable.summary.all.unmet.toFixed(1)} unmet patient-h/week
                    ({Object.entries(infeasible.bestAchievable.summary.byArea).map(([a, m]) => `${a === 'fasttrack' ? 'FastTrack' : a === 'eru' ? 'ERU' : 'Main'} ${(100 * m.coverage).toFixed(1)}%`).join(', ')}).
                  </div>
                  <BottleneckPanel bottlenecks={infeasible.bestAchievable.bottlenecks} title="What limits the residual deficit (best-achievable plan)" />
                </div>
              )}
              <AssumptionStrip settings={infeasible.settings} pph={pph} resultText="no plan meets the target; no rule was relaxed" />
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-[var(--c-border)] flex gap-2 items-center justify-end shrink-0 flex-wrap">
          {running && (
            <span className="mr-auto text-xs text-[var(--c-text-muted)]">
              Optimizing… {elapsed.toFixed(0)} s
              {progress
                ? <span className="text-[var(--c-text-faint)]"> — budget {progress.budget} h ({progress.index + 1} of {progress.total})</span>
                : <span className="text-[var(--c-text-faint)]"> (usually under 20 s; target and minimum-practical runs solve in stages and take longer{settings.compareCurrentEru && settings.planningMode === 'budget' ? '; twice as long with the Current ERU comparison' : ''})</span>}
            </span>
          )}
          {step === 'setup' ? (
            <>
              {!running && (
                <label className="mr-auto flex items-center gap-1.5 text-[11px] text-[var(--c-text-muted)]" title="Longer search finds better plans for large shift menus. Results are reproducible either way.">
                  Search
                  <select value={settings.effort} onChange={e => change({ effort: e.target.value })}
                    className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-1 py-0.5 text-xs text-[var(--c-text-strong)]">
                    <option value="quick">Quick</option>
                    <option value="standard">Standard</option>
                    <option value="thorough">Thorough</option>
                  </select>
                </label>
              )}
              {plan && <button onClick={() => setStep('results')} disabled={running} className={secondary}>Back to results</button>}
              <button onClick={onClose} disabled={running} className={secondary}>Cancel</button>
              <button onClick={() => run()} disabled={running} className={primary}>
                {{ budget: 'Optimize allocation', frontier: 'Solve frontier', minPractical: 'Estimate requirement' }[settings.planningMode] ?? 'Find hours needed'}
              </button>
            </>
          ) : step !== 'results' ? (
            <>
              <button onClick={() => setStep('setup')} disabled={running} className={`${secondary} mr-auto`}>← Adjust settings</button>
              <button onClick={onClose} className={secondary}>Close</button>
            </>
          ) : (
            <>
              <button onClick={() => setStep('setup')} disabled={running} className={`${secondary} ${plan?.fromFrontier ? '' : 'mr-auto'}`}>← Adjust settings</button>
              {plan?.fromFrontier && <button onClick={() => setStep('frontier')} className={`${secondary} mr-auto`}>← Back to frontier</button>}
              <input
                value={scenarioName} onChange={e => setScenarioName(e.target.value)} aria-label="Scenario name"
                className="bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)] w-56"
              />
              <button
                onClick={() => onSaveScenario(scenarioName.trim() || 'Staffing plan', plan)}
                disabled={running || !scenarioName.trim()} className={secondary}
                title="Save the proposed week as a scenario, then compare it against the live schedule in the chart"
              >Save as scenario</button>
              <button onClick={() => onApply(plan)} disabled={running} className={primary}
                title="Replace the schedule with this plan (one step — undo restores it)">Apply to schedule</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
