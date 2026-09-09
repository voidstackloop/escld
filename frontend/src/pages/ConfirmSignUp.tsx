import * as React from "react"
import { confirmSignUp, resendSignUpCode } from "aws-amplify/auth"
import { Link, useLocation, useNavigate } from "react-router-dom"
import { KeyRound, Loader2, RotateCcw, CheckCircle2 } from "lucide-react"

import { AuthLayout } from "@/components/auth-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export default function ConfirmSignUp() {
  const navigate = useNavigate()
  const location = useLocation()
  const email = (location.state as { email?: string } | null)?.email ?? ""

  const [code, setCode] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [resending, setResending] = React.useState(false)

  React.useEffect(() => {
    if (!email) navigate("/sign-up", { replace: true })
  }, [email, navigate])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setSubmitting(true)

    try {
      const { nextStep } = await confirmSignUp({
        username: email,
        confirmationCode: code.trim(),
      })

      if (nextStep.signUpStep === "DONE") {
        navigate("/login", { state: { confirmed: true } })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to confirm account.")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResend() {
    setError(null)
    setNotice(null)
    setResending(true)
    try {
      await resendSignUpCode({ username: email })
      setNotice("A fresh verification code was sent to your email.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to resend code.")
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthLayout
      title="Verify your email"
      description={`We sent a 6-digit confirmation code to ${email}.`}
      footer={
        <>
          Wrong email address?{" "}
          <Link to="/sign-up" className="font-semibold text-foreground underline underline-offset-4 hover:text-primary">
            Sign up again
          </Link>
        </>
      }
    >
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {error && <Alert variant="destructive">{error}</Alert>}
        {notice && (
          <Alert variant="success" className="flex items-center gap-2">
            <CheckCircle2 className="size-4 shrink-0" />
            <span>{notice}</span>
          </Alert>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code" className="text-xs font-semibold">Verification Code</Label>
          <div className="relative flex items-center">
            <KeyRound className="absolute left-4 size-4 text-muted-foreground/70" />
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="h-11 pl-11 text-center font-mono tracking-widest text-base rounded-full bg-muted/40 border-border/50 focus:bg-background"
            />
          </div>
        </div>

        <Button
          type="submit"
          className="w-full h-10.5 rounded-full font-bold text-sm shadow-sm cursor-pointer"
          size="lg"
          disabled={submitting || !code.trim()}
        >
          {submitting && <Loader2 className="size-4 animate-spin mr-2" />}
          {submitting ? "Verifying..." : "Verify Account"}
        </Button>

        <Button
          type="button"
          variant="ghost"
          className="w-full text-xs text-muted-foreground hover:text-foreground cursor-pointer rounded-full"
          disabled={resending}
          onClick={handleResend}
        >
          {resending ? (
            <Loader2 className="size-3.5 animate-spin mr-1.5" />
          ) : (
            <RotateCcw className="size-3.5 mr-1.5" />
          )}
          <span>{resending ? "Sending code..." : "Resend verification code"}</span>
        </Button>
      </form>
    </AuthLayout>
  )
}
