import * as React from "react"
import { resetPassword } from "aws-amplify/auth"
import { Link, useNavigate } from "react-router-dom"
import { Mail, ArrowLeft, Loader2 } from "lucide-react"

import { AuthLayout } from "@/components/auth-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { isValidEmail } from "@/lib/validators"

export default function ForgotPassword() {
  const navigate = useNavigate()

  const [email, setEmail] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!isValidEmail(email)) {
      setError("Enter a valid email address.")
      return
    }

    setSubmitting(true)
    try {
      const { nextStep } = await resetPassword({ username: email })

      if (nextStep.resetPasswordStep === "CONFIRM_RESET_PASSWORD_WITH_CODE") {
        navigate("/reset-password", { state: { email } })
        return
      }

      navigate("/login")
    } catch (err) {
      // Avoid confirming whether an account exists for this email
      if (err instanceof Error && err.name === "UserNotFoundException") {
        navigate("/reset-password", { state: { email } })
        return
      }
      setError(err instanceof Error ? err.message : "Unable to send reset code.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthLayout
      title="Reset password"
      description="Enter your email and we'll send you a verification code to reset your password."
      footer={
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 font-semibold text-foreground underline underline-offset-4 hover:text-primary"
        >
          <ArrowLeft className="size-3" />
          <span>Back to sign in</span>
        </Link>
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

        <Button
          type="submit"
          className="mt-2 w-full h-10.5 rounded-full font-bold text-sm shadow-sm cursor-pointer"
          size="lg"
          disabled={submitting}
        >
          {submitting && <Loader2 className="size-4 animate-spin mr-2" />}
          {submitting ? "Sending code..." : "Send Reset Code"}
        </Button>
      </form>
    </AuthLayout>
  )
}
