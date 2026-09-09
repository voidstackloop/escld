import * as React from "react"
import { ImagePlus, Loader2, X, Hash } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useAuth } from "@/lib/auth-context"
import { ApiError } from "@/lib/api"
import { uploadPostMedia } from "@/lib/media"
import { createPost, type Post } from "@/lib/post"
import { getCurrentUser, type UserProfile } from "@/lib/user"

const MAX_TEXT_LENGTH = 500

function parseTags(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean)
    .slice(0, 10)
}

export function CreatePostForm({ onCreated }: { onCreated: (post: Post) => void }) {
  const { user } = useAuth()
  const [profile, setProfile] = React.useState<UserProfile | null>(null)
  const [text, setText] = React.useState("")
  const [tagsInput, setTagsInput] = React.useState("")
  const [showTags, setShowTags] = React.useState(false)
  const [image, setImage] = React.useState<File | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    let cancelled = false
    getCurrentUser()
      .then((data) => {
        if (!cancelled) setProfile(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const currentUsername = profile?.username ?? user?.username ?? ""
  const avatarUrl =
    profile?.avatarUrl ??
    (currentUsername
      ? `https://api.dicebear.com/9.x/identicon/svg?seed=${encodeURIComponent(currentUsername)}`
      : "")

  const imagePreviewUrl = React.useMemo(
    () => (image ? URL.createObjectURL(image) : null),
    [image]
  )

  React.useEffect(() => {
    return () => {
      if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl)
    }
  }, [imagePreviewUrl])

  const trimmedText = text.trim()
  const canSubmit =
    (trimmedText.length > 0 || image !== null) &&
    text.length <= MAX_TEXT_LENGTH &&
    !submitting

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    setImage(file ?? null)
    event.target.value = ""
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit) return

    setSubmitting(true)
    setError(null)
    try {
      const mediaKey = image ? await uploadPostMedia(image) : undefined
      const post = await createPost({
        text: trimmedText || undefined,
        mediaKey,
        mediaType: mediaKey ? "IMAGE" : undefined,
        tags: parseTags(tagsInput),
      })

      onCreated(post)
      setText("")
      setTagsInput("")
      setShowTags(false)
      setImage(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to create post.")
    } finally {
      setSubmitting(false)
    }
  }

  const isOverLimit = text.length > MAX_TEXT_LENGTH
  const charPercentage = Math.min(100, (text.length / MAX_TEXT_LENGTH) * 100)

  return (
    <div className="w-full bg-card/30 p-4 sm:p-5 transition-colors">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex gap-3.5 items-start">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt=""
              className="size-10 rounded-full ring-1 ring-border/80 object-cover shrink-0 mt-0.5"
            />
          ) : (
            <div className="size-10 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold text-sm shrink-0 mt-0.5">
              {currentUsername.slice(0, 2).toUpperCase()}
            </div>
          )}

          <div className="flex-1 min-w-0">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What's happening?"
              rows={3}
              maxLength={MAX_TEXT_LENGTH + 50}
              aria-invalid={isOverLimit}
              className="w-full resize-none border-0 bg-transparent p-0 text-[15px] placeholder:text-muted-foreground/60 focus-visible:ring-0 focus-visible:border-0 shadow-none leading-relaxed"
            />
          </div>
        </div>

        {imagePreviewUrl && (
          <div className="relative pl-13">
            <div className="relative overflow-hidden rounded-2xl border border-border/80 w-fit max-w-full">
              <img
                src={imagePreviewUrl}
                alt="Upload preview"
                className="max-h-64 max-w-full rounded-2xl object-cover"
              />
              <button
                type="button"
                onClick={() => setImage(null)}
                aria-label="Remove image"
                className="absolute top-2.5 right-2.5 rounded-full bg-black/60 hover:bg-black/80 text-white p-1.5 transition-colors backdrop-blur-md cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>
        )}

        {(showTags || tagsInput.length > 0) && (
          <div className="pl-13 flex items-center gap-2">
            <div className="relative flex-1">
              <Hash className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="Tags (comma or space separated, e.g. tech, design)"
                className="h-8 w-full min-w-0 rounded-full border border-input bg-muted/40 pl-8 pr-3 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                setTagsInput("")
                setShowTags(false)
              }}
              className="text-muted-foreground rounded-full"
            >
              Cancel
            </Button>
          </div>
        )}

        {error && <p className="text-xs text-destructive font-medium pl-13">{error}</p>}

        <div className="flex items-center justify-between pt-2.5 border-t border-border/40 pl-13">
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={submitting}
              className="rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer h-8 px-2.5"
              title="Add photo"
            >
              <ImagePlus className="size-4.5" />
              <span className="hidden sm:inline text-xs ml-1 font-medium">Photo</span>
            </Button>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowTags((prev) => !prev)}
              disabled={submitting}
              className="rounded-full text-muted-foreground hover:text-primary hover:bg-primary/10 cursor-pointer h-8 px-2.5"
              title="Add hashtags"
            >
              <Hash className="size-4.5" />
              <span className="hidden sm:inline text-xs ml-1 font-medium">Tag</span>
            </Button>
          </div>

          <div className="flex items-center gap-3">
            {text.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <div
                  className="size-4.5 rounded-full border border-muted flex items-center justify-center text-[0.6rem]"
                  style={{
                    background: `conic-gradient(var(--primary) ${charPercentage}%, transparent ${charPercentage}%)`,
                  }}
                >
                  <div className="size-3.5 rounded-full bg-card" />
                </div>
                <span
                  className={
                    isOverLimit ? "font-semibold text-destructive text-[11px]" : "text-muted-foreground text-[11px]"
                  }
                >
                  {text.length}/{MAX_TEXT_LENGTH}
                </span>
              </div>
            )}

            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="rounded-full px-5 py-1.5 font-bold text-xs shadow-sm hover:shadow transition-all cursor-pointer h-8.5"
            >
              {submitting && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              Post
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}
