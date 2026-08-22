import { useEffect } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth-store'
import type { LocationState } from '@/types/router'

export function PublicRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const location = useLocation()
  const fromState = (location.state as LocationState | null)?.from
  const from = fromState
    ? `${fromState.pathname}${fromState.search ?? ''}${fromState.hash ?? ''}`
    : '/'

  useEffect(() => {
    useAuthStore.setState({ error: null })
  }, [location.pathname])

  if (isAuthenticated) {
    return <Navigate to={from} replace />
  }

  return <>{children}</>
}
