import * as React from "react"
import { Send, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getCurrentUser } from "@/lib/user"
import { listMessages, onNewMessage, sendMessage, type ChatMessage } from "@/lib/ws-sfu"
import { cn } from "@/lib/utils"

function formatTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso))
}

/**
 * In-call chat - deliberately the *same* conversation thread shown on the
 * Messages page (see lib/ws-sfu's messages:* events), not a separate
 * ephemeral call-only channel. A call always belongs to one conversation,
 * so there's nothing a parallel chat store would add beyond duplication.
 */
export function CallChat({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [ownUserId, setOwnUserId] = React.useState<string | null>(null)
  const [messages, setMessages] = React.useState<ChatMessage[]>([])
  const [draft, setDraft] = React.useState("")
  const endRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    getCurrentUser().then((me) => setOwnUserId(me.id))
  }, [])

  React.useEffect(() => {
    let cancelled = false
    listMessages(conversationId).then((data) => {
      if (!cancelled) setMessages(data)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  React.useEffect(() => {
    return onNewMessage(({ conversationId: incomingId, message }) => {
      if (incomingId !== conversationId) return
      setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
    })
  }, [conversationId])

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (draft.trim() === "") return
    const body = draft
    setDraft("")
    const message = await sendMessage(conversationId, body)
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
  }

  return (
    <div className="flex h-full w-full flex-col rounded-2xl border border-zinc-800 bg-zinc-900/90 backdrop-blur-xl shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-800">
        <span className="text-xs font-bold text-white">In-call chat</span>
        <button
          onClick={onClose}
          className="rounded-lg p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          aria-label="Close chat"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
        {messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-[0.7rem] text-zinc-500 italic">
            No messages yet. Say hi!
          </div>
        )}
        {messages.map((message) => {
          const isOwn = message.senderId === ownUserId
          return (
            <div
              key={message.id}
              className={cn("flex flex-col max-w-[85%]", isOwn ? "self-end items-end" : "self-start items-start")}
            >
              <div
                className={cn(
                  "px-3 py-1.5 text-xs leading-relaxed break-words shadow-sm",
                  isOwn
                    ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-xs"
                    : "bg-zinc-800 text-zinc-100 rounded-2xl rounded-tl-xs"
                )}
              >
                {message.body}
              </div>
              <span className="mt-0.5 text-[0.6rem] text-zinc-500 px-1">{formatTime(message.createdAt)}</span>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      <form onSubmit={handleSend} className="flex items-center gap-2 p-2.5 border-t border-zinc-800">
        <Input
          placeholder="Message the call..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-9 rounded-xl bg-zinc-800/60 border-zinc-700 text-xs px-3 text-white placeholder:text-zinc-500 focus-visible:ring-primary/40"
        />
        <Button
          type="submit"
          size="icon"
          disabled={draft.trim() === ""}
          className="rounded-xl size-9 shrink-0 cursor-pointer"
          aria-label="Send message"
        >
          <Send className="size-3.5" />
        </Button>
      </form>
    </div>
  )
}
