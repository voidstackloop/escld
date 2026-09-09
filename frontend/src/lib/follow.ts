import { api } from "@/lib/api"

export type FollowState = "NOT_FOLLOWING" | "PENDING" | "FOLLOWING"

export async function followUser(username: string) {
  const response = await api.post<{ state: FollowState }>(
    `/api/v1/users/${encodeURIComponent(username)}/follow`
  )
  return response.data.state
}

export async function unfollowUser(username: string) {
  await api.delete(`/api/v1/users/${encodeURIComponent(username)}/follow`)
}

export async function getFollowStatus(username: string) {
  const response = await api.get<{ state: FollowState }>(
    `/api/v1/users/${encodeURIComponent(username)}/follow-status`
  )
  return response.data.state
}

export type PendingFollowRequest = {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  verified: boolean
}

export async function getPendingFollowRequests() {
  const response = await api.get<PendingFollowRequest[]>("/api/v1/follow-requests")
  return response.data
}

export async function acceptFollowRequest(username: string) {
  await api.post(`/api/v1/follow-requests/${encodeURIComponent(username)}/accept`)
}

export async function rejectFollowRequest(username: string) {
  await api.post(`/api/v1/follow-requests/${encodeURIComponent(username)}/reject`)
}
