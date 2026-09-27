import { useEffect, useMemo, useRef, useState } from 'react'
import { HELP_SECTIONS } from '../../help/helpContent'

// A small visual sample next to a term: colour box, chart line, marker dot,
// demand bar or shift block — drawn the same way the app draws it.
function Key({ k }) {
  if (!k) return null
  const box = 'inline-block shrink-0 mt-0.5'
  if (k.swatch) return <span className={`${box} w-4 h-3 rounded-sm`} style={{ background: k.swatch }} />
  if (k.dot) return <span className={`${box} w-4 h-3 flex items-center justify-center`}><span className="w-2 h-2 rounded-full" style={{ background: k.dot }} /></span>
  if (k.bar) return <span className={`${box} w-4 h-3 flex items-end justify-center`}><span className="w-1.5 h-3" style={{ background: k.bar, opacity: k.opacity ?? 1 }} /></span>
  if (k.shift) return <span className={`${box} w-4 h-3 rounded-sm`} style={{ background: k.shift, opacity: k.opacity }} />
  if (k.line) {
    return (
      <svg className={box} width="16" height="12" aria-hidden="true">
        <line x1="0" y1="6" x2="16" y2="6" stroke={k.line} strokeWidth={k.width ?? 1.5}
          strokeDasharray={k.dash === 'dashed' ? '4 2' : k.dash === 'dotted' ? '1.5 2' : undefined} />
      </svg>
    )
  }
  return null
}

function matches(text, q) {
  return text.toLowerCase().includes(q)
}

// Non-modal help drawer on the right, so the screen it explains stays
// visible. `section` = the section to open at (null = closed).
export default function HelpPanel({ section, onClose, onNavigate }) {
  const [query, setQuery] = useState('')
  const bodyRef = useRef(null)
  const open = section != null

  // Each time the panel opens it starts clean, at the requested section —
  // not filtered by a search left over from last time.
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setQuery('')
  }

  // Jump to the requested section each time one is requested.
  useEffect(() => {
    if (!open) return
    const el = bodyRef.current?.querySelector(`[data-help-section="${section}"]`)
    if (el) el.scrollIntoView({ block: 'start' })
  }, [open, section])

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const q = query.trim().toLowerCase()
  const visible = useMemo(() => HELP_SECTIONS
    .map(s => ({
      ...s,
      items: q ? s.items.filter(i => matches(`${i.term} ${i.body} ${s.title}`, q)) : s.items,
      showIntro: !q || matches(`${s.title} ${s.intro ?? ''}`, q),
    }))
    .filter(s => !q || s.items.length || (s.showIntro && s.intro)), [q])

  if (!open) return null

  return (
    <aside
      role="dialog" aria-label="Help"
      className="fixed top-0 right-0 bottom-0 z-[60] w-full sm:w-[440px] flex flex-col bg-[var(--c-bg-panel)] border-l border-[var(--c-border)] shadow-2xl"
      onMouseDown={e => e.stopPropagation()}
    >
      <div className="px-4 pt-3 pb-2 border-b border-[var(--c-border)] shrink-0">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold text-[var(--c-text-strong)]">❓ Help — what everything means</div>
          <button onClick={onClose} aria-label="Close help" title="Close (Esc)" className="text-[var(--c-text-muted)] hover:text-[var(--c-text-strong)] px-1 text-lg leading-none">×</button>
        </div>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search help (e.g. excess, p90, dots)…"
          aria-label="Search help"
          className="mt-2 w-full bg-[var(--c-bg-surface)] border border-[var(--c-border-strong)] rounded px-2 py-1 text-xs text-[var(--c-text-strong)] outline-none focus:border-blue-500"
        />
        {!q && (
          <div className="mt-2 flex flex-wrap gap-1">
            {HELP_SECTIONS.map(s => (
              <button
                key={s.id}
                onClick={() => onNavigate(s.id)}
                className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                  s.id === section ? 'bg-blue-700 text-white' : 'bg-[var(--c-bg-surface)] text-[var(--c-text-muted)] hover:text-[var(--c-text-secondary)]'
                }`}
              >{s.title}</button>
            ))}
          </div>
        )}
      </div>

      <div ref={bodyRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-5">
        {visible.length === 0 && <div className="text-xs text-[var(--c-text-muted)]">Nothing matches "{query}".</div>}
        {visible.map(s => (
          <section key={s.id} data-help-section={s.id} className="scroll-mt-2">
            <h3 className={`text-xs font-semibold uppercase tracking-wide mb-1 ${s.id === section && !q ? 'text-blue-300' : 'text-[var(--c-text-secondary)]'}`}>{s.title}</h3>
            {s.intro && s.showIntro && <p className="text-xs text-[var(--c-text-muted)] mb-2">{s.intro}</p>}
            <dl className="space-y-2">
              {s.items.map(i => (
                <div key={i.term} className="flex gap-2">
                  <div className="w-4 shrink-0"><Key k={i.key} /></div>
                  <div className="min-w-0">
                    <dt className="text-xs font-medium text-[var(--c-text-strong)]">{i.term}</dt>
                    <dd className="text-xs text-[var(--c-text-secondary)] leading-snug">{i.body}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
  )
}
