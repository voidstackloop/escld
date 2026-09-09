import * as React from "react"
import { Link } from "react-router-dom"
import { Flag, Loader2, Send } from "lucide-react"

import { ReportForm } from "@/components/report-form"
import { Button } from "@/components/ui/button"
import { ApiError } from "@/lib/api"
import { createComment, getComments, type Comment } from "@/lib/comment"
import { cn, formatRelativeTime } from "@/lib/utils"

export function CommentSection({
  postId,
  onCommentAdded,
}: {
  postId: string
  onCommentAdded: () => void
}) {
  const [comments, setComments] = React.useState<Comment[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [text, setText] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [reportingId, setReportingId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    getComments(postId)
      .then((data) => {
        if (!cancelled) setComments(data)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : "Unable to load comments.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [postId])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || submitting) return

    setSubmitting(true)
    setError(null)
    try {
      const comment = await createComment(postId, trimmed)
      setComments((prev) => [comment, ...prev])
      setText("")
      onCommentAdded()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to post comment.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-3 border-t border-border/50 animate-in fade-in-50">
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Write a reply..."
          maxLength={300}
          className="h-9 w-full min-w-0 rounded-xl border border-input bg-muted/40 px-3 py-1.5 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 transition-all"
        />
        <Button
          type="submit"
          size="sm"
          disabled={!text.trim() || submitting}
          className="rounded-xl px-3 h-9 font-medium shrink-0 cursor-pointer"
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <>
              <Send className="size-3 mr-1" />
              <span>Reply</span>
            </>
          )}
        </Button>
      </form>

      {error && <p className="text-xs text-destructive font-medium">{error}</p>}

      {loading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin text-primary" />
          <span>Loading comments...</span>
        </div>
      )}

      {!loading && comments.length === 0 && !error && (
        <p className="py-2 text-xs text-muted-foreground/70 italic text-center">
          No comments yet. Be the first to join the conversation!
        </p>
      )}

      <div className="flex flex-col divide-y divide-border/30">
        {comments.map((comment) => {
          const avatarUrl =
            comment.authorAvatarUrl ??
            `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(comment.authorUsername)}`
          return (
            <div key={comment.id} className="flex items-start gap-2.5 py-2.5 first:pt-1">
              <Link to={`/profile/${comment.authorUsername}`} className="shrink-0 mt-0.5 hover:opacity-85">
                <img src={avatarUrl} alt="" className="size-7 rounded-full ring-1 ring-border object-cover" />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-baseline justify-between gap-1.5">
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <Link
                      to={`/profile/${comment.authorUsername}`}
                      className="truncate text-xs font-semibold text-foreground hover:text-primary hover:underline"
                    >
                      {comment.authorDisplayName}
                    </Link>
                    <span className="truncate text-[0.7rem] text-muted-foreground">
                      @{comment.authorUsername} ? {formatRelativeTime(comment.createdAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setReportingId((current) => (current === comment.id ? null : comment.id))
                    }
                    className={cn(
                      "shrink-0 p-1 rounded-full transition-colors cursor-pointer",
                      reportingId === comment.id
                        ? "text-destructive"
                        : "text-muted-foreground hover:text-destructive"
                    )}
                    title="Report comment"
                    aria-expanded={reportingId === comment.id}
                  >
                    <Flag className="size-3" />
                    <span className="sr-only">Report comment</span>
                  </button>
                </div>
                <p className="text-xs text-foreground/90 mt-0.5 whitespace-pre-wrap break-words">
                  {comment.text}
                </p>
                {reportingId === comment.id && (
                  <div className="mt-2">
                    <ReportForm
                      targetType="COMMENT"
                      targetId={comment.id}
                      onDone={() => setReportingId(null)}
                    />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
