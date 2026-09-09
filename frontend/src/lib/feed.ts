import { api } from "@/lib/api"
import type { PostPage, RecommendationContext } from "@/lib/post"

type FeedPageResponse = PostPage & {
  requestId: string
  recommendations: Record<string, RecommendationContext>
}

export async function getFeed(cursor?: string, limit = 20): Promise<PostPage> {
  const response = await api.get<FeedPageResponse>("/api/v1/feed", { params: { limit, cursor } })
  const { items, nextCursor, recommendations = {} } = response.data
  return {
    nextCursor,
    items: items.map((post) => {
      const recommendation = recommendations[post.id]
      return recommendation ? { ...post, recommendation } : post
    }),
  }
}
