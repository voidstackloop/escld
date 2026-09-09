import * as React from "react"
import { Device } from "mediasoup-client"
import type {
  Consumer,
  DtlsParameters,
  MediaKind,
  Producer,
  RtpCapabilities,
  RtpEncodingParameters,
  RtpParameters,
  Transport,
} from "mediasoup-client/types"

import { emitWithAck, getSocket } from "@/lib/ws-sfu"

export type RemoteParticipant = {
  socketId: string
  userId: string
  username: string
  audioTrack: MediaStreamTrack | null
  videoTrack: MediaStreamTrack | null
  screenTrack: MediaStreamTrack | null
  audioMuted: boolean
  videoMuted: boolean
  handRaised: boolean
}

type TransportInfo = {
  id: string
  iceParameters: unknown
  iceCandidates: unknown
  dtlsParameters: DtlsParameters
}

type ProducerAppData = { source: "mic" | "camera" | "screen" }

/**
 * Three-layer VP8 simulcast (rid/maxBitrate per the mediasoup reference
 * recipe) so the SFU can drop a struggling receiver to a lower layer
 * instead of the sender having to guess a single bitrate for everyone.
 * Camera video only, not mic or screen share: audio has no spatial layers
 * to simulcast, and screen content is mostly static/text where the extra
 * encode cost buys little - both stay single-layer.
 */
const CAMERA_SIMULCAST_ENCODINGS: RtpEncodingParameters[] = [
  { rid: "r0", maxBitrate: 100_000, scalabilityMode: "S1T3" },
  { rid: "r1", maxBitrate: 300_000, scalabilityMode: "S1T3" },
  { rid: "r2", maxBitrate: 900_000, scalabilityMode: "S1T3" },
]

