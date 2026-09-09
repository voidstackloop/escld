import { api } from "@/lib/api"

export type ReportTargetType = "POST" | "COMMENT" | "USER"

export type Report = {
  id: string
  targetType: ReportTargetType
  targetId: string
  reporterId: string
  reason: string
  status: string
  createdAt: string
}

export async function fileReport(targetType: ReportTargetType, targetId: string, reason: string) {
  const response = await api.post<Report>("/api/v1/moderation/reports", { targetType, targetId, reason })
  return response.data
}

export async function getOpenReports() {
  const response = await api.get<Report[]>("/api/v1/moderation/reports")
  return response.data
}

export async function resolveReport(reportId: string, note?: string) {
  await api.post(`/api/v1/moderation/reports/${encodeURIComponent(reportId)}/resolve`, { note })
}

export async function suspendUser(username: string) {
  await api.post(`/api/v1/moderation/users/${encodeURIComponent(username)}/suspend`)
}

export async function reinstateUser(username: string) {
  await api.post(`/api/v1/moderation/users/${encodeURIComponent(username)}/reinstate`)
}

export async function removePost(postId: string) {
  await api.post(`/api/v1/moderation/posts/${encodeURIComponent(postId)}/remove`)
}

export async function removeComment(commentId: string) {
  await api.post(`/api/v1/moderation/comments/${encodeURIComponent(commentId)}/remove`)
}
