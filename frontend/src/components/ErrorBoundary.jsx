import { Component } from 'react'

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Uncaught render error — app was reset. Full details below:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-[#0f1117] text-slate-200 p-6">
          <div className="max-w-lg w-full bg-slate-900 border border-red-500/40 rounded-lg p-6 space-y-3">
            <div className="text-red-400 font-semibold text-lg">Something broke and the app had to reset</div>
            <p className="text-sm text-slate-400">
              An unexpected error occurred while rendering. Your unsaved changes (PPH values, custom teams,
              schedule edits) were lost when this happened. Please screenshot the error below and report it.
            </p>
            <pre className="text-xs text-amber-300 bg-slate-950 border border-slate-700 rounded p-3 overflow-auto max-h-40">
              {String(this.state.error?.stack || this.state.error?.message || this.state.error)}
            </pre>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium"
            >
              Reload app
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
