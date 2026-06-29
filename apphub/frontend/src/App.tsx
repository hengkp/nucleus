import { Navigate, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from '@/lib/theme'
import { SessionProvider, useSession } from '@/lib/session'
import { ToastProvider } from '@/lib/toast'
import { ConfirmProvider } from '@/lib/confirm'
import { AppShell } from '@/layout/AppShell'
import { Login } from '@/screens/Login'
import { Dashboard } from '@/screens/Dashboard'
import { Catalog } from '@/screens/Catalog'
import { JobQueue } from '@/screens/JobQueue'
import { Workspace } from '@/screens/Workspace'
import { Admin } from '@/screens/Admin'
import { Settings } from '@/screens/Settings'
import { Guide } from '@/screens/Guide'
import { Support } from '@/screens/Support'
import { Pipelines } from '@/screens/Pipelines'
import { InstanceDetail } from '@/screens/InstanceDetail'

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <div className="flex items-center gap-3 text-ink-muted">
        <img src="/brand/logo.png" alt="" className="h-8 w-8 animate-pulse-ring" />
        <span className="text-sm">Loading AppHub…</span>
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()
  if (loading) return <Splash />
  if (!session?.authenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <ThemeProvider>
      <SessionProvider>
        <ToastProvider>
          <ConfirmProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route
              element={
                <RequireAuth>
                  <AppShell />
                </RequireAuth>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="catalog" element={<Catalog />} />
              <Route path="pipelines" element={<Pipelines />} />
              <Route path="queue" element={<JobQueue />} />
              <Route path="workspace" element={<Workspace />} />
              <Route path="guide" element={<Guide />} />
              <Route path="support" element={<Support />} />
              <Route path="admin" element={<Admin />} />
              <Route path="settings" element={<Settings />} />
              <Route path="app/:id" element={<InstanceDetail />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
          </ConfirmProvider>
        </ToastProvider>
      </SessionProvider>
    </ThemeProvider>
  )
}
