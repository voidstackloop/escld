import * as React from "react"
import { Link } from "react-router-dom"
import { Radio, Loader2, Copy, Check, KeyRound, ExternalLink } from "lucide-react"

import { AppLayout } from "@/components/app-layout"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { ApiError } from "@/lib/api"
import { endLiveStream, getActiveLiveStream, regenerateStreamKey, rtmpPublishUrl, startLiveStream } from "@/lib/live"
import type { Post } from "@/lib/post"

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = React.useState(false)

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Ignore clipboard write failure
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-semibold">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="rounded-full text-xs h-10 font-mono bg-muted/40 border-border/50 px-4" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleCopy()}
          className="rounded-full shrink-0 h-10 px-4 cursor-pointer shadow-none"
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

export default function Live() {
  const [streamKey, setStreamKey] = React.useState<string | null>(null)
  const [keyLoading, setKeyLoading] = React.useState(false)
  const [keyError, setKeyError] = React.useState<string | null>(null)

  const [title, setTitle] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [liveStream, setLiveStream] = React.useState<Post | null>(null)
  const [checkingActiveStream, setCheckingActiveStream] = React.useState(true)
  const [starting, setStarting] = React.useState(false)
  const [startError, setStartError] = React.useState<string | null>(null)
  const [ending, setEnding] = React.useState(false)
  const [endError, setEndError] = React.useState<string | null>(null)
  const [ended, setEnded] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    getActiveLiveStream()
      .then((post) => {
        if (!cancelled) setLiveStream(post)
      })
      .catch(() => {
        // Best-effort
      })
      .finally(() => {
        if (!cancelled) setCheckingActiveStream(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleGenerateKey() {
    setKeyLoading(true)
    setKeyError(null)
    try {
      const result = await regenerateStreamKey()
      setStreamKey(result.streamKey)
    } catch (err) {
      setKeyError(err instanceof ApiError ? err.message : "Unable to generate a stream key.")
    } finally {
      setKeyLoading(false)
    }
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || starting) return

    setStartError(null)
    setStarting(true)
    setEnded(false)
    try {
      const post = await startLiveStream({
        title: title.trim(),
        description: description.trim() || undefined,
      })
      setLiveStream(post)
    } catch (err) {
      setStartError(err instanceof ApiError ? err.message : "Unable to start your stream.")
    } finally {
      setStarting(false)
    }
  }

  async function handleEnd() {
    if (ending) return
    setEndError(null)
    setEnding(true)
    try {
      await endLiveStream()
      setLiveStream(null)
      setEnded(true)
      setTitle("")
      setDescription("")
    } catch (err) {
      setEndError(err instanceof ApiError ? err.message : "Unable to end your stream.")
    } finally {
      setEnding(false)
    }
  }

  return (
    <AppLayout headerTitle="Go Live">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        {/* Stream Setup */}
        <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
          <CardHeader className="p-5 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-primary/10 text-primary">
                <KeyRound className="size-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-bold">Streaming Setup</CardTitle>
                <CardDescription className="text-xs">
                  Server URL and stream key for OBS or another RTMP encoder
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-2 flex flex-col gap-4">
            {keyError && <Alert variant="destructive">{keyError}</Alert>}

            {streamKey ? (
              <>
                <CopyableField label="Server URL" value={rtmpPublishUrl(streamKey)} />
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Keep this key private ? anyone who has it can publish to your channel. Generating a new
                  one immediately invalidates this one.
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground leading-relaxed">
                You&apos;ll need a stream key to point your encoder at this app. Generating one is
                safe to do ahead of time ? it doesn&apos;t start a stream by itself.
              </p>
            )}

            <Button
              type="button"
              variant="outline"
              disabled={keyLoading}
              onClick={() => void handleGenerateKey()}
              className="w-full sm:w-auto rounded-full font-semibold text-xs px-5 h-9.5 cursor-pointer shadow-none"
            >
              {keyLoading && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              {streamKey ? "Regenerate Stream Key" : "Generate Stream Key"}
            </Button>
          </CardContent>
        </Card>

        {/* Go Live */}
        <Card className="rounded-3xl border-border/50 bg-card/60 backdrop-blur-sm overflow-hidden shadow-none">
          <CardHeader className="p-5 pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-xl bg-rose-500/10 text-rose-500">
                <Radio className="size-4" />
              </div>
              <div>
                <CardTitle className="text-sm font-bold">Announce Your Stream</CardTitle>
                <CardDescription className="text-xs">
                  What appears in your followers&apos; feeds ? start your encoder once this is live
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-5 pt-2 flex flex-col gap-4">
            {checkingActiveStream ? (
              <div className="flex items-center gap-2 py-8 justify-center text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span>Checking for an active stream...</span>
              </div>
            ) : (
              <>
                {ended && (
                  <Alert variant="success">Your stream has ended successfully.</Alert>
                )}

                {liveStream ? (
                  <div className="flex flex-col gap-4">
                    <Alert variant="success" className="flex items-center gap-2">
                      <Radio className="size-4" />
                      <span>You&apos;re live! Start your encoder now if you haven&apos;t already.</span>
                    </Alert>

                    {endError && <Alert variant="destructive">{endError}</Alert>}

                    <Link
                      to={`/profile/${liveStream.authorUsername}`}
                      className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline w-fit"
                    >
                      <span>View on your profile</span>
                      <ExternalLink className="size-3" />
                    </Link>

                    <Button
                      type="button"
                      variant="destructive"
                      disabled={ending}
                      onClick={() => void handleEnd()}
                      className="w-full sm:w-auto rounded-full font-bold text-xs h-9.5 px-5 cursor-pointer shadow-none"
                    >
                      {ending && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                      {ending ? "Ending..." : "End Stream"}
                    </Button>
                  </div>
                ) : (
                  <form onSubmit={(e) => void handleStart(e)} className="flex flex-col gap-4">
                    {startError && (
                      <div className="flex flex-col gap-2">
                        <Alert variant="destructive">{startError}</Alert>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={ending}
                          onClick={() => void handleEnd()}
                          className="w-fit rounded-full text-xs cursor-pointer shadow-none"
                        >
                          {ending && <Loader2 className="size-3 animate-spin mr-1.5" />}
                          End my current stream instead
                        </Button>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="title" className="text-xs font-semibold">Title</Label>
                      <Input
                        id="title"
                        required
                        maxLength={500}
                        placeholder="What are you streaming?"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="rounded-full text-xs h-10 bg-muted/40 border-border/50 px-4"
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <Label htmlFor="description" className="text-xs font-semibold">
                        Description <span className="font-normal text-muted-foreground">(optional)</span>
                      </Label>
                      <Textarea
                        id="description"
                        maxLength={2000}
                        rows={3}
                        placeholder="Tell viewers more about the stream..."
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        className="rounded-2xl text-xs resize-none bg-muted/40 border-border/50 p-3.5"
                      />
                    </div>

                    <Button
                      type="submit"
                      disabled={starting || !title.trim()}
                      className="w-full sm:w-auto rounded-full font-bold text-xs h-10 px-6 cursor-pointer shadow-sm"
                    >
                      {starting && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
                      {starting ? "Starting..." : "Go Live"}
                    </Button>
                  </form>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  )
}
