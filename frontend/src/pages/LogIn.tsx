import * as React from "react"
import { signIn } from "aws-amplify/auth"
import { Link, useNavigate } from "react-router-dom"
import { Mail, Lock, Eye, EyeOff, Loader2 } from "lucide-react"

import { AuthLayout } from "@/components/auth-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/lib/auth-context"

export default function LogIn() {
  const navigate = useNavigate()
  const { refresh } = useAuth()

  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)

    try {
      const { nextStep } = await signIn({ username: email, password })

      if (nextStep.signInStep === "CONFIRM_SIGN_UP") {
        navigate("/confirm-sign-up", { state: { email } })
        return
      }

      if (nextStep.signInStep === "DONE") {
        await refresh()
        navigate("/")
        return
      }

      setError("This account requires an additional verification step that isn't supported yet.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Welcome back"
      description="Enter your credentials to access your account."
      footer={
        <>
          Don&apos;t have an account yet?{" "}
          <Link to="/sign-up" className="font-semibold text-foreground underline underline-offset-4 hover:text-primary">
            Create account
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email" className="text-xs font-semibold">Email address</Label>
          <div className="relative flex items-center">
            <Mail className="absolute left-3.5 size-4 text-muted-foreground/70" />
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10.5 pl-10 rounded-full text-xs sm:text-sm bg-muted/40 border-border/50 focus:bg-background"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password" className="text-xs font-semibold">Password</Label>
            <Link
              to="/forgot-password"
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative flex items-center">
            <Lock className="absolute left-3.5 size-4 text-muted-foreground/70" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              required
              placeholder="????????"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-10.5 pl-10 pr-10 rounded-full text-xs sm:text-sm bg-muted/40 border-border/50 focus:bg-background"
            />
            <button
              type="button"
              onClick={() => setShowPassword((prev) => !prev)}
              className="absolute right-3.5 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        <Button
          type="submit"
          className="mt-2 w-full h-10.5 rounded-full font-bold text-sm shadow-sm cursor-pointer"
          size="lg"
          disabled={submitting}
        >
          {submitting && <Loader2 className="size-4 animate-spin mr-2" />}
          {submitting ? "Signing in..." : "Sign In"}
        </Button>
      </form>
    </AuthLayout>
  )
}
