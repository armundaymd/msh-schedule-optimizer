import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { fetchSummary } from './shared/api'

const STORAGE_KEY = 'edso.version'

function VersionCard({ title, description, to, preview, onChoose }) {
  return (
    <button
      onClick={() => onChoose(to)}
      className="text-left flex-1 min-w-[240px] max-w-sm bg-[#161b22] border border-slate-700 rounded-xl p-6 hover:border-blue-500 focus:outline-none focus:border-blue-500 transition-colors"
    >
      <div className="flex items-center gap-2 mb-2">
        <span className="text-slate-100 font-semibold text-lg">{title}</span>
        {preview && (
          <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300 bg-amber-900/40 border border-amber-700/50 px-1.5 py-0.5 rounded">
            Preview
          </span>
        )}
      </div>
      <p className="text-sm text-slate-400 leading-relaxed">{description}</p>
    </button>
  )
}

export default function Landing() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [summary, setSummary] = useState(null)
  const [summaryError, setSummaryError] = useState(false)
  const [remember, setRemember] = useState(false)

  const forceChoose = searchParams.get('choose') === '1'

  useEffect(() => {
    if (forceChoose) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    const saved = window.localStorage.getItem(STORAGE_KEY)
    if (saved === 'legacy' || saved === 'v2') {
      navigate(`/${saved}`, { replace: true })
    }
  }, [forceChoose, navigate])

  useEffect(() => {
    fetchSummary()
      .then(setSummary)
      .catch(() => setSummaryError(true))
  }, [])

  function handleChoose(to) {
    if (remember) {
      window.localStorage.setItem(STORAGE_KEY, to === '/legacy' ? 'legacy' : 'v2')
    }
    navigate(to)
  }

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[#0f1117] text-slate-200">
      <div className="flex items-center justify-center px-4 py-2 border-b border-slate-800 shrink-0">
        {summary ? (
          <span className="text-xs text-slate-400 bg-slate-800 px-2 py-0.5 rounded">
            {summary.total_encounters.toLocaleString()} encounters · {summary.date_range} · {summary.unique_days} days
          </span>
        ) : summaryError ? (
          <span className="text-xs text-red-400 bg-red-950/40 px-2 py-0.5 rounded">
            Backend unreachable — /api/summary failed
          </span>
        ) : (
          <span className="text-xs text-slate-500 px-2 py-0.5">Loading dataset summary…</span>
        )}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-slate-100">ED Staffing</h1>
          <p className="text-sm text-slate-500 mt-1">Choose a version</p>
        </div>

        <div className="flex flex-wrap gap-4 justify-center w-full">
          <VersionCard
            title="Classic"
            description="The current tool, with corrected capacity and demand maths."
            to="/legacy"
            onChoose={handleChoose}
          />
          <VersionCard
            title="Optimizer v2"
            description="Schedule generator, percentile demand targets, redesigned timeline."
            to="/v2"
            preview
            onChoose={handleChoose}
          />
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-500 select-none">
          <input
            type="checkbox"
            checked={remember}
            onChange={e => setRemember(e.target.checked)}
            className="accent-blue-500"
          />
          Remember my choice
        </label>
      </div>
    </div>
  )
}
