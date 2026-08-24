import { Link } from 'react-router-dom'

// Placeholder shell for v2. Real app lands in Phase 4/5.
export default function App() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#0f1117]">
      <div className="flex items-center gap-3 px-4 py-2 bg-[#161b22] border-b border-slate-700 shrink-0">
        <span className="text-white font-semibold text-sm tracking-wide">ED Staffing</span>
        <Link
          to="/"
          title="Back to version chooser"
          className="text-[10px] font-semibold uppercase tracking-wide text-slate-300 bg-slate-700 hover:bg-slate-600 px-1.5 py-0.5 rounded transition-colors"
        >
          v2
        </Link>
      </div>
      <div className="flex flex-1 items-center justify-center text-slate-400 text-sm">
        Optimizer v2 is under construction. Come back after Phase 4 and 5 land.
      </div>
    </div>
  )
}
