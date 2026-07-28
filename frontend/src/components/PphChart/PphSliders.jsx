const ATTENDING_SLIDERS = [
  { key: 'main',      label: 'Main max PPH',      min: 1.0, max: 5.0, step: 0.1 },
  { key: 'fasttrack', label: 'FastTrack max PPH',  min: 1.0, max: 5.0, step: 0.1 },
  { key: 'eru',       label: 'ERU max PPH',        min: 0.5, max: 3.0, step: 0.1 },
]

const EXTENDER_SLIDERS = [
  { key: 'pa',         label: 'PA max PPH',         min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy1',       label: 'PGY-1 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy2',       label: 'PGY-2 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy3',       label: 'PGY-3 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'pgy4',       label: 'PGY-4 max PPH',      min: 0.2, max: 3.0, step: 0.1 },
  { key: 'offService', label: 'Off-Service max PPH',min: 0.2, max: 3.0, step: 0.1 },
]

function SliderRow({ sliders, pph, onChange, empiricalPph }) {
  return (
    <div className="flex gap-4 px-3 py-1 flex-wrap">
      {sliders.map(({ key, label, min, max, step }) => {
        const emp = empiricalPph?.[key]
        return (
          <label key={key} className="flex flex-col gap-0.5 flex-1 min-w-[110px]">
            <span className="text-xs text-slate-400">{label}</span>
            <div className="flex items-center gap-1">
              <input
                type="range"
                min={min} max={max} step={step}
                value={pph[key]}
                onChange={e => onChange(key, parseFloat(e.target.value))}
                className="flex-1 accent-blue-500 h-1"
              />
              <span className="text-xs text-slate-300 w-8 text-right">{pph[key].toFixed(1)}</span>
            </div>
            {emp != null && (
              <span className="text-[10px] text-teal-500 leading-none">
                Empirical: {emp.toFixed(2)}
              </span>
            )}
          </label>
        )
      })}
    </div>
  )
}

export default function PphSliders({ pph, onChange, empiricalPph }) {
  return (
    <div className="pt-2 pb-1">
      <div className="px-3 text-[10px] text-slate-500 uppercase tracking-wide">Attending max PPH (by area)</div>
      <SliderRow sliders={ATTENDING_SLIDERS} pph={pph} onChange={onChange} empiricalPph={empiricalPph} />
      <div className="px-3 text-[10px] text-slate-500 uppercase tracking-wide mt-1">Resident / PA max PPH (per provider)</div>
      <SliderRow sliders={EXTENDER_SLIDERS} pph={pph} onChange={onChange} empiricalPph={empiricalPph} />
    </div>
  )
}
