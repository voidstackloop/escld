import * as React from "react"
import { BarChart3, Loader2, TrendingUp } from "lucide-react"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { AppLayout } from "@/components/app-layout"
import { Alert } from "@/components/ui/alert"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ApiError } from "@/lib/api"
import { getCreatorInsights, type DailyInsightsPoint, type InsightsHistoryResponse } from "@/lib/user"

type RangePreset = 7 | 30 | 90

const RANGE_LABELS: Record<RangePreset, string> = { 7: "7 days", 30: "30 days", 90: "90 days" }

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function shortDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  })
}

function formatWatchTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${totalSeconds}s`
}

function formatCompact(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

function sum(points: DailyInsightsPoint[], key: keyof DailyInsightsPoint): number {
  return points.reduce((total, p) => total + (typeof p[key] === "number" ? (p[key] as number) : 0), 0)
}

const tooltipStyle: React.CSSProperties = {
  backgroundColor: "var(--card)",
  color: "var(--card-foreground)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  fontSize: 12,
  padding: "8px 12px",
  boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
}

function ChartCard({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
      <CardHeader className="p-5 pb-2">
        <CardTitle className="text-sm font-bold">{title}</CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-5 pt-2">
        <div className="h-56 sm:h-64">
          <ResponsiveContainer width="100%" height="100%">
            {children as React.ReactElement}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

function KpiTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-3xl border border-border/50 bg-card/60 backdrop-blur-sm p-4.5">
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xl font-bold text-foreground tabular-nums">{value}</span>
    </div>
  )
}

export default function Studio() {
  const [range, setRange] = React.useState<RangePreset>(30)
  const [data, setData] = React.useState<InsightsHistoryResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [unavailable, setUnavailable] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      setUnavailable(false)

      const to = new Date()
      const from = new Date(to)
      from.setUTCDate(from.getUTCDate() - range)

      try {
        const result = await getCreatorInsights(isoDate(from), isoDate(to))
        if (!cancelled) setData(result)
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 503) {
          setUnavailable(true)
        } else {
          setError(err instanceof ApiError ? err.message : "Unable to load your Studio data.")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [range])

  const points = data?.points ?? []
  const chartData = points.map((p) => ({ ...p, label: shortDate(p.day) }))

  return (
    <AppLayout
      headerTitle="Creator Studio"
      headerAction={
        <div className="flex gap-1.5 bg-muted/40 p-1 rounded-full border border-border/50">
          {(Object.keys(RANGE_LABELS) as unknown as RangePreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setRange(Number(preset) as RangePreset)}
              className={`rounded-full text-xs font-semibold px-3 py-1 transition-colors cursor-pointer ${range === Number(preset) ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {RANGE_LABELS[Number(preset) as RangePreset]}
            </button>
          ))}
        </div>
      }
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
        {/* Mobile-only range picker */}
        <div className="flex gap-1.5 lg:hidden bg-muted/40 p-1 rounded-full border border-border/50 w-fit">
          {(Object.keys(RANGE_LABELS) as unknown as RangePreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setRange(Number(preset) as RangePreset)}
              className={`rounded-full text-xs font-semibold px-3 py-1 transition-colors cursor-pointer ${range === Number(preset) ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {RANGE_LABELS[Number(preset) as RangePreset]}
            </button>
          ))}
        </div>

        {loading && (
          <div className="flex items-center gap-2 py-20 justify-center text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-primary" />
            <span>Loading your Studio data...</span>
          </div>
        )}

        {!loading && error && <Alert variant="destructive">{error}</Alert>}

        {!loading && unavailable && (
          <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
            <CardContent className="flex flex-col items-center gap-3 p-12 text-center">
              <div className="p-3.5 rounded-2xl bg-primary/10 text-primary">
                <BarChart3 className="size-6" />
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-bold text-foreground">No data for this range yet</p>
                <p className="max-w-sm text-xs text-muted-foreground leading-relaxed">
                  Studio metrics land within a few minutes of real activity on your posts. Try a
                  wider range, or check back after your content gets some views.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {!loading && !error && !unavailable && data && (
          <>
            {data.dataStatus === "PROVISIONAL" && (
              <Alert variant="default">
                Some of the most recent days are still finalizing ? numbers for those days may
                still shift slightly.
              </Alert>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <KpiTile label="Watch time" value={formatWatchTime(sum(points, "watchTimeSeconds"))} />
              <KpiTile label="Reach" value={formatCompact(sum(points, "qualifiedReach"))} />
              <KpiTile label="Likes" value={formatCompact(sum(points, "likeCount"))} />
              <KpiTile label="Comments" value={formatCompact(sum(points, "commentCount"))} />
              <KpiTile label="New followers" value={formatCompact(sum(points, "newFollowerCount"))} />
            </div>

            <ChartCard title="Watch time" description="Total hours watched across all your posts, per day">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="watchTimeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => formatWatchTime(v)}
                  width={72}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(value: number) => [formatWatchTime(value), "Watch time"]}
                />
                <Area
                  type="monotone"
                  dataKey="watchTimeSeconds"
                  stroke="var(--chart-1)"
                  strokeWidth={2}
                  fill="url(#watchTimeFill)"
                  connectNulls={false}
                />
              </AreaChart>
            </ChartCard>

            <ChartCard title="Reach & impressions" description="Unique viewers reached vs. total times your posts were shown">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => formatCompact(v)}
                  width={40}
                />
                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => formatCompact(value)} />
                <Line type="monotone" dataKey="qualifiedReach" name="Reach" stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="qualifiedImpressions" name="Impressions" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="Engagement" description="Likes and comments across all your posts, per day">
              <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => formatCompact(v)}
                  width={40}
                />
                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => formatCompact(value)} />
                <Line type="monotone" dataKey="likeCount" name="Likes" stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls={false} />
                <Line type="monotone" dataKey="commentCount" name="Comments" stroke="var(--chart-2)" strokeWidth={2} dot={false} connectNulls={false} />
              </LineChart>
            </ChartCard>

            <ChartCard title="New followers" description="Followers gained per day">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} axisLine={false} tickLine={false} />
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                  width={32}
                />
                <Tooltip contentStyle={tooltipStyle} formatter={(value: number) => [String(value), "New followers"]} />
                <Bar dataKey="newFollowerCount" name="New followers" fill="var(--chart-1)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartCard>

            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium">
              <TrendingUp className="size-3" />
              <span>
                {data.from} ? {data.to}, updated as of {new Date(data.asOf).toLocaleString()}
              </span>
            </p>
          </>
        )}
      </div>
    </AppLayout>
  )
}
