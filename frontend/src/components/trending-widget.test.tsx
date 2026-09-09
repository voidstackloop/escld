import { render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { TrendingWidget } from "@/components/trending-widget"
import * as analyticsLib from "@/lib/analytics"
import * as postLib from "@/lib/post"

vi.mock("@/lib/analytics")
vi.mock("@/lib/post", async () => {
  const actual = await vi.importActual<typeof import("@/lib/post")>("@/lib/post")
  return { ...actual, getPost: vi.fn() }
})

describe("TrendingWidget", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders nothing when the analytics service is unreachable", async () => {
    vi.mocked(analyticsLib.getTrendingPosts).mockRejectedValue(new Error("network error"))
    vi.mocked(analyticsLib.getTrendingHashtags).mockRejectedValue(new Error("network error"))

    const { container } = render(
      <MemoryRouter>
        <TrendingWidget />
      </MemoryRouter>
    )

    await waitFor(() => expect(container).not.toHaveTextContent("Loading"))
    expect(container).toBeEmptyDOMElement()
  })

  it("renders hashtags and hydrated posts once loaded", async () => {
    vi.mocked(analyticsLib.getTrendingPosts).mockResolvedValue([{ postId: "post-1", score: 9 }])
    vi.mocked(analyticsLib.getTrendingHashtags).mockResolvedValue([{ tag: "trending", score: 3 }])
    vi.mocked(postLib.getPost).mockResolvedValue({
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
      tags: ["trending"],
      commentCount: 1,
      likeCount: 1,
      likedByViewer: false,
      trending: false,
      liveStatus: null,
      liveStartedAt: null,
      liveEndedAt: null,
      peakViewerCount: null,
      createdAt: new Date().toISOString(),
    })

    render(
      <MemoryRouter>
        <TrendingWidget />
      </MemoryRouter>
    )

    expect(await screen.findByText("#trending")).toBeInTheDocument()
    expect(await screen.findByText("@alice")).toBeInTheDocument()
  })
})
