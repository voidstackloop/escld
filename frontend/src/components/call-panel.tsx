import * as React from "react"
import {
  Circle,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneCall,
  PhoneOff,
  Users,
  Video,
  VideoOff,
  X,
} from "lucide-react"

import { CallChat } from "@/components/call-chat"
import { useCall, type RemoteParticipant } from "@/hooks/use-call"
import { Alert } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { useAuth } from "@/lib/auth-context"

function VideoTile({
  label,
  videoTrack,
  audioTrack,
  muted,
  isScreen,
  audioMuted,
  videoMuted,
  handRaised,
}: {
  label: string
  videoTrack: MediaStreamTrack | null
  audioTrack?: MediaStreamTrack | null
  muted?: boolean
  isScreen?: boolean
  audioMuted?: boolean
  videoMuted?: boolean
  handRaised?: boolean
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null)
  const showVideo = videoTrack && !videoMuted

  React.useEffect(() => {
    const tracks = [videoTrack, audioTrack].filter((t): t is MediaStreamTrack => Boolean(t))
    const el = videoRef.current
    if (!el) return
    if (tracks.length === 0) {
      el.srcObject = null
      return
    }
    el.srcObject = new MediaStream(tracks)
  }, [videoTrack, audioTrack])

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-3xl bg-zinc-900 border border-zinc-800/80 shadow-2xl flex items-center justify-center group">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
        className={`h-full w-full object-cover ${showVideo ? "" : "hidden"}`}
      />
      {!showVideo && (
        <div className="flex flex-col items-center gap-3">
          <div className="size-16 rounded-full bg-primary/20 text-primary border border-primary/30 flex items-center justify-center text-xl font-bold uppercase shadow-inner">
            {label.slice(0, 2)}
          </div>
          <span className="text-xs font-semibold text-zinc-400">{label}</span>
        </div>
      )}

      {handRaised && (
        <div className="absolute top-3.5 right-3.5 flex items-center justify-center size-8 rounded-full bg-amber-400 text-zinc-900 shadow-lg animate-bounce">
          <Hand className="size-4" />
        </div>
      )}

      {/* Label Badge */}
      <div className="absolute bottom-3.5 left-3.5 flex items-center gap-2 rounded-full bg-black/70 backdrop-blur-md px-3 py-1 text-xs font-medium text-white border border-white/10">
        {isScreen && <MonitorUp className="size-3.5 text-cyan-400" />}
        <span>{label}</span>
        {audioMuted && <MicOff className="size-3.5 text-rose-400" aria-label="Microphone muted" />}
      </div>
    </div>
  )
}

function ParticipantTiles({ participant }: { participant: RemoteParticipant }) {
  const label = participant.username || participant.userId
  return (
    <>
      <VideoTile
        label={label}
        videoTrack={participant.videoTrack}
        audioTrack={participant.audioTrack}
        audioMuted={participant.audioMuted}
        videoMuted={participant.videoMuted}
        handRaised={participant.handRaised}
      />
      {participant.screenTrack && (
        <VideoTile label={`${label} (Screen)`} videoTrack={participant.screenTrack} isScreen />
      )}
    </>
  )
}

