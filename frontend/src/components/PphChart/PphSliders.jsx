export default function PphSliders({ pph, onChange, empiricalPph }) {
  const sliders = [
    { key: 'main',      label: 'Main max PPH',      min: 1.0, max: 5.0, step: 0.1 },
    { key: 'fasttrack', label: 'FastTrack max PPH',  min: 1.0, max: 5.0, step: 0.1 },
    { key: 'eru',       label: 'ERU max PPH',        min: 0.5, max: 3.0, step: 0.1 },
  ]
  return (
    <div className="flex gap-4 px-3 pt-2 pb-1">
      {sliders.map(({ key, label, min, max, step }) => {
        const emp = empiricalPph?.[key]
        return (
          <label key={key} className="flex flex-col gap-0.5 flex-1">
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
