const ANALYTICS_BASE_URL = import.meta.env.VITE_ANALYTICS_URL ?? "http://localhost:4100"

export type TrendingPost = { postId: string; score: number }
export type TrendingHashtag = { tag: string; score: number }

export async function getTrendingPosts(limit = 5): Promise<TrendingPost[]> {
  const response = await fetch(`${ANALYTICS_BASE_URL}/api/v1/analytics/trending/posts?limit=${limit}`)
  if (!response.ok) throw new Error(`Trending posts request failed: ${response.status}`)
  const data = (await response.json()) as { posts: TrendingPost[] }
  return data.posts
}

export async function getTrendingHashtags(limit = 8): Promise<TrendingHashtag[]> {
  const response = await fetch(`${ANALYTICS_BASE_URL}/api/v1/analytics/trending/hashtags?limit=${limit}`)
  if (!response.ok) throw new Error(`Trending hashtags request failed: ${response.status}`)
  const data = (await response.json()) as { hashtags: TrendingHashtag[] }
  return data.hashtags
}
