// SHARED between /legacy and /v2. Changing the maths here changes both.
// Version-specific behaviour belongs in legacy/ or v2/, not here.

// window.confirm() blocks more than just the calling script — some browser
// automation channels can't dismiss it, and it can't be themed. Use this for
// any destructive action that needs a yes/no gate instead.
export default function ConfirmDialog({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-[380px]">
        <div className="px-5 py-4 border-b border-slate-700">
          <div className="text-sm font-semibold text-slate-100">{title}</div>
        </div>
        <div className="px-5 py-4 text-xs text-slate-400">
          {message}
        </div>
        <div className="px-5 py-4 border-t border-slate-700 flex gap-3 justify-end">
          <button onClick={onCancel} className="text-xs px-4 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} className="text-xs px-4 py-1.5 rounded bg-red-700 hover:bg-red-600 text-white transition-colors">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
