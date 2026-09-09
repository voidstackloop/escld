import * as React from "react"
import { Link } from "react-router-dom"
import { UserCheck, Check, X, Loader2 } from "lucide-react"

import { Alert } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ApiError } from "@/lib/api"
import {
  acceptFollowRequest,
  getPendingFollowRequests,
  rejectFollowRequest,
  type PendingFollowRequest,
} from "@/lib/follow"

export function FollowRequestsCard() {
  const [requests, setRequests] = React.useState<PendingFollowRequest[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const [pendingAction, setPendingAction] = React.useState<Record<string, "accept" | "reject">>({})

  React.useEffect(() => {
    let cancelled = false

    getPendingFollowRequests()
      .then((data) => {
        if (!cancelled) setRequests(data)
      })
      .catch((err) => {
        if (cancelled) return
        setLoadError(err instanceof ApiError ? err.message : "Unable to load follow requests.")
      })

    return () => {
      cancelled = true
    }
  }, [])

  async function handleAccept(username: string) {
    setActionError(null)
    setPendingAction((prev) => ({ ...prev, [username]: "accept" }))
    try {
      await acceptFollowRequest(username)
      setRequests((prev) => prev?.filter((r) => r.username !== username) ?? prev)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Unable to accept @${username}'s request.`)
    } finally {
      setPendingAction((prev) => {
        const next = { ...prev }
        delete next[username]
        return next
      })
    }
  }

  async function handleReject(username: string) {
    setActionError(null)
    setPendingAction((prev) => ({ ...prev, [username]: "reject" }))
    try {
      await rejectFollowRequest(username)
      setRequests((prev) => prev?.filter((r) => r.username !== username) ?? prev)
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : `Unable to reject @${username}'s request.`)
    } finally {
      setPendingAction((prev) => {
        const next = { ...prev }
        delete next[username]
        return next
      })
    }
  }

  if (requests !== null && requests.length === 0 && !loadError) {
    return null
  }

  return (
    <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
      <CardHeader className="p-5 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10 text-primary">
            <UserCheck className="size-4" />
          </div>
          <div>
            <CardTitle className="text-sm font-bold">Follow Requests</CardTitle>
            <CardDescription className="text-xs">
              People who want to follow your private account
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 pt-2 flex flex-col gap-3">
        {loadError && <Alert variant="destructive">{loadError}</Alert>}
        {actionError && <Alert variant="destructive">{actionError}</Alert>}

        {requests === null && !loadError && (
          <div className="flex items-center justify-center py-6 gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading requests...</span>
          </div>
        )}

        {requests?.map((request) => {
          const busy = pendingAction[request.username]
          return (
            <div
              key={request.username}
              className="flex items-center justify-between gap-3 rounded-2xl bg-muted/30 border border-border/50 p-3"
            >
              <Link
                to={`/profile/${request.username}`}
                className="flex min-w-0 items-center gap-3 hover:opacity-85 transition-opacity"
              >
                <img
                  src={
                    request.avatarUrl ??
                    `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(request.username)}`
                  }
                  alt=""
                  className="size-9 shrink-0 rounded-full ring-1 ring-border/80 object-cover"
                />
                <div className="flex min-w-0 flex-col leading-tight">
                  <span className="truncate text-xs font-semibold text-foreground">
                    {request.displayName}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    @{request.username}
                  </span>
                </div>
              </Link>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleReject(request.username)}
                  disabled={Boolean(busy)}
                  title={`Reject @${request.username}`}
                  aria-label={`Reject @${request.username}`}
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busy === "reject" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-4" />}
                </button>
                <button
                  type="button"
                  onClick={() => void handleAccept(request.username)}
                  disabled={Boolean(busy)}
                  title={`Accept @${request.username}`}
                  aria-label={`Accept @${request.username}`}
                  className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busy === "accept" ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-4" />}
                </button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
