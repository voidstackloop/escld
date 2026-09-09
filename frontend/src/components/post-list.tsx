import * as React from "react"
import { Sparkles, RefreshCw } from "lucide-react"

import { PostCard } from "@/components/post-card"
import { PostCardSkeleton } from "@/components/post-card-skeleton"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { usePaginatedPosts } from "@/hooks/use-paginated-posts"
import { useQualifiedImpression } from "@/hooks/use-qualified-impression"
import type { Post, PostPage } from "@/lib/post"

function ObservedPostCard({
  post,
  onHidden,
  showInsights,
}: {
  post: Post
  onHidden: () => void
  showInsights: boolean
}) {
  const observationRef = useQualifiedImpression(post.recommendation?.observationToken)
  return (
    <div ref={observationRef}>
      <PostCard post={post} onHidden={onHidden} showInsights={showInsights} />
    </div>
  )
}

export function PostList({
  fetchPage,
  emptyMessage = "Nothing here yet.",
  showInsights = false,
}: {
  fetchPage: (cursor: string | undefined) => Promise<PostPage>
  emptyMessage?: string
  showInsights?: boolean
}) {
  const { posts, loading, hasMore, error, loadMore, removePost } = usePaginatedPosts(fetchPage)
  const sentinelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!hasMore) return
    const sentinel = sentinelRef.current
    if (!sentinel) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore()
        }
      },
      { rootMargin: "400px" }
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, loadMore])

  const isInitialLoad = loading && posts.length === 0

  return (
    <div className="flex w-full flex-col">
      {posts.map((post) => (
        <ObservedPostCard
          key={post.id}
          post={post}
          onHidden={() => removePost(post.id)}
          showInsights={showInsights}
        />
      ))}

      {isInitialLoad && (
        <>
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </>
      )}

      {!loading && posts.length === 0 && !error && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 px-4 text-center my-6">
          <div className="flex items-center justify-center size-12 rounded-full bg-primary/10 text-primary">
            <Sparkles className="size-5 stroke-[2]" />
          </div>
          <div className="flex flex-col gap-1 max-w-sm">
            <h3 className="text-sm font-semibold text-foreground">Quiet around here</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{emptyMessage}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="flex flex-col items-center gap-3 p-4 m-4 rounded-2xl border border-destructive/20 bg-destructive/5">
          <Alert variant="destructive" className="w-full">
            {error}
          </Alert>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadMore()}
            className="rounded-full gap-1.5 cursor-pointer"
          >
            <RefreshCw className="size-3.5" />
            <span>Try Again</span>
          </Button>
        </div>
      )}

      {hasMore && <div ref={sentinelRef} className="h-1" />}

      {loading && posts.length > 0 && <PostCardSkeleton />}
    </div>
  )
}
