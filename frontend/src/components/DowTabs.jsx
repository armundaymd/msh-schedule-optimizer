const SHORT = { Monday:'Mon', Tuesday:'Tue', Wednesday:'Wed', Thursday:'Thu', Friday:'Fri', Saturday:'Sat', Sunday:'Sun' }

export default function DowTabs({ days, active, onChange }) {
  return (
    <div className="flex border-b border-slate-700 bg-[#161b22] shrink-0">
      {days.map(d => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={[
            'px-4 py-2 text-xs font-medium transition-colors',
            d === active
              ? 'border-b-2 border-blue-400 text-blue-400'
              : 'text-slate-400 hover:text-slate-200',
          ].join(' ')}
        >
          {SHORT[d]}
        </button>
      ))}
    </div>
  )
}
