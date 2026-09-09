import * as React from "react"
import { ShieldAlert, CheckCircle2, UserX, UserCheck, Trash2 } from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ApiError } from "@/lib/api"
import {
  getOpenReports,
  resolveReport,
  reinstateUser,
  removeComment,
  removePost,
  suspendUser,
  type Report,
} from "@/lib/moderation"

export default function Moderation() {
  const [reports, setReports] = React.useState<Report[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [username, setUsername] = React.useState("")
  const [actionMessage, setActionMessage] = React.useState<string | null>(null)

  const loadReports = React.useCallback(async () => {
    setLoading(true)
    try {
      setReports(await getOpenReports())
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load reports")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loadReports() fetches the queue on mount
    loadReports()
  }, [loadReports])

  async function handleResolve(reportId: string) {
    try {
      await resolveReport(reportId)
      setReports((prev) => prev.filter((r) => r.id !== reportId))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to resolve report")
    }
  }

  async function handleRemoveContent(report: Report) {
    try {
      if (report.targetType === "POST") {
        await removePost(report.targetId)
      } else {
        await removeComment(report.targetId)
      }
      await resolveReport(report.id)
      setReports((prev) => prev.filter((r) => r.id !== report.id))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove content")
    }
  }

  async function handleSuspend() {
    if (!username.trim()) return
    try {
      await suspendUser(username.trim())
      setActionMessage(`Suspended @${username.trim()}`)
    } catch (err) {
      setActionMessage(null)
      setError(err instanceof ApiError ? err.message : "Failed to suspend user")
    }
  }

  async function handleReinstate() {
    if (!username.trim()) return
    try {
      await reinstateUser(username.trim())
      setActionMessage(`Reinstated @${username.trim()}`)
    } catch (err) {
      setActionMessage(null)
      setError(err instanceof ApiError ? err.message : "Failed to reinstate user")
    }
  }

  return (
    <AppLayout headerTitle="Moderation Center">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 p-4 sm:p-6">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-primary/10 text-primary">
            <ShieldAlert className="size-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-foreground">Content Moderation</h1>
            <p className="text-xs text-muted-foreground">Manage reports and user statuses</p>
          </div>
        </div>

        {error && <Alert variant="destructive">{error}</Alert>}
        {actionMessage && <Alert variant="success">{actionMessage}</Alert>}

        <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
          <CardHeader className="p-5 pb-3">
            <CardTitle className="text-sm font-bold">Suspend or reinstate a user</CardTitle>
            <CardDescription className="text-xs">Take direct administrative action on an account handle</CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-1 flex gap-2">
            <Input
              placeholder="Username without @"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="rounded-full text-xs h-10 bg-muted/40 border-border/50 px-4"
            />
            <Button
              variant="destructive"
              onClick={() => void handleSuspend()}
              className="rounded-full text-xs font-semibold px-4 h-10 cursor-pointer shadow-none"
            >
              <UserX className="size-3.5 mr-1" />
              Suspend
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleReinstate()}
              className="rounded-full text-xs font-semibold px-4 h-10 cursor-pointer shadow-none"
            >
              <UserCheck className="size-3.5 mr-1" />
              Reinstate
            </Button>
          </CardContent>
        </Card>

        <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
          <CardHeader className="p-5 pb-3">
            <CardTitle className="text-sm font-bold">Open Reports</CardTitle>
            <CardDescription className="text-xs">{reports.length} pending reports in queue</CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-1 flex flex-col gap-3">
            {loading && <p className="text-xs text-muted-foreground py-4 text-center">Loading reports...</p>}
            {!loading && reports.length === 0 && (
              <p className="text-xs text-muted-foreground py-8 text-center">Queue is clear ? no pending reports.</p>
            )}
            {reports.map((report) => (
              <div
                key={report.id}
                className="flex items-center justify-between gap-3 rounded-2xl bg-muted/30 border border-border/50 p-3.5 text-xs"
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-foreground">
                      {report.targetType}
                    </span>
                    <span className="text-[11px] text-muted-foreground font-mono">
                      #{report.targetId.slice(0, 8)}
                    </span>
                  </div>
                  <span className="text-foreground/90 font-medium">{report.reason}</span>
                  <span className="text-[10px] text-muted-foreground">
                    Reported by @{report.reporterId} on {new Date(report.createdAt).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {report.targetType !== "USER" && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => void handleRemoveContent(report)}
                      className="rounded-full text-xs font-semibold px-3 h-8.5 shadow-none"
                    >
                      <Trash2 className="size-3 mr-1" />
                      Remove
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleResolve(report.id)}
                    className="rounded-full text-xs font-semibold px-3 h-8.5 shadow-none"
                  >
                    <CheckCircle2 className="size-3 mr-1" />
                    Resolve
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  )
}
