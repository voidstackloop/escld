import * as React from "react"
import { Link } from "react-router-dom"
import {
  Heart,
  MessageCircle,
  Share2,
  Flag,
  Check,
  AlertCircle,
  Loader2,
  Flame,
  Radio,
  Eye,
  EyeOff,
  BarChart2,
} from "lucide-react"

import { CommentSection } from "@/components/comment-section"
import { ReportForm } from "@/components/report-form"
import { Alert } from "@/components/ui/alert"
import { ApiError } from "@/lib/api"
import { LIVE_VIEWER_HEARTBEAT_INTERVAL_MS, sendLiveViewerHeartbeat } from "@/lib/live"
import { getPostInsights, hidePost, likePost, unlikePost, type Post, type PostInsights } from "@/lib/post"
import { cn, formatRelativeTime } from "@/lib/utils"
import { useMediaProgress } from "@/hooks/use-media-progress"

/** Pings a heartbeat while mounted ? the only signal the backend has that
 * someone is actually watching a live stream. Only mounted while post.liveStatus === "LIVE". */
function LiveViewerBadge({ postId }: { postId: string }) {
  const [viewerCount, setViewerCount] = React.useState<number | null>(null)

  React.useEffect(() => {
    let cancelled = false

    async function beat() {
      try {
        const result = await sendLiveViewerHeartbeat(postId)
        if (!cancelled) setViewerCount(result.viewerCount)
      } catch {
        // A missed heartbeat just skips this tick
      }
    }

    void beat()
    const interval = setInterval(() => void beat(), LIVE_VIEWER_HEARTBEAT_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [postId])

  if (viewerCount === null) return null

  return (
    <span className="absolute top-2.5 right-2.5 flex items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-[11px] font-semibold text-white backdrop-blur-md">
      <Eye className="size-3" />
      {viewerCount}
    </span>
  )
}

function formatStreamDuration(startedAt: string | null, endedAt: string | null): string | null {
  if (!startedAt || !endedAt) return null
  const totalSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function formatSeconds(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = Math.floor(totalSeconds % 60)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

function PostInsightsPanel({ postId }: { postId: string }) {
  const [insights, setInsights] = React.useState<PostInsights | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    getPostInsights(postId)
      .then((result) => {
        if (!cancelled) setInsights(result)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Unable to load insights.")
      })
    return () => {
      cancelled = true
    }
  }, [postId])

  if (error) {
    return <Alert variant="destructive">{error}</Alert>
  }

  if (!insights) {
    return (
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        <span>Loading insights...</span>
      </div>
    )
  }

  const stats: { label: string; value: string }[] = [
    { label: "Likes", value: String(insights.likeCount) },
    { label: "Comments", value: String(insights.commentCount) },
    { label: "Trending score", value: insights.trendingScore.toFixed(1) },
  ]
  if (insights.liveStatus === "LIVE" && insights.currentViewerCount !== null) {
    stats.push({ label: "Watching now", value: String(insights.currentViewerCount) })
  }
  if (insights.liveStatus === "ENDED" && insights.peakViewerCount !== null) {
    stats.push({ label: "Peak viewers", value: String(insights.peakViewerCount) })
  }
  if (insights.durationSeconds !== null) {
    stats.push({ label: "Stream duration", value: formatSeconds(insights.durationSeconds) })
  }

  return (
    <div className="grid grid-cols-2 gap-3 rounded-2xl bg-muted/40 p-3.5 sm:grid-cols-3 border border-border/50">
      {stats.map((stat) => (
        <div key={stat.label} className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">{stat.label}</span>
          <span className="text-sm font-bold text-foreground tabular-nums">{stat.value}</span>
        </div>
      ))}
    </div>
  )
}

function PostMedia({ post }: { post: Post }) {
  const mediaProgressRef = useMediaProgress(
    post.mediaType === "VIDEO" ? post.recommendation?.observationToken : undefined
  )

  if (post.mediaType === "LIVE") {
    const duration = formatStreamDuration(post.liveStartedAt, post.liveEndedAt)
    const viewerLabel = `${post.peakViewerCount} peak viewer${post.peakViewerCount === 1 ? "" : "s"}${duration ? ` \u00B7 ${duration}` : ""}`
    return (
      <div className="flex flex-col gap-2 mt-1">
        {post.mediaUrl && post.mediaStatus === "READY" ? (
          <div className="relative overflow-hidden rounded-2xl border border-border/60 bg-black">
            <video autoPlay muted controls className="max-h-[36rem] w-full rounded-2xl bg-black" src={post.mediaUrl} />
            {post.liveStatus === "LIVE" && <LiveViewerBadge postId={post.id} />}
          </div>
        ) : (
          <div className="flex h-40 items-center justify-center rounded-2xl bg-muted/40 border border-border/50 text-xs text-muted-foreground gap-2">
            <Radio className="size-4 text-rose-500" />
            <span>{post.liveStatus === "LIVE" ? "Stream starting soon" : "Stream ended"}</span>
          </div>
        )}
        {post.liveStatus === "ENDED" && post.peakViewerCount !== null && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium">
            <Eye className="size-3" />
            <span>{viewerLabel}</span>
          </p>
        )}
        {post.description && (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground leading-relaxed break-words">
            {post.description}
          </p>
        )}
      </div>
    )
  }

  if (!post.mediaUrl || post.mediaType === null) return null

  if (post.mediaStatus === "PROCESSING") {
    return (
      <div className="flex h-48 items-center justify-center rounded-2xl bg-muted/40 border border-border/50 text-xs text-muted-foreground gap-2 mt-1">
        <Loader2 className="size-4 animate-spin text-primary" />
        <span>Processing media...</span>
      </div>
    )
  }

  if (post.mediaStatus === "FAILED") {
    return (
      <div className="flex h-40 items-center justify-center rounded-2xl bg-destructive/10 border border-destructive/20 text-xs text-destructive gap-2 mt-1">
        <AlertCircle className="size-4" />
        <span>Media failed to process.</span>
      </div>
    )
  }

  if (post.mediaStatus !== "READY") return null

  if (post.mediaType === "IMAGE") {
    return (
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-muted/20 mt-1">
        <img
          src={post.mediaUrl}
          alt=""
          loading="lazy"
          className="max-h-[36rem] w-full object-cover"
        />
      </div>
    )
  }

  if (post.mediaType === "VIDEO") {
    return (
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-black mt-1">
        <video
          ref={mediaProgressRef}
          controls
          className="max-h-[36rem] w-full rounded-2xl bg-black"
          src={post.mediaUrl}
        />
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-card/60 p-3 shadow-sm mt-1">
      <audio controls className="w-full" src={post.mediaUrl} />
    </div>
  )
}

function PostCardImpl({
  post,
  className,
  onHidden,
  showInsights = false,
}: {
  post: Post
  className?: string
  onHidden?: () => void
  showInsights?: boolean
}) {
  const [commentsOpen, setCommentsOpen] = React.useState(false)
  const [commentCount, setCommentCount] = React.useState(post.commentCount)
  const [liked, setLiked] = React.useState(post.likedByViewer)
  const [likeCount, setLikeCount] = React.useState(post.likeCount)
  const [copied, setCopied] = React.useState(false)
  const [reportOpen, setReportOpen] = React.useState(false)
  const [insightsOpen, setInsightsOpen] = React.useState(false)
  const [hidePending, setHidePending] = React.useState(false)
  const likePendingRef = React.useRef(false)

  async function handleHide() {
    if (hidePending) return
    setHidePending(true)
    try {
      await hidePost(post.id)
      onHidden?.()
    } catch {
      setHidePending(false)
    }
  }

  async function handleToggleLike() {
    if (likePendingRef.current) return
    likePendingRef.current = true

    const wasLiked = liked
    setLiked(!wasLiked)
    setLikeCount((count) => count + (wasLiked ? -1 : 1))

    try {
      const result = wasLiked ? await unlikePost(post.id) : await likePost(post.id)
      setLiked(result.liked)
      setLikeCount(result.likeCount)
    } catch {
      setLiked(wasLiked)
      setLikeCount((count) => count + (wasLiked ? 1 : -1))
    } finally {
      likePendingRef.current = false
    }
  }

  async function handleCopyLink() {
    try {
      const url = `${window.location.origin}/profile/${post.authorUsername}`
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard write failure
    }
  }

  const avatarUrl =
    post.authorAvatarUrl ??
    `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(post.authorUsername)}`

  return (
    <article
      className={cn(
        "w-full border-b border-border/50 hover:bg-muted/15 transition-colors p-4 sm:p-5 flex flex-col gap-3",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Link to={`/profile/${post.authorUsername}`} className="shrink-0 hover:opacity-85 transition-opacity">
            <img
              src={avatarUrl}
              alt=""
              className="size-10 rounded-full ring-1 ring-border/80 object-cover"
            />
          </Link>
          <div className="flex min-w-0 flex-col leading-tight">
            <Link
              to={`/profile/${post.authorUsername}`}
              className="truncate text-[14.5px] font-bold text-foreground hover:underline decoration-1 underline-offset-2"
            >
              {post.authorDisplayName}
            </Link>
            <span className="truncate text-xs text-muted-foreground">
              @{post.authorUsername} {"\u00B7"} {formatRelativeTime(post.createdAt)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {post.mediaType === "LIVE" && post.liveStatus === "LIVE" && (
            <span
              className="flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-bold text-rose-500 border border-rose-500/20"
              title="Live now"
            >
              <Radio className="size-3" />
              LIVE
            </span>
          )}

          {post.trending && (
            <span
              className="flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary border border-primary/20"
              title="Trending now"
            >
              <Flame className="size-3 fill-primary/30" />
              Trending
            </span>
          )}
        </div>
      </div>

      {post.text && (
        <p className="whitespace-pre-wrap text-[15px] text-foreground leading-relaxed break-words">
          {post.text}
        </p>
      )}

      <PostMedia post={post} />

      {post.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {post.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted/60 hover:bg-primary/10 hover:text-primary px-2.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors cursor-pointer"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Action Toolbar */}
      <div className="flex items-center justify-between pt-1 text-muted-foreground select-none">
        <div className="flex items-center gap-5 sm:gap-7">
          <button
            type="button"
            onClick={() => void handleToggleLike()}
            className={cn(
              "group flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer",
              liked ? "text-rose-500" : "hover:text-rose-500"
            )}
            aria-pressed={liked}
          >
            <div
              className={cn(
                "p-1.5 rounded-full transition-transform group-hover:scale-110",
                liked ? "bg-rose-500/10" : "group-hover:bg-rose-500/10"
              )}
            >
              <Heart className={cn("size-4", liked && "fill-current")} />
            </div>
            <span>{likeCount}</span>
          </button>

          <button
            type="button"
            onClick={() => setCommentsOpen((open) => !open)}
            className={cn(
              "group flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer",
              commentsOpen ? "text-primary font-semibold" : "hover:text-primary"
            )}
            aria-expanded={commentsOpen}
          >
            <div
              className={cn(
                "p-1.5 rounded-full transition-transform group-hover:scale-110",
                commentsOpen ? "bg-primary/10" : "group-hover:bg-primary/10"
              )}
            >
              <MessageCircle className="size-4" />
            </div>
            <span>{commentCount}</span>
          </button>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void handleCopyLink()}
            className="group flex items-center gap-1 text-xs hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-muted/70 cursor-pointer"
            title="Copy profile link"
          >
            {copied ? (
              <Check className="size-4 text-emerald-500" />
            ) : (
              <Share2 className="size-4" />
            )}
            <span className="sr-only">Share</span>
          </button>

          <button
            type="button"
            onClick={() => void handleHide()}
            disabled={hidePending}
            className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-full hover:bg-muted/70 cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
            title="Not interested"
          >
            {hidePending ? <Loader2 className="size-4 animate-spin" /> : <EyeOff className="size-4" />}
            <span className="sr-only">Not interested</span>
          </button>

          {showInsights && (
            <button
              type="button"
              onClick={() => setInsightsOpen((open) => !open)}
              className={cn(
                "group flex items-center gap-1 text-xs transition-colors p-1.5 rounded-full hover:bg-muted/70 cursor-pointer",
                insightsOpen ? "text-primary font-semibold" : "hover:text-primary"
              )}
              title="View insights"
              aria-expanded={insightsOpen}
            >
              <BarChart2 className="size-4" />
              <span className="sr-only">Insights</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setReportOpen((open) => !open)}
            className={cn(
              "group flex items-center gap-1 text-xs transition-colors p-1.5 rounded-full hover:bg-muted/70 cursor-pointer",
              reportOpen ? "text-destructive" : "hover:text-destructive"
            )}
            title="Report post"
            aria-expanded={reportOpen}
          >
            <Flag className="size-4" />
            <span className="sr-only">Report</span>
          </button>
        </div>
      </div>

      {reportOpen && (
        <ReportForm targetType="POST" targetId={post.id} onDone={() => setReportOpen(false)} />
      )}

      {insightsOpen && <PostInsightsPanel postId={post.id} />}

      {commentsOpen && (
        <div className="pt-2 border-t border-border/40">
          <CommentSection
            postId={post.id}
            onCommentAdded={() => setCommentCount((count) => count + 1)}
          />
        </div>
      )}
    </article>
  )
}

export const PostCard = React.memo(PostCardImpl)
