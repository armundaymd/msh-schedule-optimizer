// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

export default function PillToggle({ checked, onChange }) {
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
