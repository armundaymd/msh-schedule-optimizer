import { useRef, useState, useEffect, useMemo } from 'react'
import { DndContext, DragOverlay, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import TeamRow from './TeamRow'
import { ROW_HEADER_W } from './layout'
import CoverageRibbon from './CoverageRibbon'
import CopyDayMenu from './CopyDayMenu'
import PillToggle from '../../../shared/components/PillToggle'
import { teamCapacity } from '../../../shared/capacity'

const TEAMS = ['Green', 'Red', 'Blue', 'FastTrack', 'ERU']
const TEAM_COLORS = { Green: '#2d7a3a', Red: '#c0392b', Blue: '#185FA5', FastTrack: '#7b3fa0', ERU: '#b05a00' }
const PRESET_COLORS = ['#0d9488','#ec4899','#f59e0b','#6366f1','#84cc16','#06b6d4','#f43f5e','#64748b']
const AREAS = ['Main', 'FastTrack', 'ERU']
const HEADER_H = 28
const SNAP = 30
const MIN_HOUR_PX = 24

function snap(m) { return Math.round(m / SNAP) * SNAP }
function minsToTime(m) {
  const norm = ((m % 1440) + 1440) % 1440
  return `${String(Math.floor(norm / 60)).padStart(2,'0')}:${String(norm % 60).padStart(2,'0')}`
}

function isEditableTarget(el) {
  return el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
}

// Horizontal timeline: time on the x axis in both this and the demand chart
// below it, sharing one x scale and one hover position (PHASE 5, 5.1/5.7).
// Rows are teams; ShiftBlock/TeamRow carry the lane-packing and drag/resize
// logic. One DndContext handles move + both resize handles (5.3) and
// commits once per gesture on drop, not per mousemove (5.4).
export default function Timeline({
  day, shifts, onAdd, onDelete, onUpdate,
  customTeams, onAddCustomTeam, onRemoveCustomTeam,
  demandSeries, pph, area,
  hoverHour, onHoverHour,
  onCopyDayTo,
  hiddenTeams, onToggleTeamHidden,
}) {
  const containerRef = useRef(null)
  const [containerW, setContainerW] = useState(0)
  const [showAllStaff, setShowAllStaff] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])
  const [newArea, setNewArea] = useState('Main')
  const addRef = useRef(null)
  const [selectedId, setSelectedId] = useState(null)
  const [activeDrag, setActiveDrag] = useState(null) // { shift, mode, color }
  const [dragPreview, setDragPreview] = useState(null) // { shiftId, team, lane, numLanes, segments, ns, ne }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setContainerW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!addOpen) return
    function onDown(e) { if (addRef.current && !addRef.current.contains(e.target)) setAddOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [addOpen])

  const hourPx = containerW > 0 ? Math.max(Math.floor((containerW - ROW_HEADER_W) / 24), MIN_HOUR_PX) : 36
  const totalW = hourPx * 24

  const allTeams = [
    ...TEAMS.map(name => ({ name, color: TEAM_COLORS[name], isCustom: false })),
    ...(customTeams ?? []).map(t => ({ ...t, isCustom: true })),
  ]

  function colorFor(team) { return allTeams.find(t => t.name === team)?.color ?? '#64748b' }

  // Shifts with the in-progress drag's shift patched to its preview
  // position -- used for the coverage ribbon and the live "resolves/creates"
  // readout, so dragging isn't blind to its own effect (5.2).
  const previewShifts = useMemo(() => {
    if (!dragPreview) return shifts
    return shifts.map(s => s.id === dragPreview.shiftId
      ? { ...s, startMins: dragPreview.ns, endMins: dragPreview.ne, team: dragPreview.team }
      : s)
  }, [shifts, dragPreview])

  const ribbonValues = useMemo(() => Array.from({ length: 24 }, (_, h) =>
    teamCapacity(previewShifts, pph, customTeams, area, h) - (demandSeries?.[h] ?? 0)
  ), [previewShifts, pph, customTeams, area, demandSeries])

  const dragReadout = useMemo(() => {
    if (!dragPreview) return null
    function overflowSet(list) {
      const set = new Set()
      for (let h = 0; h < 24; h++) {
        if ((demandSeries?.[h] ?? 0) > teamCapacity(list, pph, customTeams, area, h)) set.add(h)
      }
      return set
    }
    const before = overflowSet(shifts)
    const after = overflowSet(previewShifts)
    const resolved = [...before].filter(h => !after.has(h)).length
    const created = [...after].filter(h => !before.has(h)).length
    return { resolved, created }
  }, [dragPreview, shifts, previewShifts, demandSeries, pph, customTeams, area])

  function handleAddConfirm() {
    const name = newName.trim()
    if (!name) return
    const existingNames = [...TEAMS, ...(customTeams ?? []).map(t => t.name)]
    if (existingNames.includes(name)) return
    onAddCustomTeam({ name, color: newColor, area: newArea })
    setNewName('')
    setNewColor(PRESET_COLORS[0])
    setNewArea('Main')
    setAddOpen(false)
  }

  function handleDragStart(event) {
    const { shift, mode } = event.active.data.current
    setActiveDrag({ shift, mode, color: colorFor(shift.team) })
  }

  function handleDragMove(event) {
    const { active, delta, over } = event
    const { shift, mode, lane, numLanes } = active.data.current
    const deltaMins = delta.x * (60 / hourPx)

    let ns = shift.startMins, ne = shift.endMins
    if (mode === 'move') {
      const duration = shift.endMins - shift.startMins
      ns = ((snap(shift.startMins + deltaMins) % 1440) + 1440) % 1440
      ne = ns + duration
    } else if (mode === 'resize-start') {
      ns = Math.max(0, snap(shift.startMins + deltaMins))
      if (ns >= ne - SNAP) ns = ne - SNAP
    } else if (mode === 'resize-end') {
      ne = snap(shift.endMins + deltaMins)
      if (ne <= ns + SNAP) ne = ns + SNAP
    }

    const team = mode === 'move' ? (over?.id ?? shift.team) : shift.team
    const segments = ne > 1440
      ? [
          { left: (ns / 60) * hourPx, width: Math.max(((1440 - ns) / 60) * hourPx, 6) },
          { left: 0, width: Math.max(((ne - 1440) / 60) * hourPx, 6) },
        ]
      : [{ left: (ns / 60) * hourPx, width: Math.max(((ne - ns) / 60) * hourPx, 6) }]

    setDragPreview({ shiftId: shift.id, team, lane, numLanes, segments, ns, ne })
  }

  function handleDragEnd(event) {
    const { active } = event
    const { shift, mode } = active.data.current
    setActiveDrag(null)
    const preview = dragPreview
    setDragPreview(null)
    if (!preview) return

    const patch = { startMins: preview.ns, endMins: preview.ne, start_time: minsToTime(preview.ns), end_time: minsToTime(preview.ne) }
    if (mode === 'move' && preview.team !== shift.team) patch.team = preview.team
    onUpdate(shift.id, patch)
  }

  function handleDragCancel() {
    setActiveDrag(null)
    setDragPreview(null)
  }

  // Keyboard nudges: arrows move the selected shift by the snap interval,
  // shift-arrow resizes (PHASE 5, 5.6).
  useEffect(() => {
    function onKey(e) {
      if (!selectedId) return
      if (isEditableTarget(document.activeElement)) return
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      const shift = shifts.find(s => s.id === selectedId)
      if (!shift) return
      e.preventDefault()
      const dir = e.key === 'ArrowLeft' ? -1 : 1
      if (e.shiftKey) {
        let ne = snap(shift.endMins + dir * SNAP)
        if (ne <= shift.startMins + SNAP) ne = shift.startMins + SNAP
        onUpdate(shift.id, { endMins: ne, end_time: minsToTime(ne) })
      } else {
        const duration = shift.endMins - shift.startMins
        const ns = ((snap(shift.startMins + dir * SNAP) % 1440) + 1440) % 1440
        const ne = ns + duration
        onUpdate(shift.id, { startMins: ns, endMins: ne, start_time: minsToTime(ns), end_time: minsToTime(ne) })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, shifts, onUpdate])

  function hourFromClientX(el, clientX) {
    const rect = el?.getBoundingClientRect()
    if (!rect) return null
    const h = Math.floor((clientX - rect.left) / hourPx)
    return h >= 0 && h < 24 ? h : null
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-[var(--c-bg-app)]" onClick={() => setSelectedId(null)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 shrink-0 border-b border-[var(--c-border-subtle)]" style={{ height: 32 }}>
        <CopyDayMenu day={day} onCopyTo={onCopyDayTo} />
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-[var(--c-text-muted)] select-none">{showAllStaff ? 'All staff' : 'Attendings only'}</span>
          <PillToggle checked={showAllStaff} onChange={setShowAllStaff} />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto flex flex-col">
        <div style={{ width: ROW_HEADER_W + totalW }} className="flex-1 min-h-0 flex flex-col">
          {/* Team rows scroll independently within the column's available
              height, so the coverage ribbon and demand chart (in the
              sibling column) are always visible without paging through the
              whole team list. */}
          <div className="flex-1 min-h-0" style={{ overflowY: 'auto' }}>
            {/* Hour axis — shared x scale with the chart below. Sticky so it
                stays visible while scrolling through team rows. */}
            <div
              className="flex border-b border-[var(--c-border-subtle)] sticky top-0 z-10 bg-[var(--c-bg-app)]"
              style={{ height: HEADER_H }}
              onMouseMove={e => { const h = hourFromClientX(e.currentTarget, e.clientX); if (h != null) onHoverHour?.(h) }}
              onMouseLeave={() => onHoverHour?.(null)}
            >
              <div style={{ width: ROW_HEADER_W }} className="shrink-0" />
              {Array.from({ length: 24 }, (_, h) => (
                <div key={h} style={{ width: hourPx }} className="text-center text-[10px] text-[var(--c-text-muted)] leading-[28px]">
                  {String(h).padStart(2, '0')}
                </div>
              ))}
            </div>

            {/* Team rows */}
            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragMove={handleDragMove} onDragEnd={handleDragEnd} onDragCancel={handleDragCancel}>
              <div onClick={e => e.stopPropagation()}>
                {allTeams.map(team => (
                  <TeamRow
                    key={team.name}
                    team={team.name}
                    color={team.color}
                    shifts={shifts.filter(s => s.team === team.name).filter(s => showAllStaff || s.role_type === 'Attending')}
                    allDayShifts={shifts}
                    hourPx={hourPx}
                    totalW={totalW}
                    onAdd={(roleType, level) => onAdd(team.name, roleType, level)}
                    onDelete={onDelete}
                    onUpdate={onUpdate}
                    dragPreview={dragPreview?.team === team.name ? dragPreview : null}
                    isCustom={team.isCustom}
                    onRemove={() => onRemoveCustomTeam(team.name)}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    hoverHour={hoverHour}
                    hidden={hiddenTeams?.has(team.name)}
                    onToggleHidden={onToggleTeamHidden}
                  />
                ))}

                {/* Add team */}
                <div className="flex items-center border-b border-[var(--c-border-subtle)]" style={{ height: 28 }}>
                  <div style={{ width: ROW_HEADER_W }} className="shrink-0 relative px-2" ref={addRef}>
                    <button onClick={() => setAddOpen(v => !v)} className="text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)] text-sm leading-none transition-colors" title="Add team">
                      ＋ Add team
                    </button>
                    {addOpen && (
                      <div className="absolute left-0 top-7 z-50 bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded shadow-xl p-3 w-56">
                        <div className="text-xs text-[var(--c-text-muted)] mb-1">Team name</div>
                        <input
                          autoFocus
                          value={newName}
                          onChange={e => setNewName(e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleAddConfirm()}
                          placeholder="e.g. Triage"
                          className="w-full bg-[var(--c-btn-bg)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)] outline-none focus:border-blue-500 mb-2"
                        />
                        <div className="text-xs text-[var(--c-text-muted)] mb-1">Color</div>
                        <div className="flex gap-1 flex-wrap mb-2">
                          {PRESET_COLORS.map(c => (
                            <button key={c} onClick={() => setNewColor(c)} style={{ background: c, width: 20, height: 20, borderRadius: 3, border: newColor === c ? '2px solid white' : '2px solid transparent' }} />
                          ))}
                        </div>
                        <div className="text-xs text-[var(--c-text-muted)] mb-1">PPH area</div>
                        <select value={newArea} onChange={e => setNewArea(e.target.value)} className="w-full bg-[var(--c-btn-bg)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)] outline-none mb-2">
                          {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                        <button onClick={handleAddConfirm} className="w-full text-xs py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors">
                          Add team
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <DragOverlay dropAnimation={null}>
                {activeDrag && activeDrag.mode === 'move' && (
                  <div style={{ background: activeDrag.color, borderRadius: 3, padding: '4px 6px', width: 140, boxShadow: '0 4px 12px rgba(0,0,0,0.5)', opacity: 0.9, pointerEvents: 'none' }} className="text-white">
                    <div className="text-[10px] font-semibold truncate">
                      {activeDrag.shift.role_type}{activeDrag.shift.role_detail ? ` — ${activeDrag.shift.role_detail}` : ''}
                    </div>
                    <div className="text-[9px] opacity-80">{activeDrag.shift.start_time} – {activeDrag.shift.end_time}</div>
                    {dragReadout && (
                      <div className="text-[9px] mt-0.5 opacity-90">
                        resolves {dragReadout.resolved} deficit hour{dragReadout.resolved === 1 ? '' : 's'}, creates {dragReadout.created}
                      </div>
                    )}
                  </div>
                )}
              </DragOverlay>
            </DndContext>
          </div>

          {/* Coverage ribbon, live during drag — always visible, outside the
              scrollable rows region above. */}
          {demandSeries && (
            <div className="shrink-0">
              <CoverageRibbon hourPx={hourPx} rowHeaderW={ROW_HEADER_W} values={ribbonValues} hoverHour={hoverHour} />
            </div>
          )}
          {dragPreview && dragReadout && (
            <div className="shrink-0 text-[10px] text-[var(--c-text-muted)] px-2 py-1" style={{ marginLeft: ROW_HEADER_W }}>
              resolves {dragReadout.resolved} deficit hour{dragReadout.resolved === 1 ? '' : 's'}, creates {dragReadout.created}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
