import { fetchAuthSession } from "aws-amplify/auth"
import { io, type Socket } from "socket.io-client"

const WS_SFU_URL = import.meta.env.VITE_WS_SFU_URL ?? "http://localhost:4000"

export type ConversationType = "dm" | "group"

export type Conversation = {
  id: string
  type: ConversationType
  participantIds: string[]
  name: string | null
  createdAt: string
  lastMessageAt: string
  lastMessagePreview: string | null
}

export type ChatMessage = {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
}

type Ack<T> = T & { error?: string }

let socketPromise: Promise<Socket> | null = null

/** One shared socket per tab, connected lazily on first use and reused by every caller. */
export function getSocket(): Promise<Socket> {
  if (!socketPromise) {
    socketPromise = (async () => {
      const session = await fetchAuthSession()
      const token = session.tokens?.accessToken?.toString()
      const socket = io(WS_SFU_URL, { auth: { token }, autoConnect: true })
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve())
        socket.once("connect_error", (err) => reject(err))
      })
      return socket
    })()
    socketPromise.catch(() => {
      socketPromise = null
    })
  }
  return socketPromise
}

export function disconnectSocket(): void {
  socketPromise?.then((socket) => socket.disconnect()).catch(() => {})
  socketPromise = null
}

export async function emitWithAck<T>(event: string, payload: unknown): Promise<T> {
  const socket = await getSocket()
  return new Promise<T>((resolve, reject) => {
    socket.emit(event, payload, (response: Ack<T>) => {
      if (response?.error) reject(new Error(response.error))
      else resolve(response)
    })
  })
}

export async function listConversations(): Promise<Conversation[]> {
  const { conversations } = await emitWithAck<{ conversations: Conversation[] }>(
    "conversations:list",
    {}
  )
  return conversations
}

export async function openDmConversation(peerUserId: string): Promise<Conversation> {
  const { conversation } = await emitWithAck<{ conversation: Conversation }>(
    "conversations:openDm",
    { peerUserId }
  )
  return conversation
}

export async function createGroupConversation(
  participantIds: string[],
  name: string
): Promise<Conversation> {
  const { conversation } = await emitWithAck<{ conversation: Conversation }>(
    "conversations:createGroup",
    { participantIds, name }
  )
  return conversation
}

export async function listMessages(conversationId: string, before?: string): Promise<ChatMessage[]> {
  const { messages } = await emitWithAck<{ messages: ChatMessage[] }>("messages:list", {
    conversationId,
    before,
  })
  return messages
}

export async function sendMessage(conversationId: string, body: string): Promise<ChatMessage> {
  const { message } = await emitWithAck<{ message: ChatMessage }>("messages:send", {
    conversationId,
    body,
  })
  return message
}

/** Subscribes to incoming messages for the lifetime of the caller's effect; returns an unsubscribe function. */
export function onNewMessage(
  handler: (payload: { conversationId: string; message: ChatMessage }) => void
): () => void {
  let unsubscribed = false
  let off: (() => void) | undefined

  getSocket().then((socket) => {
    if (unsubscribed) return
    socket.on("messages:new", handler)
    off = () => socket.off("messages:new", handler)
  })

  return () => {
    unsubscribed = true
    off?.()
  }
}

export type LiveChatMessage = {
  postId: string
  userId: string
  username: string
  body: string
  sentAt: string
}

/**
 * Ephemeral, broadcast-only live-stream chat (see ws-sfu/src/ws/live.rs) —
 * deliberately not the persisted DM/group model above: no history, nothing
 * to fetch on join, just a room to send into and listen on for as long as
 * the viewer is watching.
 */
export async function joinLiveChat(postId: string): Promise<{ authorId: string }> {
  return emitWithAck<{ authorId: string }>("live:join", { postId })
}

export async function leaveLiveChat(postId: string): Promise<void> {
  const socket = await getSocket()
  socket.emit("live:leave", { postId })
}

export async function sendLiveChatMessage(postId: string, body: string): Promise<void> {
  await emitWithAck<Record<string, never>>("live:chat:send", { postId, body })
}

/** Subscribes to live chat for one post; returns an unsubscribe function. */
export function onLiveChatMessage(handler: (message: LiveChatMessage) => void): () => void {
  let unsubscribed = false
  let off: (() => void) | undefined

  getSocket().then((socket) => {
    if (unsubscribed) return
    socket.on("live:chat:new", handler)
    off = () => socket.off("live:chat:new", handler)
  })

  return () => {
    unsubscribed = true
    off?.()
  }
}

export type LiveFeedUpdate = {
  postId: string
  authorId: string
  authorUsername?: string
  title?: string
}

/**
 * A real-time "someone went live" / "a stream ended" nudge, pushed via
 * Kafka -> ws-sfu (see ws-sfu/src/kafka/mod.rs) rather than discovered only
 * on the next feed fetch. This is deliberately just a signal to refetch —
 * the backend's own feed ranking/eligibility remains the source of truth
 * for what's actually shown, so a handler here should trigger a lightweight
 * feed refresh or a "new live stream" indicator, not render this payload as
 * if it were a full post.
 */
export function onLiveFeedUpdate(
  handler: (event: "started" | "ended", payload: LiveFeedUpdate) => void
): () => void {
  let unsubscribed = false
  let offStarted: (() => void) | undefined
  let offEnded: (() => void) | undefined

  getSocket().then((socket) => {
    if (unsubscribed) return
    const onStarted = (payload: LiveFeedUpdate) => handler("started", payload)
    const onEnded = (payload: LiveFeedUpdate) => handler("ended", payload)
    socket.on("feed:liveStarted", onStarted)
    socket.on("feed:liveEnded", onEnded)
    offStarted = () => socket.off("feed:liveStarted", onStarted)
    offEnded = () => socket.off("feed:liveEnded", onEnded)
  })

  return () => {
    unsubscribed = true
    offStarted?.()
    offEnded?.()
  }
}
