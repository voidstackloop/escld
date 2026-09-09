import { api } from "@/lib/api"

export type Comment = {
  id: string
  postId: string
  authorId: string
  authorUsername: string
  authorDisplayName: string
  authorAvatarUrl: string | null
  text: string
  createdAt: string
}

export async function getComments(postId: string): Promise<Comment[]> {
  const response = await api.get<Comment[]>(`/api/v1/posts/${encodeURIComponent(postId)}/comments`)
  return response.data
}

export async function createComment(postId: string, text: string): Promise<Comment> {
  const response = await api.post<Comment>(`/api/v1/posts/${encodeURIComponent(postId)}/comments`, { text })
  return response.data
}

export async function deleteComment(id: string): Promise<void> {
  await api.delete(`/api/v1/comments/${encodeURIComponent(id)}`)
}
