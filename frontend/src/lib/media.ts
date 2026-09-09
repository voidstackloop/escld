import axios from "axios"

import { api } from "@/lib/api"

export type UploadPurpose = "AVATAR" | "COVER" | "POST"

export type PresignedUpload = {
  uploadUrl: string
  objectKey: string
  publicUrl: string
  expiresAt: string
}

async function requestPresignedUpload(file: File, purpose: UploadPurpose) {
  const response = await api.post<PresignedUpload>("/api/v1/media/presigned-upload", {
    fileName: file.name,
    contentType: file.type,
    purpose,
  })
  return response.data
}

/**
 * Uploads a file directly to S3 via a backend-issued presigned URL and
 * returns the public (CloudFront) URL it will be reachable at. Uses a bare
 * axios call (not the `api` instance) since the presigned URL is already
 * self-authenticating — it must not carry our own bearer token.
 */
export async function uploadMedia(file: File, purpose: UploadPurpose) {
  const presigned = await requestPresignedUpload(file, purpose)

  await axios.put(presigned.uploadUrl, file, {
    headers: { "Content-Type": file.type },
  })

  return presigned.publicUrl
}

/**
 * Same upload flow as uploadMedia, but returns the S3 object key rather than
 * the public URL — creating a post needs `mediaKey` (see lib/post.ts), the
 * backend derives the servable URL itself once the post exists.
 */
export async function uploadPostMedia(file: File): Promise<string> {
  const presigned = await requestPresignedUpload(file, "POST")

  await axios.put(presigned.uploadUrl, file, {
    headers: { "Content-Type": file.type },
  })

  return presigned.objectKey
}
