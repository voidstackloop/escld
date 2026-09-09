import * as React from "react"
import { Link } from "react-router-dom"
import { Flame, Sparkles } from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { getTrendingHashtags, getTrendingPosts } from "@/lib/analytics"
import { getPost, type Post } from "@/lib/post"

/** Best-effort widget ? the analytics service is a nice-to-have, not on the critical path, so any failure here is swallowed rather than breaking the feed page around it. */
export function TrendingWidget() {
  const [posts, setPosts] = React.useState<Post[]>([])
  const [hashtags, setHashtags] = React.useState<string[]>([])
  const [loaded, setLoaded] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const [trendingPosts, trendingHashtags] = await Promise.all([
          getTrendingPosts(3),
          getTrendingHashtags(6),
        ])
        const hydrated = await Promise.all(
          trendingPosts.map((entry) => getPost(entry.postId).catch(() => null))
        )
        if (cancelled) return
        setPosts(hydrated.filter((p): p is Post => p !== null))
        setHashtags(trendingHashtags.map((h) => h.tag))
      } catch {
        // Analytics service down/unreachable ? just show nothing.
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (!loaded || (posts.length === 0 && hashtags.length === 0)) {
    return null
  }

  return (
    <Card size="sm" className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-md shadow-sm overflow-hidden">
      <CardContent className="flex flex-col gap-3.5 p-4 sm:p-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground">
            <span className="flex items-center justify-center size-6 rounded-full bg-primary/10 text-primary">
              <Flame className="size-3.5 fill-primary/30" />
            </span>
            Trending now
          </div>
          <Sparkles className="size-3.5 text-muted-foreground/50" />
        </div>

        {hashtags.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="text-[10px] font-bold tracking-wider text-muted-foreground/80 uppercase">
              Popular Tags
            </span>
            <div className="flex flex-wrap gap-1.5">
              {hashtags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full bg-muted/60 hover:bg-primary/10 hover:text-primary px-3 py-1 text-xs font-medium text-foreground transition-colors cursor-pointer select-none"
                >
                  #{tag}
                </span>
              ))}
            </div>
          </div>
        )}

        {posts.length > 0 && (
          <div className="flex flex-col gap-2 pt-2 border-t border-border/40">
            <span className="text-[10px] font-bold tracking-wider text-muted-foreground/80 uppercase">
              Hot Conversations
            </span>
            <ul className="flex flex-col gap-1.5">
              {posts.map((post) => (
                <li
                  key={post.id}
                  className="group flex flex-col gap-0.5 rounded-2xl p-2.5 hover:bg-muted/50 transition-colors"
                >
                  <Link
                    to={`/profile/${post.authorUsername}`}
                    className="text-xs font-semibold text-foreground group-hover:text-primary transition-colors hover:underline"
                  >
                    @{post.authorUsername}
                  </Link>
                  {post.text && (
                    <p className="line-clamp-2 text-xs text-muted-foreground group-hover:text-foreground/90 transition-colors leading-snug">
                      {post.text}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
