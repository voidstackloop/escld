import * as React from "react"
import { Loader2 } from "lucide-react"
import { Navigate, Route, Routes } from "react-router-dom"
import { RequireAuth, RequireGuest, RequireRole } from "@/components/route-guards"
import { AuthProvider } from "@/lib/auth-context"
import { ThemeProvider } from "@/lib/theme-context"
import ConfirmSignUp from "@/pages/ConfirmSignUp"
import ForgotPassword from "@/pages/ForgotPassword"
import Home from "@/pages/Home"
import Live from "@/pages/Live"
import LogIn from "@/pages/LogIn"
import Messages from "@/pages/Messages"
import Moderation from "@/pages/Moderation"
import Profile from "@/pages/Profile"
import ResetPassword from "@/pages/ResetPassword"
import Settings from "@/pages/Settings"
import SignUp from "@/pages/SignUp"

// Lazy: recharts (Studio's only real dependency beyond every other page's
// shared bundle) adds ~250kB gzipped on its own — code-splitting it out
// keeps every other route's initial load unaffected by a library only one
// page uses.
const Studio = React.lazy(() => import("@/pages/Studio"))

function App() {
  return (
    <ThemeProvider defaultTheme="system">
      <AuthProvider>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/" element={<Home />} />
            <Route path="/live" element={<Live />} />
            <Route
              path="/studio"
              element={
                <React.Suspense
                  fallback={
                    <div className="flex min-h-svh items-center justify-center">
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  }
                >
                  <Studio />
                </React.Suspense>
              }
            />
            <Route path="/messages" element={<Messages />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/profile/:username" element={<Profile />} />
          </Route>

          <Route element={<RequireRole anyOf={["admin", "moderator"]} />}>
            <Route path="/moderation" element={<Moderation />} />
          </Route>

          <Route element={<RequireGuest />}>
            <Route path="/login" element={<LogIn />} />
            <Route path="/sign-up" element={<SignUp />} />
            <Route path="/confirm-sign-up" element={<ConfirmSignUp />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </ThemeProvider>
  )
}

export default App