export function CallPanel({
  conversationId,
  onClose,
}: {
  conversationId: string
  onClose: () => void
}) {
  const call = useCall(conversationId)
  const { micEnabled, cameraEnabled, handRaised, isRecording, recordingStartedBy } = call
  const { roles } = useAuth()
  const canRecord = roles.includes("admin") || roles.includes("moderator")
  const [showChat, setShowChat] = React.useState(false)

  function handleLeave() {
    void call.leave()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950/95 backdrop-blur-2xl text-white p-4 sm:p-6 animate-in fade-in duration-200">
      {/* Top Bar */}
      <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center size-9 rounded-2xl bg-primary/20 text-primary border border-primary/30">
            <PhoneCall className="size-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white tracking-tight">Audio & Video Call</h2>
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              <span className="flex items-center gap-1.5 font-medium">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                Live WebRTC SFU
              </span>
              <span>?</span>
              <span className="flex items-center gap-1">
                <Users className="size-3" />
                {call.participants.length + (call.joined ? 1 : 0)} in call
              </span>
              {isRecording && (
                <>
                  <span>?</span>
                  <span className="flex items-center gap-1 text-rose-400 font-semibold" title={recordingStartedBy ? `Started by ${recordingStartedBy}` : undefined}>
                    <Circle className="size-2 fill-rose-500 text-rose-500 animate-pulse" />
                    REC
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {call.joined && (
            <button
              onClick={() => setShowChat((prev) => !prev)}
              className={`rounded-full p-2.5 transition-colors cursor-pointer ${showChat ? "text-primary bg-primary/20" : "text-zinc-400 hover:text-white hover:bg-zinc-800/80"}`}
              aria-label="Toggle in-call chat"
            >
              <MessageSquare className="size-4.5" />
            </button>
          )}
          <button
            onClick={handleLeave}
            className="rounded-full p-2.5 text-zinc-400 hover:text-white hover:bg-zinc-800/80 transition-colors cursor-pointer"
            aria-label="Close call panel"
          >
            <X className="size-5" />
          </button>
        </div>
      </div>

      {call.error && (
        <div className="my-3">
          <Alert variant="destructive">{call.error}</Alert>
        </div>
      )}

      {/* Main Call View */}
      {!call.joined ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          <div className="size-20 rounded-full bg-primary/10 border border-primary/30 flex items-center justify-center text-primary shadow-lg">
            <PhoneCall className="size-9 animate-bounce" />
          </div>
          <div className="flex flex-col gap-1.5 max-w-sm">
            <h3 className="text-lg font-bold text-white">Join Call Room</h3>
            <p className="text-xs text-zinc-400 leading-relaxed">
              Connect via high-definition audio and video with participants in this conversation.
            </p>
          </div>
          <div className="flex gap-3">
            <Button
              onClick={() => void call.join()}
              className="rounded-full px-6 py-5 text-sm font-semibold shadow-md cursor-pointer"
            >
              Join Call Now
            </Button>
            <Button
              variant="outline"
              onClick={onClose}
              className="rounded-full px-5 py-5 text-sm border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 cursor-pointer"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 my-4 flex gap-4 overflow-hidden">
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto p-1 auto-rows-min">
            <VideoTile
              label="You"
              videoTrack={call.localStream?.getVideoTracks()[0] ?? null}
              muted
              videoMuted={!cameraEnabled}
              audioMuted={!micEnabled}
              handRaised={handRaised}
            />
            {call.screenStream && (
              <VideoTile
                label="Your Screen"
                videoTrack={call.screenStream.getVideoTracks()[0] ?? null}
                muted
                isScreen
              />
            )}
            {call.participants.map((participant) => (
              <ParticipantTiles key={participant.socketId} participant={participant} />
            ))}
          </div>
          {showChat && (
            <div className="hidden sm:block w-80 shrink-0">
              <CallChat conversationId={conversationId} onClose={() => setShowChat(false)} />
            </div>
          )}
        </div>
      )}

      {/* Floating Call Action Dock */}
      {call.joined && (
        <div className="flex items-center justify-center gap-3 pt-2">
          <div className="flex items-center gap-2.5 rounded-full bg-zinc-900/90 border border-zinc-800 p-2 shadow-2xl backdrop-blur-xl">
            <Button
              variant={micEnabled ? "outline" : "destructive"}
              size="icon-lg"
              onClick={() => void call.toggleMic()}
              aria-label="Toggle microphone"
              className="rounded-full border-zinc-700 hover:bg-zinc-800 cursor-pointer"
            >
              {micEnabled ? <Mic className="size-5" /> : <MicOff className="size-5" />}
            </Button>

            <Button
              variant={cameraEnabled ? "outline" : "destructive"}
              size="icon-lg"
              onClick={() => void call.toggleCamera()}
              aria-label="Toggle camera"
              className="rounded-full border-zinc-700 hover:bg-zinc-800 cursor-pointer"
            >
              {cameraEnabled ? <Video className="size-5" /> : <VideoOff className="size-5" />}
            </Button>

            <Button
              variant={call.screenStream ? "default" : "outline"}
              size="icon-lg"
              onClick={() => (call.screenStream ? call.stopScreenShare() : void call.startScreenShare())}
              aria-label="Toggle screen share"
              className="rounded-full border-zinc-700 hover:bg-zinc-800 cursor-pointer"
            >
              <MonitorUp className="size-5" />
            </Button>

            <Button
              variant={handRaised ? "default" : "outline"}
              size="icon-lg"
              onClick={() => void call.toggleRaiseHand()}
              aria-label="Raise or lower hand"
              className={`rounded-full border-zinc-700 hover:bg-zinc-800 cursor-pointer ${handRaised ? "bg-amber-400 text-zinc-900 hover:bg-amber-500" : ""}`}
            >
              <Hand className="size-5" />
            </Button>

            {canRecord && (
              <Button
                variant={isRecording ? "destructive" : "outline"}
                size="icon-lg"
                onClick={() => void (isRecording ? call.stopRecording() : call.startRecording())}
                aria-label={isRecording ? "Stop recording" : "Start recording"}
                title={isRecording ? "Stop recording" : "Start recording (visible to all participants, not accessible to them)"}
                className="rounded-full border-zinc-700 hover:bg-zinc-800 cursor-pointer"
              >
                <Circle className={`size-5 ${isRecording ? "fill-current" : ""}`} />
              </Button>
            )}

            <Button
              variant="destructive"
              size="icon-lg"
              onClick={handleLeave}
              aria-label="Leave call"
              className="rounded-full px-5 bg-rose-600 hover:bg-rose-700 text-white shadow-lg cursor-pointer"
            >
              <PhoneOff className="size-5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
