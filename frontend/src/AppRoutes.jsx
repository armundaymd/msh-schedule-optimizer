import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Landing from './Landing.jsx'
import ErrorBoundary from './shared/components/ErrorBoundary.jsx'

const LegacyApp = lazy(() => import('./legacy/App.jsx'))
const V2App = lazy(() => import('./v2/App.jsx'))

function Loading() {
  return (
    <div className="flex items-center justify-center h-screen text-slate-400 text-lg bg-[#0f1117]">
      Loading…
    </div>
  )
}

export default function AppRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={
            <ErrorBoundary>
              <Landing />
            </ErrorBoundary>
          }
        />
        <Route
          path="/legacy"
          element={
            <ErrorBoundary>
              <Suspense fallback={<Loading />}>
                <LegacyApp />
              </Suspense>
            </ErrorBoundary>
          }
        />
        <Route
          path="/v2"
          element={
            <ErrorBoundary>
              <Suspense fallback={<Loading />}>
                <V2App />
              </Suspense>
            </ErrorBoundary>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
