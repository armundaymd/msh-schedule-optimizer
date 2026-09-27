import { useHelp } from '../../help/HelpContext'

// Small "?" that opens the Help panel at one section. Placed next to the
// parts of the screen whose meaning isn't obvious.
export default function HelpButton({ section, label = 'What does this mean?', className = '' }) {
  const openHelp = useHelp()
  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); openHelp(section) }}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center shrink-0 w-3.5 h-3.5 rounded-full border border-[var(--c-border-strong)] text-[9px] font-bold leading-none normal-case tracking-normal text-[var(--c-text-muted)] hover:text-[var(--c-text-strong)] hover:border-[var(--c-text-muted)] transition-colors ${className}`}
    >
      ?
    </button>
  )
}
