import { api } from "@/lib/api"

export type PostMediaType = "IMAGE" | "VIDEO" | "AUDIO" | "LIVE"
export type PostMediaStatus = "NONE" | "PROCESSING" | "READY" | "FAILED"
export type LiveStatus = "LIVE" | "ENDED"

export type RecommendationContext = {
  source: string
  reasonCode: string
  observationToken: string
}

export type Post = {
  id: string
  authorId: string
  authorUsername: string
  authorDisplayName: string
  authorAvatarUrl: string | null
  text: string | null
  // Only ever non-null for mediaType "LIVE" — a stream's description,
  // distinct from `text` (its title).
  description: string | null
  mediaType: PostMediaType | null
  mediaUrl: string | null
  mediaStatus: PostMediaStatus
  tags: string[]
  commentCount: number
  likeCount: number
  likedByViewer: boolean
  // Only ever true on posts returned from the feed (GET /api/v1/feed) — the
  // backend only fetches live trending data on that path. A post fetched via
  // getPost/getPostsByUser always reports false here, which means "not
  // computed for this response," not "confirmed not trending" (see
  // PostResponse's own doc comment on the backend).
  trending: boolean
  // Null on every non-LIVE post. LIVE for the duration of a broadcast,
  // ENDED afterward.
  liveStatus: LiveStatus | null
  liveStartedAt: string | null
  liveEndedAt: string | null
  // Null until a LIVE stream ends. A currently-live count comes from the
  // separate heartbeat endpoint instead (see lib/live.ts), not this field.
  peakViewerCount: number | null
  createdAt: string
  /** Present only when this post was served by the personalized feed. */
  recommendation?: RecommendationContext
}

export type PostPage = {
  items: Post[]
  nextCursor: string | null
}

export async function getPostsByUser(
  username: string,
  cursor?: string,
  limit = 20
): Promise<PostPage> {
  const response = await api.get<PostPage>(
    `/api/v1/users/${encodeURIComponent(username)}/posts`,
    { params: { limit, cursor } }
  )
  return response.data
}

export type CreatePostPayload = {
  text?: string
  mediaKey?: string
  mediaType?: PostMediaType
  tags?: string[]
}

export async function createPost(payload: CreatePostPayload): Promise<Post> {
  const response = await api.post<Post>("/api/v1/posts", payload)
  return response.data
}

export async function getPost(id: string): Promise<Post> {
  const response = await api.get<Post>(`/api/v1/posts/${encodeURIComponent(id)}`)
  return response.data
}

export async function deletePost(id: string): Promise<void> {
  await api.delete(`/api/v1/posts/${encodeURIComponent(id)}`)
}

export type LikeState = {
  liked: boolean
  likeCount: number
}

export async function likePost(id: string): Promise<LikeState> {
  const response = await api.post<LikeState>(`/api/v1/posts/${encodeURIComponent(id)}/like`)
  return response.data
}

export async function unlikePost(id: string): Promise<LikeState> {
  const response = await api.delete<LikeState>(`/api/v1/posts/${encodeURIComponent(id)}/like`)
  return response.data
}

/** "Not interested" — removes this post from the viewer's own feed going
 * forward (see the backend's FeedServiceImpl, which excludes hidden posts
 * from candidates entirely, not just ranks them lower). Purely private: no
 * effect on the post's counters or its visibility to anyone else. */
export async function hidePost(id: string): Promise<void> {
  await api.post(`/api/v1/posts/${encodeURIComponent(id)}/hide`)
}

export async function unhidePost(id: string): Promise<void> {
  await api.delete(`/api/v1/posts/${encodeURIComponent(id)}/hide`)
}

export type PostInsights = {
  postId: string
  likeCount: number
  commentCount: number
  trendingScore: number
  trending: boolean
  liveStatus: LiveStatus | null
  liveStartedAt: string | null
  liveEndedAt: string | null
  durationSeconds: number | null
  peakViewerCount: number | null
  currentViewerCount: number | null
}

/** Author-only performance snapshot for one post — the backend refuses this
 * for anyone but the post's own author (see PostInsightsService). */
export async function getPostInsights(id: string): Promise<PostInsights> {
  const response = await api.get<PostInsights>(`/api/v1/posts/${encodeURIComponent(id)}/insights`)
  return response.data
}
