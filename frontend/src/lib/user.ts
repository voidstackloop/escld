import { api } from "@/lib/api"

export type UserStatus = "ACTIVE" | "SUSPENDED" | "DEACTIVATED"

export type UserProfile = {
  id: string
  username: string
  email: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  coverImageUrl: string | null
  location: string | null
  websiteUrl: string | null
  birthdate: string | null
  verified: boolean
  privateAccount: boolean
  status: UserStatus
  followersCount: number
  followingCount: number
  postsCount: number
  createdAt: string
  updatedAt: string
}

export type PublicUserProfile = {
  id: string
  username: string
  displayName: string
  bio: string | null
  avatarUrl: string | null
  coverImageUrl: string | null
  location: string | null
  websiteUrl: string | null
  verified: boolean
  privateAccount: boolean
  followersCount: number
  followingCount: number
  postsCount: number
  createdAt: string
}

export type UpdateProfilePayload = {
  username?: string
  displayName?: string
  bio?: string
  avatarUrl?: string
  coverImageUrl?: string
  location?: string
  websiteUrl?: string
  birthdate?: string
  privateAccount?: boolean
}

export async function getCurrentUser() {
  const response = await api.get<UserProfile>("/api/v1/users/me")
  return response.data
}

export async function getPublicUser(username: string) {
  const response = await api.get<PublicUserProfile>(
    `/api/v1/users/${encodeURIComponent(username)}`
  )
  return response.data
}

export async function updateCurrentUser(payload: UpdateProfilePayload) {
  const response = await api.patch<UserProfile>("/api/v1/users/me", payload)
  return response.data
}

// Permanent — see backend AccountDeletionService: soft-deletes posts/comments,
// anonymizes the profile, and unwinds follows/likes/feed. Not reversible from
// the UI; callers should sign the user out immediately after this resolves.
export async function deleteCurrentUser() {
  await api.delete("/api/v1/users/me")
}

export type InsightsDataStatus = "COMPLETE" | "PROVISIONAL" | "UNAVAILABLE"

// Mirrors backend's InsightsHistoryResponse.DailyPoint exactly. distinctPosts
// and newFollowerCount are only ever populated on this (account-level) series
// — the per-post history endpoint always reports them null, since neither
// concept applies to a single post. Every numeric field is nullable: a day
// with dataStatus "UNAVAILABLE" (still within the backend's maturity window)
// reports every metric as null rather than a misleading zero.
export type DailyInsightsPoint = {
  day: string
  qualifiedReach: number | null
  qualifiedImpressions: number | null
  meaningfulCount: number | null
  hideCount: number | null
  watchTimeSeconds: number | null
  likeCount: number | null
  commentCount: number | null
  distinctPosts: number | null
  newFollowerCount: number | null
  dataStatus: InsightsDataStatus
}

export type InsightsHistoryResponse = {
  from: string
  to: string
  granularity: string
  points: DailyInsightsPoint[]
  dataStatus: "COMPLETE" | "PROVISIONAL"
  asOf: string
}

/** Account-wide daily metrics for Creator Studio. `from`/`to` are ISO dates
 * (YYYY-MM-DD); both optional — the backend defaults to the trailing 7 days
 * and caps the window at 90 days. Throws ApiError with status 503
 * (InsightsUnavailableException) when nothing has landed in the warehouse
 * for this range yet — callers should treat that as an empty-state, not a
 * generic error. */
export async function getCreatorInsights(from?: string, to?: string) {
  const response = await api.get<InsightsHistoryResponse>("/api/v1/users/me/insights", {
    params: { from, to },
  })
  return response.data
}
