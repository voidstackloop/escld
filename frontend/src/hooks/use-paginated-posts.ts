import * as React from "react"

import { ApiError } from "@/lib/api"
import type { Post, PostPage } from "@/lib/post"

type FetchPage = (cursor: string | undefined) => Promise<PostPage>

/**
 * Cursor-based pagination, loaded a page at a time as the caller scrolls
 * into a sentinel element. The initial page loads once per mount — to
 * switch to a different fetcher (e.g. a different profile's posts), remount
 * via a `key` prop on the consuming component rather than expecting this
 * hook to detect the change, since resetting state synchronously inside an
 * effect causes cascading renders.
 */
export function usePaginatedPosts(fetchPage: FetchPage) {
  const [posts, setPosts] = React.useState<Post[]>([])
  const [cursor, setCursor] = React.useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = React.useState(true)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  // Guards against the IntersectionObserver firing a second load while one
  // is already in flight (fast scrolling, StrictMode double-invoke, etc.)
  const loadingRef = React.useRef(false)

  React.useEffect(() => {
    let cancelled = false
    loadingRef.current = true

    fetchPage(undefined)
      .then((page) => {
        if (cancelled) return
        setPosts(page.items)
        setCursor(page.nextCursor ?? undefined)
        setHasMore(page.nextCursor !== null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof ApiError ? err.message : "Unable to load posts.")
      })
      .finally(() => {
        loadingRef.current = false
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see doc comment above
  }, [])

  const loadMore = React.useCallback(async () => {
    if (loadingRef.current || !hasMore) return
    loadingRef.current = true
    setLoading(true)

    try {
      const page = await fetchPage(cursor)
      setPosts((prev) => [...prev, ...page.items])
      setCursor(page.nextCursor ?? undefined)
      setHasMore(page.nextCursor !== null)
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load posts.")
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [fetchPage, cursor, hasMore])

  // Used when a post is hidden (see PostCard) — the server-side exclusion
  // (FeedServiceImpl) only takes effect on the *next* feed fetch, so without
  // this a just-hidden post would stay visible until the viewer reloads.
  const removePost = React.useCallback((postId: string) => {
    setPosts((prev) => prev.filter((post) => post.id !== postId))
  }, [])

  return { posts, loading, hasMore, error, loadMore, removePost }
}
