import { Navigate, Outlet } from "react-router-dom"

import { useAuth } from "@/lib/auth-context"

function RequireAuth() {
  const { user, loading } = useAuth()

  if (loading) return null
  if (!user) return <Navigate to="/login" replace />

  return <Outlet />
}

function RequireGuest() {
  const { user, loading } = useAuth()

  if (loading) return null
  if (user) return <Navigate to="/" replace />

  return <Outlet />
}

/** Gates a route on Cognito group membership — any one of `anyOf` grants access. */
function RequireRole({ anyOf }: { anyOf: string[] }) {
  const { user, roles, loading } = useAuth()

  if (loading) return null
  if (!user) return <Navigate to="/login" replace />
  if (!anyOf.some((role) => roles.includes(role))) return <Navigate to="/" replace />

  return <Outlet />
}

export { RequireAuth, RequireGuest, RequireRole }
