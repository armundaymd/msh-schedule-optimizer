import { useRef, useState, useEffect } from 'react'
import TeamColumn from './TeamColumn'

const TEAMS = ['Green', 'Red', 'Blue', 'FastTrack', 'ERU']
export const TEAM_COLORS = {
  Green:     '#2d7a3a',
  Red:       '#c0392b',
  Blue:      '#185FA5',
  FastTrack: '#7b3fa0',
  ERU:       '#b05a00',
}

const PRESET_COLORS = ['#0d9488','#ec4899','#f59e0b','#6366f1','#84cc16','#06b6d4','#f43f5e','#64748b']
const AREAS = ['Main', 'FastTrack', 'ERU']
const HEADER_H  = 32
const TOGGLEBAR_H = 28

function PillToggle({ checked, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative inline-flex items-center shrink-0 transition-colors duration-200 focus:outline-none"
      style={{
        width: 34, height: 18, borderRadius: 9,
        background: checked ? '#3b82f6' : '#475569',
      }}
    >
      <span
        style={{
          position: 'absolute',
          width: 12, height: 12, borderRadius: '50%',
          background: 'white',
          left: checked ? 18 : 3,
          transition: 'left 0.15s',
        }}
      />
    </button>
  )
}

export default function ScheduleEditor({ day, shifts, onAdd, onDelete, onUpdate, onBeforeDrag, customTeams, onAddCustomTeam, onRemoveCustomTeam }) {
  const containerRef = useRef(null)
  const [containerH, setContainerH] = useState(0)
  const [showAllStaff, setShowAllStaff] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])
  const [newArea, setNewArea] = useState('Main')
  const addRef = useRef(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => setContainerH(entries[0].contentRect.height))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!addOpen) return
    function onDown(e) { if (addRef.current && !addRef.current.contains(e.target)) setAddOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [addOpen])

  // Subtract toggle bar height from available height for hourPx calculation
  const hourPx = containerH > 48 ? Math.floor((containerH - TOGGLEBAR_H - HEADER_H) / 24) : 36
  const totalH = hourPx * 24

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

  const allTeams = [
    ...TEAMS.map(name => ({ name, color: TEAM_COLORS[name], isCustom: false })),
    ...(customTeams ?? []).map(t => ({ ...t, isCustom: true })),
  ]

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden bg-[#0f1117]">

      {/* Toggle bar */}
      <div
        className="flex items-center justify-end gap-2 px-3 shrink-0 border-b border-slate-800"
        style={{ height: TOGGLEBAR_H }}
      >
        <span className="text-[11px] text-slate-400 select-none">
          {showAllStaff ? 'All staff' : 'Attendings only'}
        </span>
        <PillToggle checked={showAllStaff} onChange={setShowAllStaff} />
      </div>

      {/* Timeline content */}
      <div className="flex flex-1 overflow-hidden">

        {/* Y-axis labels */}
        <div className="w-12 shrink-0" style={{ height: totalH + HEADER_H }}>
          <div style={{ height: HEADER_H }} />
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              style={{ height: hourPx, lineHeight: `${hourPx}px` }}
              className="text-right pr-2 text-xs text-slate-500 border-t border-slate-800"
            >
              {String(h).padStart(2,'0')}:00
            </div>
          ))}
        </div>

        {/* Team columns */}
        <div className="flex flex-1 min-w-0 overflow-x-auto">
          {allTeams.map(team => (
            <TeamColumn
              key={team.name}
              team={team.name}
              color={team.color}
              shifts={shifts
                .filter(s => s.team === team.name)
                .filter(s => showAllStaff || s.role_type === 'Attending')
              }
              allDayShifts={shifts}
              hourPx={hourPx}
              totalH={totalH}
              onAdd={(roleType, level) => onAdd(team.name, roleType, level)}
              onDelete={onDelete}
              onUpdate={onUpdate}
              onBeforeDrag={onBeforeDrag}
              isCustom={team.isCustom}
              onRemove={() => {
                if (window.confirm(`Remove ${team.name} and all its shifts?`)) {
                  onRemoveCustomTeam(team.name)
                }
              }}
            />
          ))}

          {/* Add team button column */}
          <div className="shrink-0 border-l border-slate-800 flex flex-col" style={{ width: 40 }}>
            <div className="relative flex items-center justify-center" style={{ height: HEADER_H }} ref={addRef}>
              <button
                onClick={() => setAddOpen(v => !v)}
                className="text-slate-500 hover:text-slate-200 text-lg leading-none transition-colors"
                title="Add team"
              >
                ＋
              </button>
              {addOpen && (
                <div className="absolute left-full top-0 z-50 bg-slate-800 border border-slate-600 rounded shadow-xl p-3 w-56 ml-1">
                  <div className="text-xs text-slate-400 mb-1">Team name</div>
                  <input
                    autoFocus
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddConfirm()}
                    placeholder="e.g. Triage"
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 outline-none focus:border-blue-500 mb-2"
                  />
                  <div className="text-xs text-slate-400 mb-1">Color</div>
                  <div className="flex gap-1 flex-wrap mb-2">
                    {PRESET_COLORS.map(c => (
                      <button
                        key={c}
                        onClick={() => setNewColor(c)}
                        style={{ background: c, width: 20, height: 20, borderRadius: 3, border: newColor === c ? '2px solid white' : '2px solid transparent' }}
                      />
                    ))}
                  </div>
                  <div className="text-xs text-slate-400 mb-1">PPH area</div>
                  <select
                    value={newArea}
                    onChange={e => setNewArea(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100 outline-none mb-2"
                  >
                    {AREAS.map(a => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <button
                    onClick={handleAddConfirm}
                    className="w-full text-xs py-1 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                  >
                    Add team
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
