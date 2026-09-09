import * as React from "react"
import { useSearchParams } from "react-router-dom"
import { Phone, Search, Send, MessageSquare, Loader2 } from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { CallPanel } from "@/components/call-panel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getCurrentUser } from "@/lib/user"
import { searchUsers, type UserSearchResult } from "@/lib/search"
import {
  listConversations,
  listMessages,
  onNewMessage,
  openDmConversation,
  sendMessage,
  type ChatMessage,
  type Conversation,
} from "@/lib/ws-sfu"
import { cn } from "@/lib/utils"

function conversationLabel(conversation: Conversation, ownUserId: string): string {
  if (conversation.type === "group") return conversation.name ?? "Group Chat"
  const otherId = conversation.participantIds.find((id) => id !== ownUserId)
  return otherId ?? "Direct Message"
}

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso))
}

export default function Messages() {
  const [searchParams] = useSearchParams()
  const startDmUsername = searchParams.get("with")

  const [ownUserId, setOwnUserId] = React.useState<string | null>(null)
  const [conversations, setConversations] = React.useState<Conversation[]>([])
  const [activeConversationId, setActiveConversationId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [draft, setDraft] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [inCall, setInCall] = React.useState(false)

  const [userQuery, setUserQuery] = React.useState("")
  const [userResults, setUserResults] = React.useState<UserSearchResult[]>([])
  const [searchingUsers, setSearchingUsers] = React.useState(false)
  const messagesEndRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    let cancelled = false
    Promise.all([getCurrentUser(), listConversations()])
      .then(([me, convos]) => {
        if (cancelled) return
        setOwnUserId(me.id)
        setConversations(convos)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!startDmUsername) return
    searchUsers(startDmUsername).then((results) => {
      const match = results.find((r) => r.username === startDmUsername)
      if (match) {
        void openDmConversation(match.id).then((conversation) => {
          setConversations((prev) => (prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]))
          setActiveConversationId(conversation.id)
        })
      }
    })
  }, [startDmUsername])

  React.useEffect(() => {
    if (!activeConversationId) return
    let cancelled = false
    listMessages(activeConversationId).then((data) => {
      if (!cancelled) setMessages(data)
    })
    return () => {
      cancelled = true
    }
  }, [activeConversationId])

  React.useEffect(() => {
    return onNewMessage(({ conversationId, message }) => {
      if (conversationId === activeConversationId) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
      }
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.id === conversationId)
        if (idx === -1) {
          void listConversations().then(setConversations)
          return prev
        }
        const updated = { ...prev[idx]!, lastMessageAt: message.createdAt, lastMessagePreview: message.body }
        const next = prev.filter((c) => c.id !== conversationId)
        return [updated, ...next]
      })
    })
  }, [activeConversationId])

  React.useEffect(() => {
    const trimmed = userQuery.trim()
    if (!trimmed) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clears stale results when the query is emptied
      setUserResults([])
      setSearchingUsers(false)
      return
    }
    setSearchingUsers(true)
    const timeout = setTimeout(() => {
      searchUsers(trimmed)
        .then(setUserResults)
        .catch(() => setUserResults([]))
        .finally(() => setSearchingUsers(false))
    }, 300)
    return () => clearTimeout(timeout)
  }, [userQuery])

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  async function handleStartDm(userId: string) {
    const conversation = await openDmConversation(userId)
    setConversations((prev) => (prev.some((c) => c.id === conversation.id) ? prev : [conversation, ...prev]))
    setActiveConversationId(conversation.id)
    setUserQuery("")
    setUserResults([])
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!activeConversationId || draft.trim() === "") return
    const body = draft
    setDraft("")
    const message = await sendMessage(activeConversationId, body)
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
  }

  const activeConversation = React.useMemo(
    () => conversations.find((c) => c.id === activeConversationId) ?? null,
    [conversations, activeConversationId]
  )

  const activeLabel = activeConversation && ownUserId ? conversationLabel(activeConversation, ownUserId) : "Direct Message"

  return (
    <AppLayout headerTitle="Messages">
      <div className="h-[calc(100vh-3.5rem)] lg:h-screen flex flex-col md:flex-row overflow-hidden bg-background">
        {/* Left Side: Conversation List */}
        <aside
          className={cn(
            "w-full md:w-80 lg:w-92 shrink-0 border-r border-border/50 flex flex-col bg-background/50",
            activeConversation ? "hidden md:flex" : "flex"
          )}
        >
          <div className="p-3.5 border-b border-border/50">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground/70" />
              <Input
                className="pl-10 pr-8 rounded-full bg-muted/40 border-border/50 text-sm h-10 shadow-none focus:bg-background"
                placeholder="Search people to message..."
                value={userQuery}
                onChange={(e) => setUserQuery(e.target.value)}
              />
              {searchingUsers && (
                <Loader2 className="absolute right-3.5 top-1/2 -translate-y-1/2 size-3.5 animate-spin text-primary" />
              )}
              {userResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-30 mt-2 overflow-hidden rounded-3xl border border-border/60 bg-popover/95 backdrop-blur-xl shadow-xl">
                  {userResults.map((result) => (
                    <button
                      key={result.id}
                      type="button"
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-muted/60 transition-colors cursor-pointer"
                      onClick={() => void handleStartDm(result.id)}
                    >
                      <img
                        src={
                          result.avatarUrl ??
                          `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(result.username)}`
                        }
                        alt=""
                        className="size-8 rounded-full ring-1 ring-border/80 object-cover"
                      />
                      <div className="flex flex-col min-w-0">
                        <span className="truncate font-semibold text-xs text-foreground">
                          {result.displayName}
                        </span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          @{result.username}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-border/20">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" />
                <span>Loading chats...</span>
              </div>
            )}

            {!loading && conversations.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-2 py-20 px-4 text-center">
                <div className="size-11 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <MessageSquare className="size-5" />
                </div>
                <p className="text-xs font-semibold text-foreground">No conversations yet</p>
                <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                  Search a username above to start messaging.
                </p>
              </div>
            )}

            {conversations.map((conversation) => {
              const label = ownUserId ? conversationLabel(conversation, ownUserId) : "..."
              const isActive = conversation.id === activeConversationId
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => setActiveConversationId(conversation.id)}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors cursor-pointer",
                    isActive
                      ? "bg-primary/10 border-l-3 border-primary"
                      : "hover:bg-muted/40"
                  )}
                >
                  <div className="size-11 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-xs text-primary shrink-0">
                    {label.slice(0, 2).toUpperCase()}
                  </div>

                  <div className="flex flex-col min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="truncate text-xs font-bold text-foreground">
                        {label}
                      </span>
                      {conversation.lastMessageAt && (
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatTime(conversation.lastMessageAt)}
                        </span>
                      )}
                    </div>
                    <span className="truncate text-xs text-muted-foreground mt-0.5">
                      {conversation.lastMessagePreview ?? "No messages yet"}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        {/* Right Side: Chat Room */}
        <section
          className={cn(
            "flex-1 flex flex-col h-full bg-background min-w-0",
            !activeConversation ? "hidden md:flex" : "flex"
          )}
        >
          {!activeConversation ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground">
              <div className="size-14 rounded-full bg-muted/60 border border-border/50 flex items-center justify-center text-muted-foreground/70">
                <MessageSquare className="size-6" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Your Messages</h3>
              <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                Select an existing conversation or search for someone to start chatting.
              </p>
            </div>
          ) : (
            <>
              {/* Chat Header */}
              <div className="flex items-center justify-between px-4 sm:px-6 py-3 border-b border-border/50 bg-card/40 backdrop-blur-md">
                <div className="flex items-center gap-3 min-w-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="md:hidden -ml-2 text-xs rounded-full"
                    onClick={() => setActiveConversationId(null)}
                  >
                    ? Back
                  </Button>
                  <div className="size-9 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold text-xs shrink-0">
                    {activeLabel.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex flex-col min-w-0">
                    <span className="truncate text-sm font-bold text-foreground">
                      {activeLabel}
                    </span>
                    <span className="text-[11px] text-emerald-500 font-medium flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      Active Chat
                    </span>
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInCall(true)}
                  aria-label="Start call"
                  className="rounded-full gap-1.5 border-border/60 hover:bg-muted cursor-pointer"
                >
                  <Phone className="size-3.5 text-primary" />
                  <span className="text-xs font-semibold">Start Call</span>
                </Button>
              </div>

              {/* Message History */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col gap-3">
                {messages.length === 0 && (
                  <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground/80 italic">
                    No messages yet in this conversation. Say hi!
                  </div>
                )}

                {messages.map((message) => {
                  const isOwn = message.senderId === ownUserId
                  return (
                    <div
                      key={message.id}
                      className={cn("flex flex-col max-w-[80%] sm:max-w-[65%]", isOwn ? "self-end items-end" : "self-start items-start")}
                    >
                      <div
                        className={cn(
                          "px-4 py-2 text-sm leading-relaxed break-words shadow-sm",
                          isOwn
                            ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-xs"
                            : "bg-muted/70 text-foreground rounded-2xl rounded-tl-xs border border-border/40"
                        )}
                      >
                        {message.body}
                      </div>
                      <span className="mt-1 text-[10px] text-muted-foreground/70 px-1">
                        {formatTime(message.createdAt)}
                      </span>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Compose Message Box */}
              <form onSubmit={handleSend} className="p-3 sm:p-4 border-t border-border/50 bg-card/30 backdrop-blur-md flex items-center gap-2">
                <Input
                  placeholder="Type a message..."
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-10.5 rounded-full bg-muted/40 border-border/50 text-sm px-4 focus-visible:ring-primary/40 shadow-none focus:bg-background"
                />
                <Button
                  type="submit"
                  size="default"
                  disabled={draft.trim() === ""}
                  className="rounded-full size-10.5 p-0 flex items-center justify-center shrink-0 shadow-sm cursor-pointer"
                  aria-label="Send message"
                >
                  <Send className="size-4" />
                </Button>
              </form>
            </>
          )}
        </section>
      </div>

      {inCall && activeConversationId && (
        <CallPanel conversationId={activeConversationId} onClose={() => setInCall(false)} />
      )}
    </AppLayout>
  )
}