/** Joins/manages one mediasoup call room for a conversation: mic+camera by default, optional screen share, and every other participant's audio/video/screen tracks. */
export function useCall(conversationId: string | null) {
  const [joined, setJoined] = React.useState(false)
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null)
  const [screenStream, setScreenStream] = React.useState<MediaStream | null>(null)
  const [participants, setParticipants] = React.useState<Map<string, RemoteParticipant>>(new Map())
  const [error, setError] = React.useState<string | null>(null)

  const [micEnabled, setMicEnabled] = React.useState(true)
  const [cameraEnabled, setCameraEnabled] = React.useState(true)
  const [handRaised, setHandRaised] = React.useState(false)
  const [isRecording, setIsRecording] = React.useState(false)
  const [recordingStartedBy, setRecordingStartedBy] = React.useState<string | null>(null)

  const deviceRef = React.useRef<Device | null>(null)
  const sendTransportRef = React.useRef<Transport | null>(null)
  const recvTransportRef = React.useRef<Transport | null>(null)
  const producersRef = React.useRef<Map<string, Producer>>(new Map())
  // Looked up by source (not producer id) so toggleMic/toggleCamera know
  // which producer to pause/resume without the caller having to track ids.
  const sourceProducersRef = React.useRef<Map<ProducerAppData["source"], Producer>>(new Map())
  const consumersRef = React.useRef<Map<string, Consumer>>(new Map())

  function updateParticipant(socketId: string, patch: Partial<RemoteParticipant>) {
    setParticipants((prev) => {
      const next = new Map(prev)
      const existing = next.get(socketId) ?? {
        socketId,
        userId: patch.userId ?? "",
        username: patch.username ?? "",
        audioTrack: null,
        videoTrack: null,
        screenTrack: null,
        audioMuted: false,
        videoMuted: false,
        handRaised: false,
      }
      next.set(socketId, { ...existing, ...patch })
      return next
    })
  }

  const consumeProducer = React.useCallback(
    async (info: {
      socketId: string
      userId: string
      username: string
      producerId: string
      kind: string
      appData: Record<string, unknown>
      paused: boolean
    }) => {
      const device = deviceRef.current
      const recvTransport = recvTransportRef.current
      if (!device || !recvTransport || !conversationId) return

      const { consumer } = await emitWithAck<{
        consumer: {
          id: string
          producerId: string
          kind: MediaKind
          rtpParameters: RtpParameters
          appData: Record<string, unknown>
        }
      }>("call:consume", {
        conversationId,
        transportId: recvTransport.id,
        producerId: info.producerId,
        rtpCapabilities: device.rtpCapabilities,
      })

      const clientConsumer = await recvTransport.consume({
        id: consumer.id,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
      })
      consumersRef.current.set(clientConsumer.id, clientConsumer)

      await emitWithAck("call:resumeConsumer", { conversationId, consumerId: clientConsumer.id })

      const source = (consumer.appData as Partial<ProducerAppData>).source ?? "camera"
      const base = { userId: info.userId, username: info.username }
      if (clientConsumer.kind === "audio") {
        updateParticipant(info.socketId, { ...base, audioTrack: clientConsumer.track, audioMuted: info.paused })
      } else if (source === "screen") {
        updateParticipant(info.socketId, { ...base, screenTrack: clientConsumer.track })
      } else {
        updateParticipant(info.socketId, { ...base, videoTrack: clientConsumer.track, videoMuted: info.paused })
      }
    },
    [conversationId]
  )

  const produceTrack = React.useCallback(
    async (track: MediaStreamTrack, appData: ProducerAppData) => {
      const sendTransport = sendTransportRef.current
      if (!sendTransport) throw new Error("Not joined yet")
      const encodings = appData.source === "camera" ? CAMERA_SIMULCAST_ENCODINGS : undefined
      const producer = await sendTransport.produce({ track, encodings, appData })
      producersRef.current.set(producer.id, producer)
      sourceProducersRef.current.set(appData.source, producer)
      return producer
    },
    []
  )

  /** Pauses/resumes the given source's producer both locally (stops sending) and on the server (so remote participants' consumers see it via mediasoup's own producerpause/producerresume). */
  const setProducerPaused = React.useCallback(
    async (source: ProducerAppData["source"], paused: boolean) => {
      if (!conversationId) return
      const producer = sourceProducersRef.current.get(source)
      if (!producer) return

      if (paused) producer.pause()
      else producer.resume()

      await emitWithAck(paused ? "call:pauseProducer" : "call:resumeProducer", {
        conversationId,
        producerId: producer.id,
      })
    },
    [conversationId]
  )

  const toggleMic = React.useCallback(async () => {
    const next = !micEnabled
    await setProducerPaused("mic", !next)
    setMicEnabled(next)
  }, [micEnabled, setProducerPaused])

  const toggleCamera = React.useCallback(async () => {
    const next = !cameraEnabled
    await setProducerPaused("camera", !next)
    setCameraEnabled(next)
  }, [cameraEnabled, setProducerPaused])

  const toggleRaiseHand = React.useCallback(async () => {
    if (!conversationId) return
    const next = !handRaised
    await emitWithAck(next ? "call:raiseHand" : "call:lowerHand", { conversationId })
    setHandRaised(next)
  }, [conversationId, handRaised])

  /** Admin/moderator only - the server independently enforces this (see call.rs), this is just UI convenience. */
  const startRecording = React.useCallback(async () => {
    if (!conversationId) return
    await emitWithAck("call:startRecording", { conversationId })
  }, [conversationId])

  const stopRecording = React.useCallback(async () => {
    if (!conversationId) return
    await emitWithAck("call:stopRecording", { conversationId })
  }, [conversationId])

  const join = React.useCallback(async () => {
    if (!conversationId || joined) return
    setError(null)
    try {
      const socket = await getSocket()

      const { rtpCapabilities, otherProducers, recording, recordingStartedByUsername } = await emitWithAck<{
        rtpCapabilities: RtpCapabilities
        otherProducers: Array<{
          socketId: string
          userId: string
          username: string
          producerId: string
          kind: string
          appData: Record<string, unknown>
          paused: boolean
        }>
        recording: boolean
        recordingStartedByUsername: string | null
      }>("call:join", { conversationId })
      setIsRecording(recording)
      setRecordingStartedBy(recording ? recordingStartedByUsername : null)

      const device = new Device()
      await device.load({ routerRtpCapabilities: rtpCapabilities })
      deviceRef.current = device

      const { transport: sendInfo } = await emitWithAck<{ transport: TransportInfo }>(
        "call:createTransport",
        { conversationId }
      )
      const sendTransport = device.createSendTransport(sendInfo as never)
      sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        emitWithAck("call:connectTransport", { conversationId, transportId: sendTransport.id, dtlsParameters })
          .then(() => callback())
          .catch(errback)
      })
      sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
        emitWithAck<{ producerId: string }>("call:produce", {
          conversationId,
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          appData,
        })
          .then(({ producerId }) => callback({ id: producerId }))
          .catch(errback)
      })
      sendTransportRef.current = sendTransport

      const { transport: recvInfo } = await emitWithAck<{ transport: TransportInfo }>(
        "call:createTransport",
        { conversationId }
      )
      const recvTransport = device.createRecvTransport(recvInfo as never)
      recvTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
        emitWithAck("call:connectTransport", { conversationId, transportId: recvTransport.id, dtlsParameters })
          .then(() => callback())
          .catch(errback)
      })
      recvTransportRef.current = recvTransport

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      setLocalStream(stream)
      setMicEnabled(true)
      setCameraEnabled(true)
      const audioTrack = stream.getAudioTracks()[0]
      const videoTrack = stream.getVideoTracks()[0]
      if (audioTrack) await produceTrack(audioTrack, { source: "mic" })
      if (videoTrack) await produceTrack(videoTrack, { source: "camera" })

      socket.on("call:newProducer", consumeProducer)
      socket.on("call:peerLeft", ({ socketId }: { socketId: string }) => {
        setParticipants((prev) => {
          const next = new Map(prev)
          next.delete(socketId)
          return next
        })
      })
      // Our own signaling event (see ws-sfu call.rs) — this app has no
      // built-in mediasoup client-server protocol connection, so a remote
      // mute/camera-off indicator only updates because the server tells us.
      socket.on(
        "call:producerStateChanged",
        ({ socketId, kind, appData, paused }: { socketId: string; kind: string; appData: { source?: string }; paused: boolean }) => {
          if (kind === "audio") updateParticipant(socketId, { audioMuted: paused })
          else if (appData.source !== "screen") updateParticipant(socketId, { videoMuted: paused })
        }
      )
      socket.on(
        "call:handStateChanged",
        ({ socketId, raised }: { socketId: string; raised: boolean }) => {
          updateParticipant(socketId, { handRaised: raised })
        }
      )
      socket.on(
        "call:recordingStateChanged",
        ({ recording, startedByUsername }: { recording: boolean; startedByUsername?: string }) => {
          setIsRecording(recording)
          setRecordingStartedBy(recording ? (startedByUsername ?? null) : null)
        }
      )

      for (const producerInfo of otherProducers) {
        await consumeProducer(producerInfo)
      }

      setJoined(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join the call")
    }
  }, [conversationId, joined, consumeProducer, produceTrack])

  const leave = React.useCallback(async () => {
    if (!conversationId) return
    const socket = await getSocket().catch(() => null)
    socket?.off("call:newProducer", consumeProducer)
    socket?.emit("call:leave", { conversationId })

    for (const producer of producersRef.current.values()) producer.close()
    producersRef.current.clear()
    sourceProducersRef.current.clear()
    for (const consumer of consumersRef.current.values()) consumer.close()
    consumersRef.current.clear()
    sendTransportRef.current?.close()
    recvTransportRef.current?.close()
    sendTransportRef.current = null
    recvTransportRef.current = null
    deviceRef.current = null

    localStream?.getTracks().forEach((track) => track.stop())
    screenStream?.getTracks().forEach((track) => track.stop())
    setLocalStream(null)
    setScreenStream(null)
    setParticipants(new Map())
    setJoined(false)
    setHandRaised(false)
    setIsRecording(false)
    setRecordingStartedBy(null)
  }, [conversationId, consumeProducer, localStream, screenStream])

  const startScreenShare = React.useCallback(async () => {
    if (!joined) return
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    setScreenStream(stream)
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const producer = await produceTrack(track, { source: "screen" })
    track.addEventListener("ended", () => {
      producer.close()
      producersRef.current.delete(producer.id)
      setScreenStream(null)
    })
  }, [joined, produceTrack])

  const stopScreenShare = React.useCallback(() => {
    screenStream?.getTracks().forEach((track) => track.stop())
    setScreenStream(null)
  }, [screenStream])

  React.useEffect(() => {
    return () => {
      void leave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run cleanup on unmount, not on every leave identity change
  }, [])

  const participantList = React.useMemo(() => Array.from(participants.values()), [participants])

  return {
    joined,
    error,
    localStream,
    screenStream,
    participants: participantList,
    micEnabled,
    cameraEnabled,
    handRaised,
    isRecording,
    recordingStartedBy,
    join,
    leave,
    toggleMic,
    toggleCamera,
    toggleRaiseHand,
    startRecording,
    stopRecording,
    startScreenShare,
    stopScreenShare,
  }
}
