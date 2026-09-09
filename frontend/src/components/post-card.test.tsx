import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { PostCard } from "@/components/post-card"
import * as liveLib from "@/lib/live"
import * as postLib from "@/lib/post"
import type { Post } from "@/lib/post"

vi.mock("@/lib/post", async () => {
  const actual = await vi.importActual<typeof import("@/lib/post")>("@/lib/post")
  return { ...actual, likePost: vi.fn(), unlikePost: vi.fn(), hidePost: vi.fn(), getPostInsights: vi.fn() }
})

vi.mock("@/lib/live", async () => {
  const actual = await vi.importActual<typeof import("@/lib/live")>("@/lib/live")
  return { ...actual, sendLiveViewerHeartbeat: vi.fn() }
})

function makePost(overrides: Partial<Post> = {}): Post {
  return {
    id: "post-1",
    authorId: "author-1",
    authorUsername: "alice",
    authorDisplayName: "Alice",
    authorAvatarUrl: null,
    text: "hello world",
    description: null,
    mediaType: null,
    mediaUrl: null,
    mediaStatus: "NONE",
    tags: [],
    commentCount: 0,
    likeCount: 3,
    likedByViewer: false,
    trending: false,
    liveStatus: null,
    liveStartedAt: null,
    liveEndedAt: null,
    peakViewerCount: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function renderPostCard(post: Post, onHidden?: () => void, showInsights?: boolean) {
  return render(
    <MemoryRouter>
      <PostCard post={post} onHidden={onHidden} showInsights={showInsights} />
    </MemoryRouter>
  )
}

describe("PostCard trending badge", () => {
  it("shows a Trending badge when the post is flagged as trending", () => {
    renderPostCard(makePost({ trending: true }))

    expect(screen.getByTitle("Trending now")).toBeInTheDocument()
  })

  it("shows no badge when the post is not flagged as trending", () => {
    renderPostCard(makePost({ trending: false }))

    expect(screen.queryByTitle("Trending now")).not.toBeInTheDocument()
  })
})

describe("PostCard like button", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("optimistically increments the count and shows the liked state immediately", async () => {
    vi.mocked(postLib.likePost).mockResolvedValue({ liked: true, likeCount: 4 })
    const user = userEvent.setup()
    renderPostCard(makePost())

    const likeButton = screen.getByRole("button", { name: /3/ })
    await user.click(likeButton)

    // Optimistic update happens synchronously, before the mocked promise resolves.
    expect(screen.getByRole("button", { name: /4/ })).toHaveAttribute("aria-pressed", "true")

    await waitFor(() => expect(postLib.likePost).toHaveBeenCalledWith("post-1"))
  })

  it("rolls back the optimistic update if the like request fails", async () => {
    vi.mocked(postLib.likePost).mockRejectedValue(new Error("network error"))
    const user = userEvent.setup()
    renderPostCard(makePost())

    const likeButton = screen.getByRole("button", { name: /3/ })
    await user.click(likeButton)

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /3/ })).toHaveAttribute("aria-pressed", "false")
    )
  })

  it("ignores a second click while the first request is still in flight", async () => {
    let resolveLike: (value: { liked: boolean; likeCount: number }) => void = () => {}
    vi.mocked(postLib.likePost).mockReturnValue(
      new Promise((resolve) => {
        resolveLike = resolve
      })
    )
    const user = userEvent.setup()
    renderPostCard(makePost())

    const likeButton = screen.getByRole("button", { name: /3/ })
    await user.click(likeButton)
    await user.click(screen.getByRole("button", { name: /4/ }))

    resolveLike({ liked: true, likeCount: 4 })
    await waitFor(() => expect(postLib.likePost).toHaveBeenCalledTimes(1))
  })

  it("calls unlikePost when an already-liked post is toggled off", async () => {
    vi.mocked(postLib.unlikePost).mockResolvedValue({ liked: false, likeCount: 2 })
    const user = userEvent.setup()
    renderPostCard(makePost({ likedByViewer: true, likeCount: 3 }))

    await user.click(screen.getByRole("button", { name: /3/ }))

    await waitFor(() => expect(postLib.unlikePost).toHaveBeenCalledWith("post-1"))
    expect(postLib.likePost).not.toHaveBeenCalled()
  })
})

