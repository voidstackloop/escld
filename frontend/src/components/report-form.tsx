import * as React from "react"
import { Loader2, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"
import { fileReport, type ReportTargetType } from "@/lib/moderation"

export function ReportForm({
  targetType,
  targetId,
  onDone,
}: {
  targetType: ReportTargetType
  targetId: string
  onDone: () => void
}) {
  const [reason, setReason] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [submitted, setSubmitted] = React.useState(false)

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = reason.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      await fileReport(targetType, targetId, trimmed)
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to submit report.")
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2 text-xs text-muted-foreground animate-in fade-in-50">
        <span>Report submitted. A moderator will review it.</span>
        <button
          type="button"
          onClick={onDone}
          className="font-medium text-foreground hover:underline cursor-pointer"
        >
          Close
        </button>
      </div>
    )
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-xl bg-muted/40 p-2.5 animate-in fade-in-50"
    >
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why are you reporting this?"
        maxLength={500}
        autoFocus
        className="h-9 w-full min-w-0 rounded-lg border border-input bg-background px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 transition-all"
      />
      {error && <p className="text-xs text-destructive font-medium">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onDone}
          className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
        >
          Cancel
        </button>
        <Button
          type="submit"
          size="sm"
          disabled={!reason.trim() || submitting}
          className="rounded-lg px-3 h-8 text-xs font-medium cursor-pointer"
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <>
              <Send className="size-3 mr-1" />
              <span>Submit report</span>
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
