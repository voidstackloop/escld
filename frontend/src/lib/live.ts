import { api } from "@/lib/api"
import type { Post } from "@/lib/post"

export type StreamKey = {
  streamKey: string
}

export type StartLiveStreamPayload = {
  title: string
  description?: string
  tags?: string[]
}

/** Generates a fresh RTMP stream key, replacing any existing one — the old
 * key stops working immediately (see the backend's LiveController). */
export async function regenerateStreamKey(): Promise<StreamKey> {
  const response = await api.post<StreamKey>("/api/v1/live/stream-key")
  return response.data
}

/** Announces a stream with a title/description — this is what actually
 * makes it show up in followers' feeds, and what the RTMP server requires
 * to exist before it will accept a publish from an encoder (see
 * rtmp/src/store/postgres.rs). Call this *before* starting OBS/ffmpeg, not
 * after. */
export async function startLiveStream(payload: StartLiveStreamPayload): Promise<Post> {
  const response = await api.post<Post>("/api/v1/live/streams", payload)
  return response.data
}

/** Ends the caller's own active stream. No id parameter — a user can only
 * ever have one live stream at a time (see the backend's
 * posts_one_live_per_user_idx), so "my current one" is unambiguous. */
export async function endLiveStream(): Promise<Post> {
  const response = await api.post<Post>("/api/v1/live/streams/end")
  return response.data
}

/** The caller's own currently-active stream, if any — lets the Go Live page
 * (Live.tsx) show accurate state on mount instead of only discovering it via
 * a failed start attempt's "already live" error. The backend returns 204
 * (no body) rather than a null-valued 200 when nothing is live, checked
 * explicitly here rather than trusting what axios does with an empty body. */
export async function getActiveLiveStream(): Promise<Post | null> {
  const response = await api.get<Post>("/api/v1/live/streams/me")
  return response.status === 204 ? null : response.data
}

export type ViewerCount = {
  viewerCount: number
}

/** Matches the backend's STALE_AFTER window (30s = 2 heartbeats) in
 * LiveViewerPresenceServiceImpl — kept in sync manually since there's no
 * shared config between the two languages, same as every other Java/
 * TypeScript constant pair in this app. */
export const LIVE_VIEWER_HEARTBEAT_INTERVAL_MS = 15_000

/** Pinged every HEARTBEAT_INTERVAL_MS by a viewer actually watching a live
 * stream (see post-card.tsx's PostMedia) — the only signal the backend has
 * for "someone is watching," since HLS playback itself is just periodic
 * GETs against CloudFront with no persistent connection to this app.
 * Returns the resulting live viewer count so the caller doesn't need a
 * second round trip just to display it. */
export async function sendLiveViewerHeartbeat(postId: string): Promise<ViewerCount> {
  const response = await api.post<ViewerCount>(`/api/v1/live/streams/${postId}/heartbeat`)
  return response.data
}

/** The RTMP ingest host an encoder publishes to — there is no automated
 * pipeline in this app that threads RtmpServiceStack's own Elastic IP
 * output into frontend build config (no other infra output is wired to the
 * frontend this way either, see e.g. the Cognito issuer URI hardcoded
 * directly in infra/bin/infra.ts), so this is a real, manually-set build
 * var, not a live-discovered value. */
export function rtmpPublishUrl(streamKey: string): string {
  const host = import.meta.env.VITE_RTMP_HOST ?? "localhost:1935"
  return `rtmp://${host}/live/${streamKey}`
}
