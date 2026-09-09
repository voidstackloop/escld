import * as React from "react"
import { confirmResetPassword } from "aws-amplify/auth"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { KeyRound, Lock, Eye, EyeOff, Check, Loader2 } from "lucide-react"

import { AuthLayout } from "@/components/auth-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { passwordFailures, PASSWORD_REQUIREMENTS } from "@/lib/validators"
import { cn } from "@/lib/utils"

export default function ResetPassword() {
  const navigate = useNavigate()
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email ?? ""

  const [code, setCode] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!email) navigate("/forgot-password", { replace: true })
  }, [email, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const missing = passwordFailures(password)
    if (missing.length > 0) {
      setError(`Password needs: ${missing.join(", ")}.`)
      return
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }

    setSubmitting(true)
    try {
      await confirmResetPassword({
        username: email,
        confirmationCode: code.trim(),
        newPassword: password,
      })
      navigate("/login", { state: { passwordReset: true } })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reset password.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Set new password"
      description={`Enter the reset code sent to ${email} and choose a new password.`}
      footer={
        <>
          Didn&apos;t receive a code?{" "}
          <Link to="/forgot-password" className="font-semibold text-foreground underline underline-offset-4 hover:text-primary">
            Send again
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-3.5" onSubmit={handleSubmit}>
        {error && <Alert variant="destructive">{error}</Alert>}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code" className="text-xs font-semibold">Reset code</Label>
          <div className="relative flex items-center">
            <KeyRound className="absolute left-3.5 size-4 text-muted-foreground/70" />
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-10.5 pl-10 font-mono tracking-wider rounded-full text-xs sm:text-sm bg-muted/40 border-border/50 focus:bg-background"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password" className="text-xs font-semibold">New password</Label>
          <div className="relative flex items-center">
            <Lock className="absolute left-3.5 size-4 text-muted-foreground/70" />
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
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

          {password.length > 0 && (
            <div className="grid grid-cols-2 gap-1.5 p-2.5 rounded-2xl bg-muted/30 border border-border/50 text-[11px] mt-1">
              {PASSWORD_REQUIREMENTS.map((req) => {
                const passed = req.test(password)
                return (
                  <div
                    key={req.label}
                    className={cn(
                      "flex items-center gap-1.5",
                      passed ? "text-emerald-500 font-medium" : "text-muted-foreground"
                    )}
                  >
                    <Check className={cn("size-3 stroke-[3]", passed ? "opacity-100" : "opacity-30")} />
                    <span>{req.label}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="confirm-password" className="text-xs font-semibold">Confirm new password</Label>
          <div className="relative flex items-center">
            <Lock className="absolute left-3.5 size-4 text-muted-foreground/70" />
            <Input
              id="confirm-password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              required
              placeholder="????????"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="h-10.5 pl-10 rounded-full text-xs sm:text-sm bg-muted/40 border-border/50 focus:bg-background"
            />
          </div>
          {confirmPassword && password !== confirmPassword && (
            <p className="text-[11px] text-destructive font-medium">Passwords do not match</p>
          )}
        </div>

        <Button
          type="submit"
          className="mt-2 w-full h-10.5 rounded-full font-bold text-sm shadow-sm cursor-pointer"
          size="lg"
          disabled={submitting}
        >
          {submitting && <Loader2 className="size-4 animate-spin mr-2" />}
          {submitting ? "Resetting password..." : "Reset Password"}
        </Button>
      </form>
    </AuthLayout>
  )
}
