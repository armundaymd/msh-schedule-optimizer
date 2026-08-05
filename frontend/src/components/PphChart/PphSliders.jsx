import { useState } from 'react'

const ATTENDING_SLIDERS = [
  { key: 'main',      label: 'Attending max PPH', min: 1.0, max: 6.0, step: 0.1 },
  { key: 'fasttrack', label: 'Attending max PPH', min: 1.0, max: 6.0, step: 0.1 },
  { key: 'eru',       label: 'Attending max PPH', min: 0.5, max: 3.0, step: 0.1 },
]

const TEAM_TO_AREA = { Main: 'main', FastTrack: 'fasttrack', ERU: 'eru' }

const EXTENDER_SLIDERS = [
  { key: 'pa',         label: 'PA max PPH',         min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy1',       label: 'PGY-1 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy2',       label: 'PGY-2 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy3',       label: 'PGY-3 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy4',       label: 'PGY-4 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'offService', label: 'Off-Service max PPH',min: 0.2, max: 3.0, step: 0.1 },
]

// Editable value box — keeps its own text while focused so partial input
// (e.g. "1.") isn't clobbered by the controlled float on every keystroke.
function PphValueInput({ value, min, max, onCommit }) {
  const [text, setText] = useState(() => value.toFixed(1))
  const [syncedValue, setSyncedValue] = useState(value)

  // Adjust local text when the prop changes from outside (e.g. a scenario
  // preset), without an effect — see https://react.dev/learn/you-might-not-need-an-effect
  if (value !== syncedValue) {
    setSyncedValue(value)
    setText(value.toFixed(1))
  }

  function commit() {
    let v = parseFloat(text)
    if (Number.isNaN(v)) v = value
    v = Math.min(max, Math.max(min, v))
    setText(v.toFixed(1))
    if (v !== value) onCommit(v)
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      onChange={e => setText(e.target.value)}
      onFocus={e => e.target.select()}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      className="w-10 shrink-0 bg-slate-800 border border-slate-700 rounded text-xs text-slate-200 text-right px-1 py-0.5 outline-none focus:border-blue-500"
    />
  )
}

function SliderControl({ slider, pph, onChange, empiricalPph }) {
  const { key, label, min, max, step } = slider
  const emp = empiricalPph?.[key]
  return (
    <label className="flex flex-col gap-0.5 min-w-0">
      <span className="text-xs text-slate-400 truncate">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="range"
          min={min} max={max} step={step}
          value={pph[key]}
          onChange={e => onChange(key, parseFloat(e.target.value))}
          className="flex-1 min-w-0 accent-blue-500 h-1"
        />
        <PphValueInput value={pph[key]} min={min} max={max} onCommit={v => onChange(key, v)} />
      </div>
      {emp != null && (
        <span className="text-[10px] text-teal-500 leading-none">
          Empirical: {emp.toFixed(2)}
        </span>
      )}
    </label>
  )
}

export default function PphSliders({ pph, onChange, empiricalPph, activeTeam = 'Main' }) {
  const areaKey = TEAM_TO_AREA[activeTeam] ?? 'main'
  const attendingSlider = ATTENDING_SLIDERS.find(s => s.key === areaKey)

  return (
    <div className="pt-2 pb-1">
      <div className="px-3 text-[10px] text-slate-500 uppercase tracking-wide">{activeTeam} attending max PPH</div>
      <div className="px-3 py-1">
        <div className="max-w-[220px]">
          {attendingSlider && (
            <SliderControl slider={attendingSlider} pph={pph} onChange={onChange} empiricalPph={empiricalPph} />
          )}
        </div>
      </div>
      <div className="px-3 text-[10px] text-slate-500 uppercase tracking-wide mt-1">Resident / PA max PPH (per provider)</div>
      <div
        className="grid gap-x-4 gap-y-2 px-3 py-1"
        style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}
      >
        {EXTENDER_SLIDERS.map(slider => (
          <SliderControl key={slider.key} slider={slider} pph={pph} onChange={onChange} empiricalPph={empiricalPph} />
        ))}
      </div>
    </div>
  )
}
