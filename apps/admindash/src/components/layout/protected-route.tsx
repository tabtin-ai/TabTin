import { useAuthStore } from '@/stores/auth-store'
import { useEffect } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'

export function ProtectedRoute() {
  const { isAuthenticated, adminPermissionsLoaded, loadAdminPermissions } = useAuthStore()
  const location = useLocation()

  useEffect(() => {
    if (isAuthenticated && !adminPermissionsLoaded) {
      void loadAdminPermissions()
    }
  }, [adminPermissionsLoaded, isAuthenticated, loadAdminPermissions])

  if (!isAuthenticated) {
    // Redirect to login page but save the current location they were trying to go to
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}
