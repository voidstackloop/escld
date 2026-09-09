/* eslint-disable react-refresh/only-export-components */
import * as React from "react"
import { fetchAuthSession, getCurrentUser, signOut as amplifySignOut, type AuthUser } from "aws-amplify/auth"

type AuthContextValue = {
  user: AuthUser | null
  /** Cognito User Pool Group names ("admin", "moderator"), from the "cognito:groups" claim. */
  roles: string[]
  loading: boolean
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null)
  const [roles, setRoles] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)

  const refresh = React.useCallback(async () => {
    try {
      const current = await getCurrentUser()
      setUser(current)
      const session = await fetchAuthSession()
      const groups = session.tokens?.idToken?.payload?.["cognito:groups"]
      setRoles(Array.isArray(groups) ? groups.map(String) : [])
    } catch {
      setUser(null)
      setRoles([])
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() fetches the current session on mount
    refresh()
  }, [refresh])

  const signOut = React.useCallback(async () => {
    await amplifySignOut()
    setUser(null)
    setRoles([])
  }, [])

  return (
    <AuthContext.Provider value={{ user, roles, loading, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

function useAuth() {
  const ctx = React.useContext(AuthContext)
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider")
  return ctx
}

export { AuthProvider, useAuth }
