import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { FollowRequestsCard } from "@/components/follow-requests-card"
import * as followLib from "@/lib/follow"
import type { PendingFollowRequest } from "@/lib/follow"

vi.mock("@/lib/follow", async () => {
  const actual = await vi.importActual<typeof import("@/lib/follow")>("@/lib/follow")
  return { ...actual, getPendingFollowRequests: vi.fn(), acceptFollowRequest: vi.fn(), rejectFollowRequest: vi.fn() }
})

function makeRequest(overrides: Partial<PendingFollowRequest> = {}): PendingFollowRequest {
  return {
    id: "req-1",
    username: "bob",
    displayName: "Bob",
    avatarUrl: null,
    verified: false,
    ...overrides,
  }
}

function renderCard() {
  return render(
    <MemoryRouter>
      <FollowRequestsCard />
    </MemoryRouter>
  )
}

describe("FollowRequestsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders nothing once loaded with zero pending requests", async () => {
    vi.mocked(followLib.getPendingFollowRequests).mockResolvedValue([])
    const { container } = renderCard()

    await waitFor(() => expect(container).not.toHaveTextContent("Loading"))
    expect(container).toBeEmptyDOMElement()
  })

  it("lists a pending request once loaded", async () => {
    vi.mocked(followLib.getPendingFollowRequests).mockResolvedValue([makeRequest()])
    renderCard()

    expect(await screen.findByText("Bob")).toBeInTheDocument()
    expect(screen.getByText("@bob")).toBeInTheDocument()
  })

  it("accepting a request calls acceptFollowRequest and removes it from the list", async () => {
    vi.mocked(followLib.getPendingFollowRequests).mockResolvedValue([makeRequest()])
    vi.mocked(followLib.acceptFollowRequest).mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("Bob")
    await user.click(screen.getByRole("button", { name: /accept @bob/i }))

    await waitFor(() => expect(followLib.acceptFollowRequest).toHaveBeenCalledWith("bob"))
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument())
  })

  it("rejecting a request calls rejectFollowRequest and removes it from the list", async () => {
    vi.mocked(followLib.getPendingFollowRequests).mockResolvedValue([makeRequest()])
    vi.mocked(followLib.rejectFollowRequest).mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("Bob")
    await user.click(screen.getByRole("button", { name: /reject @bob/i }))

    await waitFor(() => expect(followLib.rejectFollowRequest).toHaveBeenCalledWith("bob"))
    await waitFor(() => expect(screen.queryByText("Bob")).not.toBeInTheDocument())
  })

  it("shows an error and keeps the request listed if accepting fails", async () => {
    vi.mocked(followLib.getPendingFollowRequests).mockResolvedValue([makeRequest()])
    vi.mocked(followLib.acceptFollowRequest).mockRejectedValue(new Error("network error"))
    const user = userEvent.setup()
    renderCard()

    await screen.findByText("Bob")
    await user.click(screen.getByRole("button", { name: /accept @bob/i }))

    expect(await screen.findByText(/unable to accept/i)).toBeInTheDocument()
    expect(screen.getByText("Bob")).toBeInTheDocument()
  })
})
