import { api } from "@/lib/api"

export type UserSearchResult = {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
  verified: boolean
  followersCount: number
}

export async function searchUsers(query: string) {
  const response = await api.get<UserSearchResult[]>("/api/v1/search/users", {
    params: { q: query },
  })
  return response.data
}