describe("PostCard hide (not interested)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("calls hidePost and notifies the parent once it succeeds", async () => {
    vi.mocked(postLib.hidePost).mockResolvedValue(undefined)
    const onHidden = vi.fn()
    const user = userEvent.setup()
    renderPostCard(makePost(), onHidden)

    await user.click(screen.getByTitle("Not interested"))

    await waitFor(() => expect(postLib.hidePost).toHaveBeenCalledWith("post-1"))
    expect(onHidden).toHaveBeenCalledTimes(1)
  })

  it("does not notify the parent when the hide request fails", async () => {
    vi.mocked(postLib.hidePost).mockRejectedValue(new Error("network error"))
    const onHidden = vi.fn()
    const user = userEvent.setup()
    renderPostCard(makePost(), onHidden)

    await user.click(screen.getByTitle("Not interested"))

    await waitFor(() => expect(postLib.hidePost).toHaveBeenCalledWith("post-1"))
    expect(onHidden).not.toHaveBeenCalled()
  })
})

describe("PostCard insights", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("shows no insights toggle unless showInsights is passed", () => {
    renderPostCard(makePost())

    expect(screen.queryByTitle("View insights")).not.toBeInTheDocument()
  })

  it("fetches and renders insights once expanded", async () => {
    vi.mocked(postLib.getPostInsights).mockResolvedValue({
      postId: "post-1",
      likeCount: 3,
      commentCount: 1,
      trendingScore: 5.5,
      trending: true,
      liveStatus: null,
      liveStartedAt: null,
      liveEndedAt: null,
      durationSeconds: null,
      peakViewerCount: null,
      currentViewerCount: null,
    })
    const user = userEvent.setup()
    renderPostCard(makePost(), undefined, true)

    await user.click(screen.getByTitle("View insights"))

    await waitFor(() => expect(postLib.getPostInsights).toHaveBeenCalledWith("post-1"))
    expect(await screen.findByText("5.5")).toBeInTheDocument()
  })
})

describe("PostCard live viewer count", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("pings a heartbeat and shows the returned count while a live video is playing", async () => {
    vi.mocked(liveLib.sendLiveViewerHeartbeat).mockResolvedValue({ viewerCount: 7 })

    renderPostCard(
      makePost({
        mediaType: "LIVE",
        mediaUrl: "https://cdn.example.com/live/key/live.m3u8",
        mediaStatus: "READY",
        liveStatus: "LIVE",
      })
    )

    await waitFor(() => expect(liveLib.sendLiveViewerHeartbeat).toHaveBeenCalledWith("post-1"))
    expect(await screen.findByText("7")).toBeInTheDocument()
  })

  it("does not ping a heartbeat once the stream has ended", () => {
    renderPostCard(
      makePost({
        mediaType: "LIVE",
        mediaUrl: "https://cdn.example.com/live/key/live.m3u8",
        mediaStatus: "READY",
        liveStatus: "ENDED",
      })
    )

    expect(liveLib.sendLiveViewerHeartbeat).not.toHaveBeenCalled()
  })

  it("shows peak viewer count and duration once a stream has ended", () => {
    renderPostCard(
      makePost({
        mediaType: "LIVE",
        liveStatus: "ENDED",
        peakViewerCount: 12,
        liveStartedAt: "2026-01-01T00:00:00.000Z",
        liveEndedAt: "2026-01-01T01:05:00.000Z",
      })
    )

    expect(screen.getByText("12 peak viewers · 1h 5m")).toBeInTheDocument()
  })
})
